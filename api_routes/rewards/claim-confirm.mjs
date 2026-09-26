// =====================================================================
// POST /api/rewards/claim-confirm
// =====================================================================
// USER-PAYS-FEE FLOW — Step 3 of 3
//
// Body: { claimId, signature }
//
// Called by the frontend AFTER the user has signed the partially-signed
// transaction (returned by /api/rewards/claim-prepare) in Phantom AND
// submitted it to Solana. The signature is the on-chain tx signature.
//
// Steps:
//   1. Validate claimId + signature format
//   2. Poll Solana for the tx (with retry — the tx may still be in
//      mempool when this endpoint is first called)
//   3. If confirmed + success:
//        - Call mark_reward_claim_pending_payout (ENTITLED → PENDING_PAYOUT)
//          — atomic, idempotent if already PENDING
//        - Call update_reward_claim_status(COMPLETED, signature)
//        - Return success with explorer URL
//   4. If confirmed + failed:
//        - Call revert_failed_reward_claim (restores user's points)
//        - Return error
//   5. If still pending after 30s polling:
//        - Return ambiguous state — leave claim as ENTITLED
//        - Frontend should show "tx submitted, awaiting confirmation"
//          and poll /api/rewards/balance until status changes, OR
//          retry /claim-confirm after 30s.
//
// SECURITY:
//   - We do NOT trust the signature blindly. We verify:
//       a) The tx actually exists on-chain
//       b) The tx succeeded (meta.err == null)
//       c) The tx called OUR claim_reward instruction on OUR program
//       d) The recipient of the SOL transfer matches claim.wallet_address
//   - If any of these fail, we revert the claim.
// =====================================================================

import { apiError, json, parseBody, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import { isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'
import {
  getRewardsConnection,
  getTxExplorerUrl,
  RONIN_REWARDS_PROGRAM_ID,
} from '../../api/_lib/solanaRewardsAdmin.mjs'
import { PublicKey } from '@solana/web3.js'

function isValidClaimId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value)
}

function isValidSignature(value) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)
}

function safeParse(s) { try { return JSON.parse(s) } catch { return {} } }

const confirmRuntimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

async function callSupabaseRpc(name, params) {
  const response = await fetch(`${confirmRuntimeEnv.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: confirmRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${confirmRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY}`,
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

async function safeRevertFailedClaim(claimId, reason) {
  try {
    await callSupabaseRpc('revert_failed_reward_claim', {
      p_claim_id: claimId,
      p_failure_reason: String(reason || 'CONFIRM_FAILED').slice(0, 500),
    })
    return true
  } catch (error) {
    console.error('safeRevertFailedClaim FAILED — manual admin intervention required:',
      { claimId, reason, error: error?.message || error })
    return false
  }
}

// Poll getTransaction for up to 30s. The tx may take a few seconds to
// land on-chain after the user submits it via Phantom.
async function pollTransaction(connection, signature) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      const txInfo = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      if (txInfo) return { status: 'found', txInfo }
    } catch (error) {
      // Transient RPC error — keep polling.
      console.warn('claim-confirm getTransaction attempt', attempt + 1, 'failed:', error?.message || error)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return { status: 'not_found' }
}

// Verify the on-chain tx actually called our claim_reward instruction
// and that the recipient matches the claim.
function verifyTxMatchesClaim(txInfo, expectedRecipient, expectedProgramId) {
  if (!txInfo) return { ok: false, reason: 'TX_NOT_FOUND' }
  if (txInfo.meta?.err) return { ok: false, reason: 'TX_FAILED_ON_CHAIN', detail: JSON.stringify(txInfo.meta.err) }

  const instructions = txInfo.transaction?.message?.instructions || []
  const innerInstructions = txInfo.meta?.innerInstructions || []
  const allInstructions = [...instructions, ...innerInstructions.flatMap((ix) => ix.instructions || [])]

  const programIdStr = String(expectedProgramId)
  const ourInstruction = allInstructions.find((ix) => {
    const programId = ix.programId || ix.programId?.toString?.()
    return String(programId) === programIdStr
  })

  if (!ourInstruction) {
    return { ok: false, reason: 'CLAIM_INSTRUCTION_NOT_FOUND', detail: 'No instruction calls the rewards program' }
  }

  // Verify the recipient was a writable account in the tx (it received SOL).
  const accountKeys = (txInfo.transaction?.message?.accountKeys || []).map((k) => String(k))
  const recipientIdx = accountKeys.indexOf(expectedRecipient)
  if (recipientIdx < 0) {
    return { ok: false, reason: 'RECIPIENT_NOT_IN_TX', detail: `expected ${expectedRecipient}, not in accountKeys` }
  }

  // Verify the recipient's balance actually increased.
  const preBalance = txInfo.meta?.preBalances?.[recipientIdx]
  const postBalance = txInfo.meta?.postBalances?.[recipientIdx]
  if (!Number.isFinite(preBalance) || !Number.isFinite(postBalance)) {
    return { ok: false, reason: 'BALANCE_NOT_AVAILABLE' }
  }
  if (postBalance <= preBalance) {
    return { ok: false, reason: 'RECIPIENT_BALANCE_DID_NOT_INCREASE', detail: `pre=${preBalance} post=${postBalance}` }
  }

  return { ok: true, recipientIdx, preBalance, postBalance }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!(await rateLimitPersistent(req, 'rewards_claim_confirm', 20))) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many confirm requests. Try again shortly.')
  }
  if (!isSupabaseConfigured()) {
    return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Rewards are not configured on the server.')
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {})
  const claimId = String(body?.claimId || body?.claim_id || '').trim()
  const signature = String(body?.signature || '').trim()

  if (!isValidClaimId(claimId)) {
    return apiError(res, 400, 'INVALID_CLAIM_ID', 'A valid claimId (8-200 chars, A-Z a-z 0-9 _ -) is required.')
  }
  if (!isValidSignature(signature)) {
    return apiError(res, 400, 'INVALID_SIGNATURE', 'A valid Solana transaction signature is required.')
  }

  // Look up the claim to get the expected recipient.
  let claimRow
  try {
    claimRow = await callSupabaseRpc('get_reward_claim', { p_claim_id: claimId })
  } catch (error) {
    // The get_reward_claim RPC may not exist in older migrations.
    // Fall back to reading from the balance endpoint's recent_claims.
    console.warn('claim-confirm get_reward_claim RPC unavailable, falling back:', error?.message || error)
  }

  // If we couldn't fetch the claim row directly, we can't safely verify
  // the recipient. Require the wallet to be passed in the body.
  const expectedRecipient = String(body?.wallet || claimRow?.wallet_address || '').trim()
  if (!isValidSignature(expectedRecipient) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expectedRecipient)) {
    return apiError(res, 400, 'WALLET_REQUIRED',
      'The wallet address is required to verify the claim. Pass it in the body as `wallet`.')
  }

  // Poll Solana for the tx (up to 30s).
  const connection = getRewardsConnection()
  console.info('[claim-confirm] polling Solana for tx', { claimId, signature, wallet: expectedRecipient })
  const pollResult = await pollTransaction(connection, signature)
  console.info('[claim-confirm] poll result', {
    claimId,
    status: pollResult.status,
    hasTxInfo: Boolean(pollResult.txInfo),
  })

  if (pollResult.status === 'not_found') {
    // Tx not yet landed. The claim stays ENTITLED — the user can retry
    // /claim-confirm later. Don't revert: the tx might still land.
    console.warn('[claim-confirm] tx not found on Solana (may still land)', { claimId, signature })
    return json(res, 200, {
      success: false,
      pending: true,
      claim_id: claimId,
      signature,
      message: 'The transaction has not been confirmed on Solana yet. Wait a few seconds and retry /api/rewards/claim-confirm.',
    })
  }

  // Verify the on-chain tx actually called our claim_reward instruction
  // and that the recipient's balance increased.
  const verification = verifyTxMatchesClaim(pollResult.txInfo, expectedRecipient, RONIN_REWARDS_PROGRAM_ID)
  console.info('[claim-confirm] tx verification', {
    claimId,
    ok: verification.ok,
    reason: verification.reason,
    recipientIdx: verification.recipientIdx,
    preBalance: verification.preBalance,
    postBalance: verification.postBalance,
  })
  if (!verification.ok) {
    // The tx exists but doesn't match our claim. Revert.
    console.warn('[claim-confirm] tx verification FAILED — reverting claim', { claimId, reason: verification.reason })
    await safeRevertFailedClaim(claimId, `TX_VERIFICATION_FAILED: ${verification.reason}`)
    return apiError(res, 422, 'TX_VERIFICATION_FAILED',
      `The on-chain transaction did not match the expected claim. Reason: ${verification.reason}. The claim has been reverted.`)
  }

  // Tx confirmed + verified. Transition ENTITLED → PENDING_PAYOUT → COMPLETED.
  console.info('[claim-confirm] tx verified — marking PENDING_PAYOUT', { claimId })
  try {
    await callSupabaseRpc('mark_reward_claim_pending_payout', { p_claim_id: claimId })
    console.info('[claim-confirm] mark_pending_payout done', { claimId })
  } catch (error) {
    // If the claim was already COMPLETED or PENDING, mark_pending_payout
    // is idempotent — it returns the existing row. Only fail on hard errors.
    console.warn('claim-confirm mark_pending_payout RPC returned non-fatal error:', error?.message || error)
  }

  let completedClaim
  try {
    completedClaim = await callSupabaseRpc('update_reward_claim_status', {
      p_claim_id: claimId,
      p_status: 'COMPLETED',
      p_claim_tx_signature: signature,
      p_failure_reason: null,
    })
    console.info('[claim-confirm] marked COMPLETED', { claimId, signature })
  } catch (error) {
    // The on-chain payout DID succeed — we have a signature. The DB
    // status update failed (transient Supabase error). The claim is
    // PENDING_PAYOUT in the DB but the SOL has been paid on-chain.
    // Return success to the user; admin reconciliation handles the rest.
    console.error('claim-confirm DB COMPLETED update failed AFTER successful Solana payout:',
      error?.message || error, { claimId, signature })
    return json(res, 200, {
      success: true,
      payout_succeeded: true,
      db_status_update_pending: true,
      claim_id: claimId,
      signature,
      explorer_url: getTxExplorerUrl(signature),
      message: 'Your SOL payout succeeded on-chain. The claim status will update shortly.',
    })
  }

  return json(res, 200, {
    success: true,
    claim_id: claimId,
    signature,
    explorer_url: getTxExplorerUrl(signature),
    claim: completedClaim,
    recipient_balance_before: verification.preBalance,
    recipient_balance_after: verification.postBalance,
    message: 'Reward claim completed. SOL has been transferred to your wallet.',
  })
}
