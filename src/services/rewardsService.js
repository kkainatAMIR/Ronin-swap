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
// uniqueness, so duplicates resolve to an idempotent response (no double-spend).
function newClaimId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return 'claim-' + crypto.randomUUID()
  }
  // Fallback for very old browsers
  return 'claim-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// Claim all available points (pointsToClaim === null means "claim all").
// Returns { success, idempotent, claim, earned_points, claimed_points, claimable_points }.
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
  // SOL has 9 decimals but display 6 for readability on small amounts.
  const display = n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: 4 })
    : n.toLocaleString('en-US', { maximumFractionDigits: 6 })
  return `${display} ${asset}`
}
