// =====================================================================
// POST /api/rewards/claim-cancel
// =====================================================================
// USER-PAYS-FEE FLOW — cancel path
//
// Body: { claimId, reason? }
//
// Called by the frontend before submission, such as when the user rejects
// the Phantom signature popup or explicitly cancels an unsigned claim.
//
// Reverts a claim only while it is unsigned and still ENTITLED. The DB
// RPC serializes cancellation against submission-signature persistence:
//   - Sets reward_claims.status = FAILED
//   - Decrements wallets.claimed_points by the exact points_claimed
//     amount (restoring the user's claimable_points)
// A signed or already-processing claim is outcome-uncertain and cannot be
// cancelled or have its points restored through this endpoint.
//
// Idempotent for an already-FAILED unsigned claim. PENDING_PAYOUT and
// COMPLETED claims are not manually cancellable.
// =====================================================================

import { apiError, json, parseBody, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import { isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'
import { rewardViewerWalletMatches } from '../../api/_lib/rewardViewerAuth.mjs'

function isValidClaimId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value)
}

function safeParse(s) { try { return JSON.parse(s) } catch { return {} } }

const cancelRuntimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

async function fetchClaimWallet(claimId) {
  const response = await fetch(
    `${cancelRuntimeEnv.SUPABASE_URL}/rest/v1/reward_claims?claim_id=eq.${encodeURIComponent(claimId)}&select=wallet_address&limit=1`,
    {
      headers: {
        apikey: cancelRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${cancelRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok) throw new Error('CLAIM_LOOKUP_FAILED')
  const rows = await response.json()
  return rows?.[0]?.wallet_address || null
}

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
    const claimWallet = await fetchClaimWallet(claimId)
    if (!claimWallet) return apiError(res, 404, 'CLAIM_NOT_FOUND', 'No reward claim was found for that claimId.')
    if (!rewardViewerWalletMatches(req, claimWallet)) {
      return apiError(res, 401, 'REWARD_VIEWER_AUTH_REQUIRED', 'Verify ownership of the claimant wallet before cancelling this claim.')
    }

    const result = await callSupabaseRpc('cancel_unsubmitted_reward_claim', {
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
        message: result?.claim?.season_reward_allocation_id
          ? 'This season reward claim was already cancelled. The finalized allocation remains available to claim again during its claim window.'
          : 'This claim was already cancelled. Your points have been restored.',
      })
    }

    const isSeasonReward = Boolean(result?.claim?.season_reward_allocation_id)
    return json(res, 200, {
      success: true,
      reverted: Boolean(result?.reverted),
      claim_id: claimId,
      claim: result?.claim || null,
      points_restored: isSeasonReward ? 0 : Number(result?.claim?.points_claimed || 0),
      message: isSeasonReward
        ? 'Season reward claim cancelled. The finalized allocation remains available during its claim window.'
        : 'Claim cancelled. Your points have been restored and can be claimed again.',
    })
  } catch (error) {
    const code = error?.code || error?.message || 'CANCEL_FAILED'
    if (code.includes('CLAIM_OUTCOME_UNCERTAIN')) {
      return apiError(res, 409, 'CLAIM_OUTCOME_UNCERTAIN',
        'This claim is signed or already in payout processing and cannot be cancelled automatically. Retry confirmation for its saved signature or contact support.')
    }

    // CANNOT_REVERT_COMPLETED means the payout actually went through
    // before the user cancelled. Surface a clear message.
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
