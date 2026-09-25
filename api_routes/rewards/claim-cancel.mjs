// =====================================================================
// POST /api/rewards/claim-cancel
// =====================================================================
// USER-PAYS-FEE FLOW — cancel path
//
// Body: { claimId, reason? }
//
// Called by the frontend when:
//   - The user rejects the Phantom signature popup
//   - The user closes the Phantom popup
//   - The user navigates away from the claim flow
//
// Reverts the claim by calling revert_failed_reward_claim RPC, which
// atomically:
//   - Sets reward_claims.status = FAILED (if currently ENTITLED or
//     PENDING_PAYOUT)
//   - Decrements wallets.claimed_points by the exact points_claimed
//     amount (restoring the user's claimable_points)
//
// Idempotent: if the claim is already FAILED or CANCELLED, returns
// success without modifying any state. If the claim is already
// COMPLETED, returns an error (admin must use a separate path).
// =====================================================================

import { apiError, json, parseBody, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import { isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'

function isValidClaimId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value)
}

function safeParse(s) { try { return JSON.parse(s) } catch { return {} } }

const cancelRuntimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

async function callSupabaseRpc(name, params) {
  const response = await fetch(`${cancelRuntimeEnv.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: cancelRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${cancelRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!response.ok) {
    const code = body?.message ? String(body.message).split('\n')[0].replace(/^ERROR:\s*/, '')
      : body?.error ? String(body.error).split('\n')[0].replace(/^ERROR:\s*/, '')
      : 'RPC_FAILED'
    const err = new Error(code)
    err.code = code
    err.body = body
    err.status = response.status
    throw err
  }
  return Array.isArray(body) ? body[0] : body
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!(await rateLimitPersistent(req, 'rewards_claim_cancel', 20))) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many cancel requests. Try again shortly.')
  }
  if (!isSupabaseConfigured()) {
    return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Rewards are not configured on the server.')
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})
  const claimId = String(body?.claimId || body?.claim_id || '').trim()
  const reason = String(body?.reason || 'USER_CANCELLED').slice(0, 500)

  if (!isValidClaimId(claimId)) {
    return apiError(res, 400, 'INVALID_CLAIM_ID', 'A valid claimId (8-200 chars, A-Z a-z 0-9 _ -) is required.')
  }

  try {
    const result = await callSupabaseRpc('revert_failed_reward_claim', {
      p_claim_id: claimId,
      p_failure_reason: reason,
    })

    // The RPC returns:
    //   { reverted: true, reason: 'PENDING_PAYOUT_TO_FAILED', claim, ... }  on first cancel
    //   { reverted: false, reason: 'ALREADY_FAILED', claim, ... }           on idempotent retry
    // If the claim is COMPLETED, the RPC raises 'CANNOT_REVERT_COMPLETED'.

    if (result?.reverted === false && result?.reason === 'ALREADY_FAILED') {
      return json(res, 200, {
        success: true,
        idempotent: true,
        claim_id: claimId,
        message: 'This claim was already cancelled. Your points have been restored.',
      })
    }

    return json(res, 200, {
      success: true,
      reverted: Boolean(result?.reverted),
      claim_id: claimId,
      claim: result?.claim || null,
      points_restored: Number(result?.claim?.points_claimed || 0),
      message: 'Claim cancelled. Your points have been restored and can be claimed again.',
    })
  } catch (error) {
    // CANNOT_REVERT_COMPLETED means the payout actually went through
    // before the user cancelled. Surface a clear message.
    const code = error?.code || error?.message || 'CANCEL_FAILED'
    if (code.includes('CANNOT_REVERT_COMPLETED')) {
      return json(res, 200, {
        success: false,
        already_completed: true,
        claim_id: claimId,
        message: 'This claim cannot be cancelled — the on-chain payout already completed. Check your wallet for the SOL.',
      })
    }
    console.error('claim-cancel RPC failed:', error?.message || error, { claimId })
    return apiError(res, 502, code, `The claim could not be cancelled: ${error?.message || error}`)
  }
}
