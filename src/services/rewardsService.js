// Frontend client for the reward accounting layer.
// All numbers come back as JS Numbers — never trust a frontend-controlled
// earned_points / claimed_points / reward_amount value.

const rewardViewerAuthRequests = new Map()

async function signRewardViewerMessage(wallet, message) {
  if (/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    const injected = window.ethereum
    const providers = Array.isArray(injected?.providers) ? injected.providers : [injected]
    for (const provider of providers) {
      if (!provider?.request) continue
      const accounts = await provider.request({ method: 'eth_accounts' }).catch(() => [])
      if (!Array.isArray(accounts) || !accounts.some((account) => account.toLowerCase() === wallet.toLowerCase())) continue
      const messageHex = `0x${Array.from(new TextEncoder().encode(message), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
      return provider.request({ method: 'personal_sign', params: [messageHex, wallet] })
    }
    throw new Error('Connect the EVM wallet whose reward details you want to view.')
  }

  const provider = window.phantom?.solana || window.solana
  const providerWallet = provider?.publicKey?.toString?.()
  if (!provider?.signMessage || providerWallet !== wallet) {
    throw new Error('Connect the Solana wallet whose reward details you want to view.')
  }
  const signed = await provider.signMessage(new TextEncoder().encode(message), 'utf8')
  const signature = signed?.signature || signed
  if (!(signature instanceof Uint8Array)) throw new Error('The wallet did not return a valid signature.')
  return btoa(Array.from(signature, (byte) => String.fromCharCode(byte)).join(''))
}

async function authenticateRewardViewerRequest(wallet) {
  const authUrl = `/api/rewards/auth?wallet=${encodeURIComponent(wallet)}`
  const sessionResponse = await fetch(authUrl, { cache: 'no-store', credentials: 'same-origin' })
  if (sessionResponse.ok) return
  if (sessionResponse.status !== 401) {
    const sessionError = await sessionResponse.json().catch(() => ({}))
    throw new Error(sessionError?.error || 'Unable to verify reward access.')
  }

  const challengeResponse = await fetch('/api/rewards/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ action: 'challenge', wallet }),
  })
  const challenge = await challengeResponse.json().catch(() => ({}))
  if (!challengeResponse.ok) throw new Error(challenge?.error || 'Unable to start wallet verification.')

  const signature = await signRewardViewerMessage(wallet, challenge.message)
  const verifyResponse = await fetch('/api/rewards/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ action: 'verify', wallet, nonce: challenge.nonce, signature }),
  })
  const result = await verifyResponse.json().catch(() => ({}))
  if (!verifyResponse.ok) throw new Error(result?.error || 'Wallet ownership could not be verified.')
}

function authenticateRewardViewer(wallet) {
  const existing = rewardViewerAuthRequests.get(wallet)
  if (existing) return existing

  const request = authenticateRewardViewerRequest(wallet).finally(() => {
    rewardViewerAuthRequests.delete(wallet)
  })
  rewardViewerAuthRequests.set(wallet, request)
  return request
}

export async function getRewardBalance(wallet) {
  if (!wallet) throw new Error('A wallet address is required.')
  await authenticateRewardViewer(wallet)
  const response = await fetch(`/api/rewards/balance?wallet=${encodeURIComponent(wallet)}`, { cache: 'no-store', credentials: 'same-origin' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || 'Unable to load reward balance.')
  return body
}

// Generate a fresh, unguessable claim_id client-side. The DB enforces
// uniqueness (and the on-chain claim PDA is derived from the claim_id
// via SHA-256), so duplicates resolve to an idempotent response (no
// double-spend, no double-payout).
function newClaimId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'claim-' + crypto.randomUUID()
  }
  return 'claim-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// Claim all available points (pointsToClaim === null means "claim all").
//
// The backend /api/rewards/claim endpoint performs the full flow:
//   1. Supabase claim_reward RPC (atomic insert + claimed_points increment)
//   2. Status transition ENTITLED → PENDING_PAYOUT (atomic)
//   3. Solana claim_reward() transaction signed by backend admin
//   4. On success: status → COMPLETED, claim_tx_signature saved
//   5. On failure: status → FAILED, claimed_points reverted
//
// The frontend NEVER sends earned_points / claimed_points /
// claimable_points / reward_amount. Those values are derived server-side.
//
// Returns {
//   success, idempotent?, claim, claim_tx_signature?,
//   earned_points, claimed_points, claimable_points,
//   already_completed?, pending_payout?, previously_failed?,
//   payout_succeeded?, db_status_update_pending?,
//   message?  // human-readable note for unusual states
// }
export async function claimReward(wallet, { pointsToClaim = null } = {}) {
  if (!wallet) throw new Error('A wallet address is required.')
  const claimId = newClaimId()
  const response = await fetch('/api/rewards/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet, claimId, pointsToClaim }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(body?.error || 'The reward claim was rejected.')
    err.code = body?.code || 'CLAIM_FAILED'
    throw err
  }
  return body
}

// =====================================================================
// USER-PAYS-FEE FLOW
// =====================================================================
// Three-step flow that lets the USER pay the Solana transaction fee
// (instead of the admin wallet). The user must have at least
// ~0.000005 SOL for gas.
//
//   Step 1: prepareRewardClaim(wallet, { pointsToClaim? })
//           → backend creates ENTITLED row + returns partially-signed tx
//   Step 2: user signs; persist the exact signature before broadcasting
//   Step 3: submit via Phantom, then confirmRewardClaim(claimId, signature)
//           → backend verifies tx landed + marks COMPLETED
//
// If the user rejects the Phantom popup:
//   cancelRewardClaim(claimId)
//   → backend reverts ENTITLED row + restores claimed_points
// =====================================================================

// Step 1: prepare the claim and get a partially-signed transaction.
//
// Returns {
//   success, flow: 'user-pays-fee',
//   claim: { claim_id, points_claimed, reward_amount, ... },
//   partiallySignedTx: <base64 string>,
//   feePayer: <user wallet address>,
//   blockhash, lastValidBlockHeight,
//   rewardAmountLamports, pointsClaimed,
//   programId, network, explorerUrl,
//   earned_points, claimed_points, claimable_points,
//   message
// }
//
// The `partiallySignedTx` should be passed to Phantom's signTransaction().
// Phantom will add the user's signature (as fee payer) and return a
// fully-signed tx that the frontend submits via connection.sendRawTransaction.
export async function prepareRewardClaim(wallet, { pointsToClaim = null, claimId: claimIdOverride = null, seasonId = null } = {}) {
  if (!wallet) throw new Error('A wallet address is required.')
  const claimId = claimIdOverride || newClaimId()
  const response = await fetch('/api/rewards/claim-prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet, claimId, pointsToClaim, ...(seasonId ? { seasonId } : {}) }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(body?.error || 'The reward claim could not be prepared.')
    err.code = body?.code || 'CLAIM_PREPARE_FAILED'
    err.claimId = claimId
    throw err
  }
  return { ...body, claimId }
}

export async function recordRewardClaimSubmission(claimId, signature, wallet) {
  if (!claimId) throw new Error('A claimId is required.')
  if (!signature) throw new Error('A transaction signature is required.')
  const response = await fetch('/api/rewards/claim-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'record-submission', claimId, signature, wallet }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(body?.error || 'The transaction signature could not be recorded.')
    err.code = body?.code || 'SIGNATURE_PERSIST_FAILED'
    throw err
  }
  return body
}

// Step 4: confirm a user-submitted claim transaction.
//
// Called after the exact fee-payer signature has been persisted and the
// signed transaction has been submitted to Solana.
//
// Returns {
//   success,
//   claim_id, signature, explorer_url,
//   claim?: { ... },
//   recipient_balance_before, recipient_balance_after,
//   message,
//   // OR if the tx is not yet confirmed:
//   pending: true,
//   message: 'The transaction has not been confirmed on Solana yet...'
// }
export async function confirmRewardClaim(claimId, signature, wallet) {
  if (!claimId) throw new Error('A claimId is required.')
  if (!signature) throw new Error('A transaction signature is required.')
  const response = await fetch('/api/rewards/claim-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claimId, signature, wallet }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(body?.error || 'The reward claim could not be confirmed.')
    err.code = body?.code || 'CLAIM_CONFIRM_FAILED'
    err.stage = body?.stage || null
    err.diagnostic = body?.diagnostic_error || null
    throw err
  }
  return body
}

// Cancel a claim that the user rejected in Phantom.
//
// Reverts the ENTITLED row and restores the user's claimed_points.
// Idempotent — calling it twice is safe (returns success with
// idempotent: true on the second call).
//
// Returns {
//   success, reverted, idempotent?,
//   claim_id, claim?, points_restored, message
// }
export async function cancelRewardClaim(claimId, reason = 'USER_CANCELLED') {
  if (!claimId) throw new Error('A claimId is required.')
  const response = await fetch('/api/rewards/claim-cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claimId, reason }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(body?.error || 'The reward claim could not be cancelled.')
    err.code = body?.code || 'CLAIM_CANCEL_FAILED'
    throw err
  }
  return body
}

export function formatRewardAmount(amount, asset = 'SOL') {
  if (!Number.isFinite(Number(amount))) return '—'
  const n = Number(amount)
  const display = n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 })
    : n.toLocaleString('en-US', { maximumFractionDigits: 6 })
  return `${display} ${asset}`
}

// Helper for the frontend to build a Solana explorer URL for a tx signature.
//
// Match the rewards RPC network so devnet signatures are not looked up
// on mainnet (or vice versa).
export function solanaTxExplorerUrl(signature, network = 'mainnet-beta') {
  if (!signature) return null
  const cluster = String(network).toLowerCase() === 'devnet' ? '?cluster=devnet' : ''
  return `https://explorer.solana.com/tx/${signature}${cluster}`
}
