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

export function formatRewardAmount(amount, asset = 'SOL') {
  if (!Number.isFinite(Number(amount))) return '—'
  const n = Number(amount)
  const display = n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 })
    : n.toLocaleString('en-US', { maximumFractionDigits: 6 })
  return `${display} ${asset}`
}

// Helper for the frontend to build a Solana explorer URL for a tx signature.
export function solanaTxExplorerUrl(signature) {
  if (!signature) return null
  return `https://solscan.io/tx/${signature}`
}
