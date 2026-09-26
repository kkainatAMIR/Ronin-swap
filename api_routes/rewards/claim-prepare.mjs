// =====================================================================
// POST /api/rewards/claim-prepare
// =====================================================================
// USER-PAYS-FEE FLOW — Step 1 of 3
//
// Body: { wallet, claimId, pointsToClaim? }
//
// This endpoint does everything the existing /api/rewards/claim does
// UP TO the point of submitting the Solana transaction — but instead of
// submitting the tx with the admin keypair as fee payer, it returns
// a partially-signed transaction (base64) that the user's wallet
// (Phantom) will countersign as fee payer.
//
// Steps:
//   1. Validate wallet + claimId format
//   2. Pre-flight: check program state — paused? vault funded?
//   3. Call Supabase public.claim_reward RPC (atomic, idempotent):
//        - inserts reward_claims row (status=ENTITLED)
//        - increments wallets.claimed_points
//        - returns computed reward_amount
//   4. Idempotent short-circuits:
//        - If already COMPLETED → return existing result
//        - If PENDING_PAYOUT → return existing (user must finish the
//          in-flight tx; cannot start a new one for this claim_id)
//        - If FAILED → return error, suggest new claim_id
//   5. Convert reward_amount (SOL) → lamports
//   6. Build the claim_reward instruction (admin signs as instruction
//      signer; user becomes fee payer via the partially-signed tx)
//   7. Assemble Transaction with:
//        - recentBlockhash (fetched live)
//        - feePayer = user wallet (NOT admin)
//        - admin signs the tx (partial sign — only signs the
//          instruction, not the fee payer)
//   8. Return base64-serialized partially-signed tx + claim metadata
//
// IMPORTANT: This endpoint does NOT mark the claim PENDING_PAYOUT.
// The transition ENTITLED → PENDING_PAYOUT only happens in the
// /claim-confirm endpoint after the user has actually submitted
// the tx via Phantom. If the user never submits (rejects or closes
// Phantom), the claim stays ENTITLED and can be cleaned up by the
// orphan-claim cron (scripts/cleanup-orphan-claims.mjs).
// =====================================================================

import { apiError, json, parseBody, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import { isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'
import {
  isRewardsAdminConfigured,
  getRewardsProgramState,
  solToLamports,
  buildClaimRewardInstruction,
  getRewardsConnection,
  getTxExplorerUrl,
  RONIN_REWARDS_PROGRAM_ID,
} from '../../api/_lib/solanaRewardsAdmin.mjs'
import { Connection, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js'

function isValidSolanaWallet(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)
}

function isValidClaimId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value)
}

function safeParse(s) { try { return JSON.parse(s) } catch { return {} } }

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

function normalizeClaim(c) {
  if (!c) return null
  return {
    ...c,
    points_claimed: Number(c.points_claimed || 0),
    reward_amount: Number(c.reward_amount || 0),
    conversion_rate: Number(c.conversion_rate || 0),
  }
}

async function safeRevertFailedClaim(claimId, reason) {
  try {
    await callSupabaseRpc('revert_failed_reward_claim', {
      p_claim_id: claimId,
      p_failure_reason: String(reason || 'PREPARE_FAILED').slice(0, 500),
    })
    return true
  } catch (error) {
    console.error('safeRevertFailedClaim FAILED — manual admin intervention required:',
      { claimId, reason, error: error?.message || error })
    return false
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!(await rateLimitPersistent(req, 'rewards_claim_prepare', 10))) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many claim attempts. Try again shortly.')
  }
  if (!isSupabaseConfigured()) {
    return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Rewards are not configured on the server.')
  }
  if (!isRewardsAdminConfigured()) {
    return apiError(res, 503, 'REWARDS_ADMIN_NOT_CONFIGURED',
      'The Solana rewards admin signer is not configured on the server.')
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

  // --- STEP 1: Pre-flight program state check ---
  let programState
  try {
    programState = await getRewardsProgramState()
  } catch (error) {
    console.error('claim-prepare preflight getRewardsProgramState failed:', error?.message || error)
    return apiError(res, 502, 'SOLANA_PROGRAM_STATE_UNAVAILABLE',
      'Could not read the on-chain reward program state. Try again shortly.')
  }
  if (programState.paused) {
    return apiError(res, 409, 'REWARDS_PAUSED',
      'The on-chain reward program is currently paused. Try again later.')
  }

  // --- STEP 2: Supabase claim_reward RPC (atomic, idempotent) ---
  let claimResult
  try {
    claimResult = await callSupabaseRpc('claim_reward', {
      p_wallet_address: wallet,
      p_claim_id: claimId,
      p_points_to_claim: pointsToClaim,
      p_client_nonce: null,
      p_metadata: { flow: 'user-pays-fee' },
    })
  } catch (error) {
    // DIAGNOSTIC LOG: log the specific RPC failure code + claim_id +
    // wallet so we can see exactly which exception path fired. Safe
    // — no signature/nonce data is logged.
    console.error('[claim-prepare] RPC raised', {
      wallet,
      claimId,
      code: error?.code,
      status: error?.status,
      message: error?.message,
      // PostgREST may include the underlying PG error in body.
      // Truncate to keep the log readable.
      bodyPreview: error?.body
        ? JSON.stringify(error.body).slice(0, 500)
        : null,
    })
    return apiError(res, 502, 'CLAIM_RPC_FAILED', error?.code || 'The Supabase claim RPC failed.')
  }

  if (!claimResult || !claimResult.success) {
    return apiError(res, 502, 'CLAIM_FAILED', 'The reward claim did not return a result.')
  }

  const claim = claimResult.claim
  if (!claim) {
    return apiError(res, 502, 'CLAIM_FAILED', 'The reward claim did not include a claim record.')
  }

  // --- STEP 3: Idempotent short-circuits ---
  if (claim.status === 'COMPLETED') {
    return json(res, 200, {
      success: true,
      idempotent: Boolean(claimResult.idempotent),
      already_completed: true,
      claim: normalizeClaim(claim),
      earned_points: Number(claimResult.earned_points || 0),
      claimed_points: Number(claimResult.claimed_points || 0),
      claimable_points: Number(claimResult.claimable_points || 0),
      message: 'This claim was already completed. No further action needed.',
    })
  }

  if (claim.status === 'PENDING_PAYOUT') {
    // A previous /claim-prepare call for this claim_id is in-flight.
    // The user should complete or cancel it before starting a new one.
    return json(res, 200, {
      success: false,
      pending_payout: true,
      claim: normalizeClaim(claim),
      earned_points: Number(claimResult.earned_points || 0),
      claimed_points: Number(claimResult.claimed_points || 0),
      claimable_points: Number(claimResult.claimable_points || 0),
      message: 'A payout is already in progress for this claim_id. Use /api/rewards/claim-cancel to cancel it first, or complete it via /api/rewards/claim-confirm.',
    })
  }

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

  if (claim.status !== 'ENTITLED') {
    return apiError(res, 502, 'CLAIM_UNEXPECTED_STATUS',
      `The reward claim returned an unexpected status: ${claim.status}.`)
  }

  // --- STEP 4: Validate recipient matches claim wallet ---
  const recipientAddress = claim.wallet_address
  if (recipientAddress !== wallet) {
    return apiError(res, 500, 'WALLET_MISMATCH',
      'The claim wallet address does not match the requested wallet.')
  }

  // --- STEP 5: Convert SOL → lamports ---
  const rewardAmountSol = Number(claim.reward_amount)
  let rewardAmountLamports
  try {
    rewardAmountLamports = solToLamports(rewardAmountSol)
  } catch (error) {
    console.error('claim-prepare SOL→lamports failed:', error?.message || error, 'reward_amount=', rewardAmountSol)
    await safeRevertFailedClaim(claimId, `SOL_TO_LAMPORTS_FAILED: ${error?.message || error}`)
    return apiError(res, 500, 'INVALID_REWARD_AMOUNT',
      'The reward amount could not be converted to lamports. The claim has been reverted.')
  }

  // Pre-flight vault balance check (the user's tx will fail on-chain if
  // the vault is short, but failing here saves them a wasted Phantom popup).
  if (programState.vaultBalanceLamports < rewardAmountLamports) {
    await safeRevertFailedClaim(claimId, 'VAULT_INSUFFICIENT_BALANCE')
    return apiError(res, 503, 'VAULT_INSUFFICIENT_BALANCE',
      `The reward vault does not have enough SOL to fulfill this claim. ` +
      `Required: ${rewardAmountLamports / 1e9} SOL, available: ${programState.vaultBalanceSol} SOL. ` +
      `The claim has been reverted.`)
  }

  // --- STEP 6: Build the claim_reward instruction ---
  // The admin signs the INSTRUCTION (passes has_one = admin on-chain).
  // The user becomes the FEE PAYER — set via tx.feePayer below.
  // The contract's required signer is `admin`, not `recipient`, so
  // the user does NOT need to be a signer on the instruction itself —
  // they only need to sign the transaction as fee payer.
  const onChainPointsClaimed = Math.floor(Number(claim.points_claimed))
  if (onChainPointsClaimed <= 0) {
    await safeRevertFailedClaim(claimId, 'POINTS_TOO_SMALL_TO_CLAIM_ON_CHAIN')
    return apiError(res, 400, 'POINTS_TOO_SMALL', 'The points amount is too small to claim on-chain.')
  }

  // --- STEP 7: Assemble the partially-signed transaction ---
  // We import getRewardsAdminKeypair here (not at module top) so the
  // existing custodial /api/rewards/claim endpoint can stay the source
  // of truth for admin-keypair loading semantics.
  const { getRewardsAdminKeypair } = await import('../../api/_lib/solanaRewardsAdmin.mjs')
  const admin = getRewardsAdminKeypair()
  const connection = getRewardsConnection()
  const recipient = new PublicKey(recipientAddress)

  // Wrap buildClaimRewardInstruction in a try/catch so that if it
  // throws (e.g., INVALID_POINTS_CLAIMED, INVALID_REWARD_AMOUNT_LAMPORTS,
  // INVALID_CLAIM_ID), the claim is properly reverted with the correct
  // failure_reason instead of staying ENTITLED and the user getting a
  // generic 500 error.
  let instruction
  try {
    instruction = buildClaimRewardInstruction({
      admin: admin.publicKey,
      recipient,
      claimId,
      pointsClaimed: onChainPointsClaimed,
      rewardAmountLamports,
    })
  } catch (instructionError) {
    console.error('[claim-prepare] buildClaimRewardInstruction threw', {
      claimId,
      pointsClaimed: onChainPointsClaimed,
      rewardAmountLamports,
      error: instructionError?.message,
    })
    await safeRevertFailedClaim(claimId, `INSTRUCTION_BUILD_FAILED: ${instructionError?.message || 'unknown'}`)
    return apiError(res, 500, 'INSTRUCTION_BUILD_FAILED',
      `The claim instruction could not be built: ${instructionError?.message || 'unknown error'}. The claim has been reverted.`)
  }

  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })

  const tx = new Transaction().add(priorityIx, computeIx, instruction)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  // KEY CHANGE: user is the fee payer, NOT admin.
  tx.feePayer = new PublicKey(recipientAddress)

  // Admin signs the tx partially. The user's signature is added later
  // by Phantom. tx.serialize() returns a partially-signed wire format
  // that Phantom's signTransaction() will accept and complete.
  tx.partialSign(admin)

  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
  const base64Tx = Buffer.from(serialized).toString('base64')

  return json(res, 200, {
    success: true,
    flow: 'user-pays-fee',
    claim: normalizeClaim(claim),
    partiallySignedTx: base64Tx,
    // Pass these back to the client so Phantom can build correct explorer URLs
    feePayer: recipientAddress,
    blockhash,
    lastValidBlockHeight,
    rewardAmountLamports,
    pointsClaimed: onChainPointsClaimed,
    programId: RONIN_REWARDS_PROGRAM_ID.toString(),
    network: programState.network,
    explorerUrl: getTxExplorerUrl(''),  // base URL only — signature appended by client
    earned_points: Number(claimResult.earned_points || 0),
    claimed_points: Number(claimResult.claimed_points || 0),
    claimable_points: Number(claimResult.claimable_points || 0),
    message: 'Sign the transaction in your wallet to claim your reward. You will pay the network fee.',
  })
}
