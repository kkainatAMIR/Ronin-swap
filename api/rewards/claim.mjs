import { apiError, json, rateLimit } from '../_lib/roninBackend.mjs'
import { isSupabaseConfigured } from '../_lib/supabaseBackend.mjs'
import {
  isRewardsAdminConfigured,
  getRewardsProgramState,
  solToLamports,
  submitClaimRewardTx,
  safeConfirmTx,
  getTxExplorerUrl,
} from '../_lib/solanaRewardsAdmin.mjs'

function isValidSolanaWallet(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)
}

// claim_id must be 8-200 chars of [A-Za-z0-9_-]. The frontend should
// generate a fresh random one per claim attempt (a UUID works well).
function isValidClaimId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value)
}

// POST /api/rewards/claim
// Body: { wallet, claimId, pointsToClaim? }
//
// Full end-to-end reward claim flow:
//   1. Validate wallet + claimId format
//   2. (Pre-flight) Check Solana program state — paused? vault funded?
//      This avoids burning a Supabase claim if Solana will reject it.
//   3. Call Supabase public.claim_reward RPC:
//        - Locks wallet row (FOR UPDATE)
//        - Derives earned_points from samurai_points (TRUSTED)
//        - Validates points_to_claim <= claimable
//        - Computes reward_amount from configurable conversion rate
//        - Inserts reward_claims row (status=ENTITLED)
//        - Increments wallets.claimed_points ATOMICALLY
//        - Returns the claim data
//      If the same claim_id is submitted twice, returns the existing
//      claim idempotently (no double-spend).
//   4. If the claim was already COMPLETED, return the existing result.
//   5. Mark the claim PENDING_PAYOUT (atomic transition, idempotent
//      if already pending — backend can retry the whole flow safely).
//   6. Convert reward_amount (SOL, numeric) → lamports (u64) safely.
//   7. Build and submit the Solana claim_reward transaction, signed by
//      the backend admin keypair.
//   8a. On success: call update_reward_claim_status(claim_id, COMPLETED, signature).
//   8b. On failure: call revert_failed_reward_claim(claim_id, reason).
//        This atomically transitions PENDING_PAYOUT → FAILED AND
//        decrements wallets.claimed_points, restoring the user's
//        claimable_points.
//   9. Return the final result to the frontend.
//
// SECURITY:
//   - The frontend NEVER sends earned_points, claimed_points,
//     claimable_points, or reward_amount. All derived server-side.
//   - The admin Solana keypair is never exposed to the frontend.
//   - The reward_amount used for the on-chain tx is the value returned
//     by the Supabase RPC — never the frontend.
//   - The recipient on the Solana tx is the wallet_address from the
//     Supabase claim — never a frontend-supplied recipient.
//   - claim_id uniqueness is enforced both in the DB (unique constraint)
//     and on-chain (the claim PDA is derived from claim_id via SHA-256,
//     so the same claim_id can never create a second on-chain claim).
export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'rewards_claim', 10)) return apiError(res, 429, 'RATE_LIMITED', 'Too many claim attempts. Try again shortly.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Rewards are not configured on the server.')

  // Solana rewards program integration requires:
  //   - A Solana RPC endpoint (SOLANA_RPC_URL or HELIUS_API_KEY)
  //   - The admin keypair (NEW_SOLANA_REWARDS_ADMIN_SECRET_KEY,
  //     or legacy SOLANA_REWARDS_ADMIN_SECRET_KEY / _KEYPAIR)
  //
  // If the admin keypair is not configured, the endpoint will fail with
  // a clear configuration error rather than attempting to fall back.
  if (!isRewardsAdminConfigured()) {
    return apiError(res, 503, 'REWARDS_ADMIN_NOT_CONFIGURED',
      'The Solana rewards admin signer is not configured on the server. ' +
      'Set NEW_SOLANA_REWARDS_ADMIN_SECRET_KEY (preferred), or SOLANA_REWARDS_ADMIN_SECRET_KEY.')
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})
  const wallet = String(body?.wallet || '').trim()
  const claimId = String(body?.claimId || body?.claim_id || '').trim()
  const pointsToClaimRaw = body?.pointsToClaim ?? body?.points_to_claim
  const pointsToClaim = pointsToClaimRaw == null ? null : Number(pointsToClaimRaw)

  if (!isValidSolanaWallet(wallet)) {
    return apiError(res, 400, 'INVALID_WALLET', 'A valid Solana wallet address is required.')
  }
  if (!isValidClaimId(claimId)) {
    return apiError(res, 400, 'INVALID_CLAIM_ID', 'A valid claimId (8-200 chars, A-Z a-z 0-9 _ -) is required.')
  }
  if (pointsToClaim != null && (!Number.isFinite(pointsToClaim) || pointsToClaim <= 0)) {
    return apiError(res, 400, 'INVALID_POINTS', 'pointsToClaim must be a positive number, or null/omitted to claim all available.')
  }

  // -----------------------------------------------------------------
  // STEP 1: Pre-flight Solana program state check.
  // -----------------------------------------------------------------
  // If the program is paused or the vault is unfunded, fail BEFORE
  // touching the database — this avoids creating a FAILED claim that
  // the user might confuse with a successful one.
  let programState
  try {
    programState = await getRewardsProgramState()
  } catch (error) {
    console.error('rewards/claim preflight getRewardsProgramState failed:', error?.message || error)
    return apiError(res, 502, 'SOLANA_PROGRAM_STATE_UNAVAILABLE',
      'Could not read the on-chain reward program state. Try again shortly.')
  }
  if (programState.paused) {
    return apiError(res, 409, 'REWARDS_PAUSED',
      'The on-chain reward program is currently paused. Try again later.')
  }

  // -----------------------------------------------------------------
  // STEP 2: Call Supabase public.claim_reward RPC.
  // -----------------------------------------------------------------
  // This is the authoritative accounting operation. It atomically:
  //   - inserts the reward_claims row (status=ENTITLED)
  //   - increments wallets.claimed_points
  //   - returns the computed reward_amount
  //
  // If the same claim_id is submitted again, returns the existing row
  // idempotently (idempotent=true).
  let claimResult
  try {
    claimResult = await callSupabaseRpc('claim_reward', {
      p_wallet_address: wallet,
      p_claim_id: claimId,
      p_points_to_claim: pointsToClaim,
      p_client_nonce: null,
      p_metadata: null,
    })
  } catch (error) {
    console.error('rewards/claim Supabase RPC failed:', error?.message || error)
    return apiError(res, 502, 'CLAIM_RPC_FAILED', 'The Supabase claim RPC failed.')
  }

  if (!claimResult || !claimResult.success) {
    return apiError(res, 502, 'CLAIM_FAILED', 'The reward claim did not return a result.')
  }

  const claim = claimResult.claim
  if (!claim) {
    return apiError(res, 502, 'CLAIM_FAILED', 'The reward claim did not include a claim record.')
  }

  // -----------------------------------------------------------------
  // STEP 3: Idempotent short-circuit.
  // -----------------------------------------------------------------
  // If the claim is already COMPLETED (i.e. the user retried the
  // entire flow after the on-chain tx already succeeded), return the
  // existing completed claim without re-submitting a Solana tx.
  if (claim.status === 'COMPLETED') {
    return json(res, 200, {
      success: true,
      idempotent: Boolean(claimResult.idempotent),
      already_completed: true,
      claim: normalizeClaim(claim),
      earned_points: Number(claimResult.earned_points || 0),
      claimed_points: Number(claimResult.claimed_points || 0),
      claimable_points: Number(claimResult.claimable_points || 0),
    })
  }

  // If the claim is PENDING_PAYOUT (i.e. the backend started a Solana
  // tx but never confirmed it — server crash mid-flow, retry, etc.),
  // do NOT re-submit. Surface the current state to the frontend and
  // let an admin/payout-job investigate. This is the safe choice: a
  // duplicate Solana tx for the same claim_id is impossible anyway
  // (the claim PDA already exists on-chain), but we want to avoid
  // wasting compute on a doomed tx.
  if (claim.status === 'PENDING_PAYOUT') {
    return json(res, 200, {
      success: true,
      idempotent: Boolean(claimResult.idempotent),
      pending_payout: true,
      claim: normalizeClaim(claim),
      earned_points: Number(claimResult.earned_points || 0),
      claimed_points: Number(claimResult.claimed_points || 0),
      claimable_points: Number(claimResult.claimable_points || 0),
    })
  }

  // If the claim is FAILED, the previous Solana attempt failed and
  // was reverted. The user can retry with a NEW claim_id; for THIS
  // claim_id, the safe thing is to report the failed status and
  // suggest a retry with a new claim_id.
  if (claim.status === 'FAILED') {
    return json(res, 200, {
      success: false,
      previously_failed: true,
      claim: normalizeClaim(claim),
      earned_points: Number(claimResult.earned_points || 0),
      claimed_points: Number(claimResult.claimed_points || 0),
      claimable_points: Number(claimResult.claimable_points || 0),
      message: 'A previous attempt for this claim_id failed. Try again with a new claim_id.',
    })
  }

  // The only status we expect at this point is ENTITLED. If it's
  // anything else, bail out safely.
  if (claim.status !== 'ENTITLED') {
    console.warn('rewards/claim unexpected status from Supabase RPC:', claim.status)
    return apiError(res, 502, 'CLAIM_UNEXPECTED_STATUS',
      `The reward claim returned an unexpected status: ${claim.status}.`)
  }

  // -----------------------------------------------------------------
  // STEP 4: Validate recipient matches claim wallet.
  // -----------------------------------------------------------------
  // The recipient on the Solana tx MUST be the wallet_address stored
  // in the claim row. The frontend cannot choose a different recipient.
  const recipientAddress = claim.wallet_address
  if (recipientAddress !== wallet) {
    // Should never happen (the RPC derives wallet_address from the
    // locked wallet row), but defensive.
    return apiError(res, 500, 'WALLET_MISMATCH',
      'The claim wallet address does not match the requested wallet.')
  }

  // -----------------------------------------------------------------
  // STEP 5: Convert SOL → lamports (safe integer arithmetic).
  // -----------------------------------------------------------------
  const rewardAmountSol = Number(claim.reward_amount)
  let rewardAmountLamports
  try {
    rewardAmountLamports = solToLamports(rewardAmountSol)
  } catch (error) {
    console.error('rewards/claim SOL→lamports conversion failed:', error?.message || error, 'reward_amount=', rewardAmountSol)
    // Don't leave the claim hanging — mark it FAILED and revert.
    await safeRevertFailedClaim(claimId, `SOL_TO_LAMPORTS_FAILED: ${error?.message || error}`)
    return apiError(res, 500, 'INVALID_REWARD_AMOUNT',
      'The reward amount could not be converted to lamports. The claim has been reverted.')
  }

  // Defensive: pre-flight vault balance check. If the vault doesn't
  // have enough SOL, fail before submitting (saves gas + avoids a
  // guaranteed-fail tx). If a race condition makes the actual tx fail
  // anyway, the revert path (STEP 7b) handles it.
  if (programState.vaultBalanceLamports < rewardAmountLamports) {
    await safeRevertFailedClaim(claimId, 'VAULT_INSUFFICIENT_BALANCE')
    return apiError(res, 503, 'VAULT_INSUFFICIENT_BALANCE',
      `The reward vault does not have enough SOL to fulfill this claim. ` +
      `Required: ${rewardAmountLamports / 1e9} SOL, available: ${programState.vaultBalanceSol} SOL. ` +
      `The claim has been reverted.`)
  }

  // -----------------------------------------------------------------
  // STEP 6: Mark the claim PENDING_PAYOUT (atomic transition).
  // -----------------------------------------------------------------
  // This happens AFTER the Supabase claim is created and BEFORE the
  // Solana tx is submitted. If the backend crashes between STEP 6 and
  // STEP 7, the claim stays in PENDING_PAYOUT and the next request
  // for the same claim_id will short-circuit in STEP 3 above.
  try {
    const pendingResult = await callSupabaseRpc('mark_reward_claim_pending_payout', {
      p_claim_id: claimId,
    })
    if (!pendingResult || !pendingResult.claim) {
      return apiError(res, 502, 'PENDING_TRANSITION_FAILED',
        'The claim could not be marked as pending payout.')
    }
    // Use the latest claim snapshot from this point on.
    Object.assign(claim, pendingResult.claim)
  } catch (error) {
    console.error('rewards/claim mark_pending_payout failed:', error?.message || error)
    return apiError(res, 502, 'PENDING_TRANSITION_FAILED',
      'The claim could not be marked as pending payout.')
  }

  // -----------------------------------------------------------------
  // STEP 7: Submit the Solana claim_reward transaction (with safe
  // confirmation reconciliation).
  // -----------------------------------------------------------------
  // submitClaimRewardTx now returns { signature, confirmed: bool, confirmError? }
  // instead of just a signature. This matters for production safety:
  //
  //   - If confirmed=true: tx is on-chain and confirmed. Mark COMPLETED.
  //   - If confirmed=false AND signature exists: the tx was broadcast
  //     but confirmation timed out. We MUST NOT mark FAILED — the tx
  //     may still land on-chain. Instead, poll the signature status
  //     for up to 30 seconds. If we can't determine the truth, leave
  //     the claim in PENDING_PAYOUT and let an admin reconciliation
  //     job resolve it later. NEVER revert in this case.
  //   - If signature itself is missing: tx was rejected before
  //     broadcast (bad blockhash, signature error, etc.). Safe to revert.
  let signature
  let confirmed = false
  try {
    // The on-chain Solana program expects points_claimed as a u64 integer,
    // but the DB stores it as numeric(30,6) with up to 6 decimal places.
    // Floor to an integer for the on-chain call. The fractional remainder
    // (sub-point precision, worth < 0.001 SOL) is not claimable on-chain.
    // The DB accounting (claimed_points increment) uses the full decimal
    // value for accuracy; the on-chain value is purely informational.
    const onChainPointsClaimed = Math.floor(Number(claim.points_claimed))
    if (onChainPointsClaimed <= 0) {
      throw new Error('POINTS_TOO_SMALL_TO_CLAIM_ON_CHAIN')
    }
    const result = await submitClaimRewardTx({
      claimId,
      pointsClaimed: onChainPointsClaimed,
      rewardAmountLamports,
      recipientAddress,
    })
    signature = result.signature
    confirmed = result.confirmed === true
  } catch (error) {
    // The transaction was REJECTED before broadcast (e.g. simulation
    // failure, blockhash expired, signature verification failure).
    // No signature exists → no money moved → safe to revert.
    console.error('rewards/claim Solana tx rejected before broadcast:', error?.message || error, {
      claimId, wallet: wallet.slice(0, 8) + '...', rewardAmountLamports,
    })
    const reason = solanaErrorMessage(error) || 'SOLANA_TX_REJECTED'
    await safeRevertFailedClaim(claimId, reason)
    return apiError(res, 502, 'SOLANA_PAYOUT_FAILED',
      `The on-chain payout failed: ${reason}. Your points have been restored.`)
  }

  // If confirmation timed out, poll for the truth.
  if (!confirmed && signature) {
    console.warn('rewards/claim Solana tx confirmation timed out; polling signature status', {
      claimId, signature,
    })
    const pollResult = await safeConfirmTx(signature, { timeoutMs: 30_000 })
    if (pollResult.status === 'confirmed') {
      confirmed = true
    } else if (pollResult.status === 'failed') {
      // The tx was definitively rejected by the network.
      console.error('rewards/claim Solana tx definitively FAILED after polling:', pollResult.error, {
        claimId, signature,
      })
      await safeRevertFailedClaim(claimId, `SOLANA_TX_FAILED: ${pollResult.error || 'unknown'}`)
      return apiError(res, 502, 'SOLANA_PAYOUT_FAILED',
        `The on-chain payout failed: ${pollResult.error || 'transaction rejected'}. Your points have been restored.`)
    } else {
      // AMBIGUOUS: we don't know if the tx will land or not. NEVER revert —
      // the user might still get paid. Leave the claim PENDING_PAYOUT
      // and let an admin reconciliation job resolve it later.
      console.error('rewards/claim Solana tx status UNKNOWN after polling — leaving PENDING_PAYOUT for admin reconciliation', {
        claimId, signature,
      })
      return json(res, 200, {
        success: false,
        pending_payout: true,
        db_status_pending: true,
        ambiguous_confirmation: true,
        claim: normalizeClaim(claim), // still PENDING_PAYOUT in DB
        claim_tx_signature: signature,
        explorer_url: getTxExplorerUrl(signature),
        earned_points: Number(claimResult.earned_points || 0),
        claimed_points: Number(claimResult.claimed_points || 0),
        claimable_points: Number(claimResult.claimable_points || 0),
        message: 'Your claim was submitted but on-chain confirmation timed out. ' +
          'Your points are reserved. If the transaction succeeds, your payout will complete automatically. ' +
          'If it fails, an admin will restore your points. No action needed from you.',
      })
    }
  }

  if (!signature) {
    // Defensive — should never reach here.
    console.error('rewards/claim no signature returned from submitClaimRewardTx', { claimId })
    await safeRevertFailedClaim(claimId, 'NO_TX_SIGNATURE')
    return apiError(res, 502, 'SOLANA_PAYOUT_FAILED',
      'The on-chain payout failed: no transaction signature was returned. Your points have been restored.')
  }

  // -----------------------------------------------------------------
  // STEP 8: Mark the claim COMPLETED with the Solana tx signature.
  // -----------------------------------------------------------------
  let completedClaim
  try {
    const result = await callSupabaseRpc('update_reward_claim_status', {
      p_claim_id: claimId,
      p_status: 'COMPLETED',
      p_claim_tx_signature: signature,
      p_failure_reason: null,
    })
    completedClaim = result
  } catch (error) {
    // The on-chain payout DID succeed — we have a signature. The DB
    // status update failed (transient Supabase error). The claim is
    // PENDING_PAYOUT in the DB but the SOL has been paid on-chain.
    // We MUST return the success to the user (they got their SOL),
    // and an admin/payout reconciliation job should fix the DB status.
    console.error('rewards/claim DB COMPLETED update failed AFTER successful Solana payout:', error?.message || error,
      { claimId, signature })
    return json(res, 200, {
      success: true,
      payout_succeeded: true,
      db_status_update_pending: true,
      claim: normalizeClaim(claim), // still PENDING_PAYOUT in DB
      claim_tx_signature: signature,
      earned_points: Number(claimResult.earned_points || 0),
      claimed_points: Number(claimResult.claimed_points || 0),
      claimable_points: Number(claimResult.claimable_points || 0),
      message: 'Your SOL payout succeeded on-chain. The claim status will update shortly.',
    })
  }

  // -----------------------------------------------------------------
  // STEP 9: Return the final success result.
  // -----------------------------------------------------------------
  return json(res, 200, {
    success: true,
    idempotent: Boolean(claimResult.idempotent),
    claim: normalizeClaim(completedClaim || claim),
    claim_tx_signature: signature,
    explorer_url: getTxExplorerUrl(signature),
    earned_points: Number(claimResult.earned_points || 0),
    claimed_points: Number(claimResult.claimed_points || 0),
    claimable_points: Number(claimResult.claimable_points || 0),
  })
}

// =====================================================================
// Helpers
// =====================================================================

function safeParse(s) { try { return JSON.parse(s) } catch { return {} } }

// Thin wrapper around Supabase REST RPC invocation.
// Throws Error with .code and .message if the RPC raises an exception.
//
// Uses globalThis.__RONIN_LOCAL_ENV__ (set by Vite's localApiPlugin) with
// process.env fallback — same pattern as supabaseBackend.mjs. This is
// critical for Vite dev SSR, where process.env is not reliably populated.
const claimRuntimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

async function callSupabaseRpc(name, params) {
  const response = await fetch(`${claimRuntimeEnv.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: claimRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${claimRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!response.ok) {
    const code = extractRpcCode(body) || 'RPC_FAILED'
    const err = new Error(code)
    err.code = code
    err.body = body
    err.status = response.status
    throw err
  }
  return Array.isArray(body) ? body[0] : body
}

function extractRpcCode(body) {
  if (!body) return null
  if (typeof body === 'string') return body.split('\n')[0].replace(/^ERROR:\s*/, '')
  if (body.message) return String(body.message).split('\n')[0].replace(/^ERROR:\s*/, '')
  if (body.error) return String(body.error).split('\n')[0].replace(/^ERROR:\s*/, '')
  return null
}

function normalizeClaim(c) {
  if (!c) return null
  return {
    ...c,
    points_claimed: Number(c.points_claimed || 0),
    reward_amount: Number(c.reward_amount || 0),
    conversion_rate: Number(c.conversion_rate || 0),
  }
}

// Best-effort revert. Used in failure paths where we cannot return the
// SOL to the user (the on-chain tx never confirmed). Returns true on
// success or if the claim was already reverted; logs and returns
// false on hard failure.
async function safeRevertFailedClaim(claimId, reason) {
  try {
    await callSupabaseRpc('revert_failed_reward_claim', {
      p_claim_id: claimId,
      p_failure_reason: String(reason || 'SOLANA_PAYOUT_FAILED').slice(0, 500),
    })
    return true
  } catch (error) {
    console.error('safeRevertFailedClaim FAILED — manual admin intervention required:',
      { claimId, reason, error: error?.message || error })
    return false
  }
}

function solanaErrorMessage(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  if (error.message) return error.message
  if (error.code) return String(error.code)
  return String(error)
}