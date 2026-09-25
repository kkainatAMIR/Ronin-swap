// Frontend client for the reward accounting layer.
// All numbers come back as JS Numbers — never trust a frontend-controlled
// earned_points / claimed_points / reward_amount value.

export async function getRewardBalance(wallet) {
  if (!wallet) throw new Error('A wallet address is required.')
  const response = await fetch(`/api/rewards/balance?wallet=${encodeURIComponent(wallet)}`, { cache: 'no-store' })
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
//   Step 2: user signs + submits via Phantom (handled in RewardClaimPanel)
//   Step 3: confirmRewardClaim(claimId, signature)
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
export async function prepareRewardClaim(wallet, { pointsToClaim = null, claimId: claimIdOverride = null } = {}) {
  if (!wallet) throw new Error('A wallet address is required.')
  const claimId = claimIdOverride || newClaimId()
  const response = await fetch('/api/rewards/claim-prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet, claimId, pointsToClaim }),
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

// Step 3: confirm a user-submitted claim transaction.
//
// Called AFTER the user has signed the partially-signed tx (returned by
// prepareRewardClaim) in Phantom AND submitted it to Solana.
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
// Production is Mainnet-only. Per the mainnet migration spec:
//   - Use https://explorer.solana.com/tx/<SIGNATURE>
//   - Do NOT append ?cluster=devnet
//
// The `network` parameter is accepted for backward compatibility with
// RewardClaimPanel.jsx (which passes balance.network), but it is ignored —
// all reward claim transactions are on Mainnet.
export function solanaTxExplorerUrl(signature, _network) {
  if (!signature) return null
  return `https://explorer.solana.com/tx/${signature}`
}
