import { apiError, json, rateLimit } from '../_lib/roninBackend.mjs'
import { isSupabaseConfigured } from '../_lib/supabaseBackend.mjs'

function isValidWallet(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) || /^0x[a-fA-F0-9]{40}$/.test(trimmed)
}

// claim_id must be 8-200 chars of [A-Za-z0-9_-]. The frontend should
// generate a fresh random one per claim attempt (a UUID works well).
function isValidClaimId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value)
}

// POST /api/rewards/claim
// Body: { wallet, claimId, pointsToClaim? }
//
// Thin service-role wrapper around the public.claim_reward() Postgres RPC.
// The RPC is the trusted authority:
//   - derives earned_points from samurai_points (never trusts frontend)
//   - computes claimable_points = earned_points - claimed_points
//   - validates pointsToClaim <= claimable_points
//   - atomic insert + claimed_points increment in one transaction
//   - idempotent on duplicate claim_id (ON CONFLICT DO NOTHING + early return)
//   - concurrency-safe (SELECT FOR UPDATE on the wallet row)
//
// The frontend must NOT send earned_points, claimable_points, or
// reward_amount — all of those are derived server-side.
export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'rewards_claim', 10)) return apiError(res, 429, 'RATE_LIMITED', 'Too many claim attempts. Try again shortly.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Rewards are not configured on the server.')

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})
  const wallet = String(body?.wallet || '').trim()
  const claimId = String(body?.claimId || body?.claim_id || '').trim()
  const pointsToClaimRaw = body?.pointsToClaim ?? body?.points_to_claim
  const pointsToClaim = pointsToClaimRaw == null ? null : Number(pointsToClaimRaw)

  if (!isValidWallet(wallet)) return apiError(res, 400, 'INVALID_WALLET', 'A valid wallet address is required.')
  if (!isValidClaimId(claimId)) return apiError(res, 400, 'INVALID_CLAIM_ID', 'A valid claimId (8-200 chars, A-Z a-z 0-9 _ -) is required.')
  if (pointsToClaim != null && (!Number.isFinite(pointsToClaim) || pointsToClaim <= 0)) {
    return apiError(res, 400, 'INVALID_POINTS', 'pointsToClaim must be a positive number, or null/omitted to claim all available.')
  }

  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/claim_reward`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        p_wallet_address: wallet,
        p_claim_id: claimId,
        p_points_to_claim: pointsToClaim,
        p_client_nonce: null,
        p_metadata: null,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    const text = await response.text()
    let rpcBody
    try { rpcBody = text ? JSON.parse(text) : null } catch { rpcBody = { raw: text } }

    if (!response.ok) {
      // The RPC raises exceptions like INSUFFICIENT_CLAIMABLE_POINTS,
      // REWARDS_DISABLED, NO_ACTIVE_SEASON, WALLET_NOT_FOUND,
      // CLAIM_ID_CONFLICT, etc. Surface them to the frontend in a
      // structured form.
      const code = extractRpcCode(rpcBody) || 'CLAIM_FAILED'
      const message = humanizeErrorCode(code)
      console.warn('rewards/claim RPC rejected:', { code, message, wallet: wallet.slice(0, 8) + '...', claimId })
      return apiError(res, 400, code, message)
    }

    const result = Array.isArray(rpcBody) ? rpcBody[0] : rpcBody
    if (!result || !result.success) {
      return apiError(res, 502, 'CLAIM_FAILED', 'The reward claim did not return a result.')
    }

    // Numeric normalization
    const claim = result.claim || null
    return json(res, 200, {
      success: true,
      idempotent: Boolean(result.idempotent),
      claim: claim ? {
        ...claim,
        points_claimed: Number(claim.points_claimed || 0),
        reward_amount: Number(claim.reward_amount || 0),
        conversion_rate: Number(claim.conversion_rate || 0),
      } : null,
      earned_points: Number(result.earned_points || 0),
      claimed_points: Number(result.claimed_points || 0),
      claimable_points: Number(result.claimable_points || 0),
    })
  } catch (error) {
    console.error('rewards/claim API failed:', error?.message || error)
    return apiError(res, 502, 'CLAIM_FAILED', 'Unable to process the reward claim.')
  }
}

function safeParse(s) { try { return JSON.parse(s) } catch { return {} } }

// Supabase wraps Postgres raise_exception output like:
//   { code: "P0001", message: "INSUFFICIENT_CLAIMABLE_POINTS", details: "" }
// or sometimes the message string itself contains the code.
function extractRpcCode(body) {
  if (!body) return null
  if (typeof body === 'string') return body.split('\n')[0].replace(/^ERROR:\s*/, '')
  if (body.message) return String(body.message).split('\n')[0].replace(/^ERROR:\s*/, '')
  if (body.error) return String(body.error).split('\n')[0].replace(/^ERROR:\s*/, '')
  return null
}

function humanizeErrorCode(code) {
  const map = {
    WALLET_REQUIRED: 'A wallet address is required.',
    WALLET_NOT_FOUND: 'This wallet has not earned any points yet.',
    WALLET_EXCLUDED: 'This wallet is excluded from rewards.',
    INVALID_CLAIM_ID: 'The claim ID is invalid.',
    INVALID_POINTS_AMOUNT: 'The points amount is invalid.',
    CLAIM_ID_CONFLICT: 'This claim ID is already in use by another wallet.',
    REWARDS_DISABLED: 'Rewards are currently disabled. Try again later.',
    NO_ACTIVE_SEASON: 'There is no active reward season right now.',
    NO_CLAIMABLE_POINTS: 'You have no claimable points right now.',
    INSUFFICIENT_CLAIMABLE_POINTS: 'You cannot claim more points than you have earned.',
    INVALID_CONVERSION_RATE: 'The reward conversion rate is misconfigured. Contact admin.',
  }
  return map[code] || 'The reward claim was rejected.'
}
