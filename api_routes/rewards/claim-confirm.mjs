// =====================================================================
// POST /api/rewards/claim-confirm
// =====================================================================
// USER-PAYS-FEE FLOW — Step 3 of 3 (no-per-claim-PDA contract)
//
// Body: { claimId, signature, wallet? }
//
// Called by the frontend AFTER the user has signed the partially-signed
// transaction (returned by /api/rewards/claim-prepare) in Phantom AND
// submitted it to Solana. The signature is the on-chain tx signature.
//
// Steps:
//   1. Validate claimId + signature format
//   2. Fetch the authoritative claim row from Supabase (reward_claims
//      table via PostgREST — service_role bypasses RLS). The DB is the
//      source of truth for recipient wallet, points, and reward amount.
//   3. Derive expected on-chain PDAs (reward_config, reward_vault) and
//      the authoritative admin from on-chain program state.
//   4. Poll Solana for the tx (with retry — may still be in mempool).
//   5. Verify the tx:
//        a) The tx actually exists on-chain
//        b) The tx succeeded (meta.err == null)
//        c) Fee payer (accountKeys[0]) = DB recipient wallet
//           (USER-PAYS-FEE flow — user is the fee payer)
//        d) Some instruction calls OUR claim_reward instruction on OUR
//           program — resolved via programIdIndex + accountKeys
//        e) The Anchor discriminator matches claim_reward
//        f) Decoded claim_id, points_claimed, reward_amount match DB
//        g) Account index 0 = admin, 1 = reward_config PDA,
//           2 = reward_vault PDA, 3 = recipient
//        h) Recipient's balance increased by at least reward_amount
//           (with fee tolerance)
//   6. On success: mark PENDING_PAYOUT → COMPLETED.
//   7. On positive failure (tx failed / wrong program / wrong recipient /
//      wrong claim data): revert claim.
//   8. On ambiguous parsing failure (tx succeeded but parser couldn't
//      recognize instruction): leave claim untouched for admin
//      reconciliation. NEVER create the state:
//        SOL paid on-chain + DB points restored.
//
// SECURITY:
//   - We do NOT trust the signature blindly.
//   - We do NOT trust a frontend-supplied wallet beyond a sanity hint.
//   - The DB claim row is authoritative.
//   - The on-chain RewardConfig.admin is authoritative for the admin.
// =====================================================================

import { apiError, json, parseBody, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import { isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'
import {
  getRewardsConnection,
  getTxExplorerUrl,
  getRewardsProgramState,
  getRewardConfigPda,
  getRewardVaultPda,
  RONIN_REWARDS_PROGRAM_ID,
} from '../../api/_lib/solanaRewardsAdmin.mjs'
import { PublicKey } from '@solana/web3.js'
import { createHash } from 'node:crypto'
import bs58 from 'bs58'

function isValidClaimId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value)
}

function isValidSignature(value) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)
}

function safeParse(s) { try { return JSON.parse(s) } catch { return {} } }

const confirmRuntimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

// =====================================================================
// Anchor instruction discriminator for claim_reward.
// sha256("global:claim_reward")[0..8] — must match the deployed program.
// DO NOT change this. The deployed program's claim_reward instruction
// uses the standard Anchor discriminator convention.
// =====================================================================
const CLAIM_REWARD_DISCRIMINATOR = createHash('sha256')
  .update('global:claim_reward')
  .digest()
  .subarray(0, 8)

// Fee tolerance when verifying the recipient's balance increase.
// The recipient is the fee payer in the user-pays-fee flow, so their
// net gain is (reward_amount - tx_fee). A typical tx fee is ~5000
// lamports; we allow up to 100_000 lamports (0.0001 SOL) of tolerance
// to absorb fees, priority fees, and any rent refund noise.
const RECIPIENT_INCREASE_FEE_TOLERANCE_LAMPORTS = 100_000

// =====================================================================
// Supabase RPC wrapper (preserved from the original implementation).
// =====================================================================
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

// =====================================================================
// Direct PostgREST read of reward_claims by claim_id.
// Service_role bypasses RLS, so we can read the authoritative claim
// row without needing a custom get_reward_claim RPC (which doesn't
// exist in the current migrations). This is a SELECT only — no schema
// change, no new RPC.
// =====================================================================
async function fetchClaimRow(claimId) {
  const url = `${confirmRuntimeEnv.SUPABASE_URL}/rest/v1/reward_claims` +
    `?claim_id=eq.${encodeURIComponent(claimId)}` +
    `&select=id,claim_id,wallet_id,wallet_address,points_claimed,reward_asset,reward_amount,conversion_rate,status,claim_tx_signature,failure_reason,created_at,updated_at,completed_at`
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: confirmRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${confirmRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`CLAIM_FETCH_FAILED: ${response.status} ${String(text).slice(0, 200)}`)
  }
  const rows = await response.json()
  return Array.isArray(rows) ? rows[0] || null : rows || null
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

// =====================================================================
// Resolve account keys from a Solana transaction message.
//
// Handles BOTH message formats returned by getTransaction():
//
//   1. Legacy Message (v0):
//        message.accountKeys: string[]
//        message.instructions: [{ programIdIndex, accounts, data }]
//
//   2. MessageV0 (versioned):
//        message.staticAccountKeys: string[]
//        message.accountKeysFromLookups: { writable: string[], readonly: string[] }
//        message.instructions: [{ programIdIndex, accountKeyIndexes, data }]
//
// For V0, the lookups are appended AFTER static keys: writables first,
// then readonly. This matches @solana/web3.js MessageV0.getAccountKeys().
//
// For legacy messages, accountKeysFromLookups is undefined and we
// simply return message.accountKeys.
//
// Each entry may be a string (base58 pubkey) or an object with .pubkey
// (when jsonParsed encoding is used — currently not used here, but
// defensive just in case).
// =====================================================================
function resolveAccountKeys(txInfo) {
  const msg = txInfo?.transaction?.message
  if (!msg) return []

  // Legacy v0 parsed JSON: accountKeys is a string array.
  if (Array.isArray(msg.accountKeys)) {
    return msg.accountKeys.map((k) => (typeof k === 'string' ? k : k?.pubkey || String(k)))
  }

  // Versioned (V0) compiled JSON: staticAccountKeys + accountKeysFromLookups.
  const staticKeys = Array.isArray(msg.staticAccountKeys) ? msg.staticAccountKeys : []
  const lookedUpWritable = msg.accountKeysFromLookups?.writable || []
  const lookedUpReadonly = msg.accountKeysFromLookups?.readonly || []
  return [...staticKeys, ...lookedUpWritable, ...lookedUpReadonly].map((k) =>
    typeof k === 'string' ? k : k?.pubkey || String(k)
  )
}

// =====================================================================
// Resolve the program ID for an instruction.
//
// getTransaction() (without jsonParsed encoding) returns COMPILED
// instructions where the program ID is NOT stored on the instruction
// directly — it must be resolved via `programIdIndex` against the
// account keys array.
//
// This function handles three forms:
//   - Parsed instruction (jsonParsed): ix.programId is a base58 string.
//   - Compiled legacy instruction: ix.programIdIndex (number).
//   - Compiled V0 instruction: ix.programIdIndex (number) — same lookup.
// =====================================================================
function resolveInstructionProgramId(ix, accountKeys) {
  if (!ix) return null

  // Parsed instruction (jsonParsed): programId present directly.
  if (typeof ix.programId === 'string') return ix.programId
  if (ix.programId && typeof ix.programId.toString === 'function') {
    return String(ix.programId)
  }

  // Compiled instruction: programIdIndex references accountKeys.
  if (typeof ix.programIdIndex === 'number') {
    const key = accountKeys[ix.programIdIndex]
    return key ? String(key) : null
  }

  return null
}

// =====================================================================
// Resolve the account index list for a compiled/parsed instruction.
//
// - Parsed instruction: ix.accounts is an array of base58 pubkey STRINGS.
//   We convert each to its index in accountKeys for positional lookup.
// - Compiled legacy instruction: ix.accounts is already number[].
// - Compiled V0 instruction: ix.accountKeyIndexes is number[].
// =====================================================================
function resolveInstructionAccountIndices(ix, accountKeys) {
  if (!ix) return []

  // V0 compiled instruction.
  if (Array.isArray(ix.accountKeyIndexes)) {
    return ix.accountKeyIndexes.map((n) => Number(n))
  }

  // Legacy compiled instruction: array of numeric indices.
  if (Array.isArray(ix.accounts) && ix.accounts.length > 0 && typeof ix.accounts[0] === 'number') {
    return ix.accounts.map((n) => Number(n))
  }

  // Parsed instruction: array of base58 pubkey strings.
  if (Array.isArray(ix.accounts)) {
    return ix.accounts
      .map((pubkey) => {
        const idx = accountKeys.indexOf(String(pubkey))
        return idx === -1 ? null : idx
      })
      .filter((idx) => idx !== null)
  }

  return []
}

// =====================================================================
// Decode an Anchor claim_reward instruction's data buffer.
//
// Layout (per the deployed Rust signature):
//   [0..7]   discriminator (8 bytes) = sha256("global:claim_reward")[0..8]
//   [8..11]  claim_id length (u32 LE)
//   [12..]   claim_id UTF-8 bytes
//   [next 8] points_claimed (u64 LE)
//   [next 8] reward_amount (u64 LE, in lamports)
//
// The data may arrive as:
//   - A base58 string (default for getTransaction without jsonParsed)
//   - A Buffer / Uint8Array (defensive — in case of future changes)
//
// Returns null if the discriminator does not match claim_reward OR if
// the buffer is too short to contain all expected fields.
// =====================================================================
function decodeClaimRewardInstruction(dataInput) {
  if (!dataInput) return null

  let buf
  if (typeof dataInput === 'string') {
    // Solana RPC returns instruction data as base58 for compiled
    // instructions. Node's Buffer.from() does NOT support 'base58' —
    // we have to use the bs58 package to decode.
    try {
      buf = Buffer.from(bs58.decode(dataInput))
    } catch {
      return null
    }
  } else if (Buffer.isBuffer(dataInput)) {
    buf = dataInput
  } else if (dataInput instanceof Uint8Array) {
    buf = Buffer.from(dataInput)
  } else {
    return null
  }

  if (buf.length < 8) return null

  // Discriminator check — must equal the Anchor claim_reward discriminator.
  if (!buf.subarray(0, 8).equals(CLAIM_REWARD_DISCRIMINATOR)) return null

  let offset = 8

  // claim_id: 4-byte LE length + UTF-8 bytes.
  if (buf.length < offset + 4) return null
  const strLen = buf.readUInt32LE(offset)
  offset += 4
  if (buf.length < offset + strLen) return null
  const claimId = buf.subarray(offset, offset + strLen).toString('utf8')
  offset += strLen

  // points_claimed: u64 LE.
  if (buf.length < offset + 8) return null
  const pointsClaimed = buf.readBigUInt64LE(offset)
  offset += 8

  // reward_amount: u64 LE (lamports).
  if (buf.length < offset + 8) return null
  const rewardAmountLamports = buf.readBigUInt64LE(offset)
  offset += 8

  return {
    claimId,
    pointsClaimed: Number(pointsClaimed),
    rewardAmountLamports: Number(rewardAmountLamports),
  }
}

// =====================================================================
// Verify the on-chain tx matches the deployed no-per-claim-PDA
// claim_reward instruction AND the authoritative DB claim row.
//
// Returns:
//   { ok: true, instructionIndex, decoded, feePayer,
//     resolvedAccounts: { admin, reward_config, reward_vault, recipient },
//     preBalance, postBalance, recipientIncrease }
//
//   OR
//
//   { ok: false, reason, detail?, safe }
//
//     safe: true  → ambiguous parsing failure. The tx SUCCEEDED on-chain
//                   and likely interacted with our program, but we could
//                   not positively confirm it represents this claim.
//                   DO NOT revert — leave the claim ENTITLED/PENDING
//                   for admin reconciliation.
//     safe: false → positive failure (tx failed, wrong program, wrong
//                   recipient, wrong claim data). Safe to revert.
// =====================================================================
function verifyTxMatchesClaim({
  txInfo,
  expectedRecipient,
  expectedProgramId,
  expectedRewardConfigPda,
  expectedRewardVaultPda,
  expectedAdmin,
  expectedClaimId,
  expectedPointsClaimed,
  expectedRewardAmountLamports,
}) {
  if (!txInfo) {
    return { ok: false, reason: 'TX_NOT_FOUND', safe: false }
  }

  // On-chain failure: the program returned an error. Safe to revert.
  if (txInfo.meta?.err) {
    return {
      ok: false,
      reason: 'TX_FAILED_ON_CHAIN',
      detail: JSON.stringify(txInfo.meta.err),
      safe: false,
    }
  }

  const accountKeys = resolveAccountKeys(txInfo)
  if (accountKeys.length === 0) {
    return { ok: false, reason: 'NO_ACCOUNT_KEYS', safe: true }
  }

  // ----------------------------------------------------------------
  // Fee payer check — USER-PAYS-FEE flow.
  //
  // The fee payer is always the first account key (accountKeys[0]).
  // In the user-pays-fee flow, that MUST be the recipient wallet
  // (the user pays the tx fee; the admin is only the instruction
  // signer for has_one = admin enforcement).
  //
  // If the fee payer is NOT the expected recipient, this tx was
  // either:
  //   - submitted by a different user (positive mismatch — revert)
  //   - built with the admin as fee payer (legacy flow — revert,
  //     we don't accept admin-pays-fee txs through this endpoint)
  // ----------------------------------------------------------------
  const feePayer = accountKeys[0]
  if (feePayer !== expectedRecipient) {
    return {
      ok: false,
      reason: 'FEE_PAYER_NOT_RECIPIENT',
      detail: `fee_payer=${feePayer}, expected=${expectedRecipient}`,
      safe: false,
    }
  }

  // ----------------------------------------------------------------
  // Find the claim_reward instruction.
  //
  // We iterate over ALL instructions (top-level + inner) and look for
  // the one that:
  //   1. Targets OUR deployed program ID (resolved via programIdIndex)
  //   2. Has the Anchor claim_reward discriminator
  // ----------------------------------------------------------------
  const instructions = txInfo.transaction?.message?.instructions || []
  const innerInstructions = txInfo.meta?.innerInstructions || []
  const allInstructions = [
    ...instructions.map((ix, i) => ({ ix, ixIndex: i, isInner: false })),
    ...innerInstructions.flatMap((group) =>
      (group.instructions || []).map((ix, j) => ({
        ix,
        ixIndex: `${group.index}.${j}`,
        isInner: true,
      }))
    ),
  ]

  let touchedOurProgram = false
  let matchedClaimIx = null

  for (const entry of allInstructions) {
    const programId = resolveInstructionProgramId(entry.ix, accountKeys)
    if (programId !== String(expectedProgramId)) continue
    touchedOurProgram = true

    const decoded = decodeClaimRewardInstruction(entry.ix.data)
    if (!decoded) continue // touched our program but not claim_reward — skip

    matchedClaimIx = { entry, decoded }
    break
  }

  if (!matchedClaimIx) {
    // Did the tx touch our program AT ALL?
    if (touchedOurProgram) {
      // The tx succeeded AND touched our program, but we couldn't
      // find a recognizable claim_reward instruction. This may be a
      // future program upgrade or a parser gap. DO NOT revert — leave
      // the claim for admin reconciliation.
      return {
        ok: false,
        reason: 'CLAIM_INSTRUCTION_NOT_FOUND_BUT_PROGRAM_TOUCHED',
        detail: 'tx touched rewards program but no claim_reward instruction was parseable',
        safe: true,
      }
    }
    // The tx did NOT touch our program at all — this is a positive
    // mismatch. The user submitted some unrelated tx as their "claim
    // confirmation". Safe to revert.
    return {
      ok: false,
      reason: 'CLAIM_INSTRUCTION_NOT_FOUND',
      detail: 'no instruction calls the rewards program',
      safe: false,
    }
  }

  const { entry, decoded } = matchedClaimIx

  // ----------------------------------------------------------------
  // Verify decoded args match the authoritative DB claim row.
  // ----------------------------------------------------------------
  if (decoded.claimId !== expectedClaimId) {
    return {
      ok: false,
      reason: 'CLAIM_ID_MISMATCH',
      detail: `decoded=${decoded.claimId}, expected=${expectedClaimId}`,
      safe: false, // positive mismatch — different claim
    }
  }
  if (decoded.pointsClaimed !== expectedPointsClaimed) {
    return {
      ok: false,
      reason: 'POINTS_MISMATCH',
      detail: `decoded=${decoded.pointsClaimed}, expected=${expectedPointsClaimed}`,
      safe: false,
    }
  }
  if (decoded.rewardAmountLamports !== expectedRewardAmountLamports) {
    return {
      ok: false,
      reason: 'REWARD_AMOUNT_MISMATCH',
      detail: `decoded=${decoded.rewardAmountLamports}, expected=${expectedRewardAmountLamports}`,
      safe: false,
    }
  }

  // ----------------------------------------------------------------
  // Verify instruction account indexes resolve to the expected PDAs.
  //
  // The deployed ClaimReward struct expects EXACTLY four accounts:
  //
  //   index 0: admin         (Signer, mut) — has_one = admin on RewardConfig
  //   index 1: reward_config (mut)         — PDA ["reward_config"]
  //   index 2: reward_vault  (mut)         — PDA ["reward_vault"]
  //   index 3: recipient     (mut)         — SystemAccount (user wallet)
  //
  // There is NO per-claim PDA and NO system_program in the upgraded
  // instruction layout.
  // ----------------------------------------------------------------
  const ixAccountIndices = resolveInstructionAccountIndices(entry.ix, accountKeys)
  if (ixAccountIndices.length < 4) {
    return {
      ok: false,
      reason: 'TOO_FEW_ACCOUNTS',
      detail: `instruction has ${ixAccountIndices.length} accounts, expected >= 4`,
      safe: true, // ambiguous — tx succeeded but layout is unexpected
    }
  }

  const resolvedAccounts = ixAccountIndices.map((idx) => accountKeys[idx])
  const [adminOnChain, configOnChain, vaultOnChain, recipientOnChain] = resolvedAccounts

  if (adminOnChain !== String(expectedAdmin)) {
    return {
      ok: false,
      reason: 'ADMIN_ACCOUNT_MISMATCH',
      detail: `on_chain=${adminOnChain}, expected=${expectedAdmin}`,
      safe: true, // ambiguous — could be an admin rotation we don't know about yet
    }
  }
  if (configOnChain !== String(expectedRewardConfigPda)) {
    return {
      ok: false,
      reason: 'CONFIG_PDA_MISMATCH',
      detail: `on_chain=${configOnChain}, expected=${expectedRewardConfigPda}`,
      safe: true,
    }
  }
  if (vaultOnChain !== String(expectedRewardVaultPda)) {
    return {
      ok: false,
      reason: 'VAULT_PDA_MISMATCH',
      detail: `on_chain=${vaultOnChain}, expected=${expectedRewardVaultPda}`,
      safe: true,
    }
  }
  if (recipientOnChain !== expectedRecipient) {
    return {
      ok: false,
      reason: 'RECIPIENT_ACCOUNT_MISMATCH',
      detail: `on_chain=${recipientOnChain}, expected=${expectedRecipient}`,
      safe: false, // positive mismatch — payout went to wrong wallet
    }
  }

  // ----------------------------------------------------------------
  // Verify the recipient actually received the expected reward.
  //
  // The recipient is the FEE PAYER, so the network fee is deducted
  // from their balance. Their net gain is:
  //
  //   recipient_increase = reward_amount - tx_fee
  //
  // We accept any increase >= (reward_amount - FEE_TOLERANCE).
  //
  // The contract enforces the exact reward_amount transfer, so this
  // check is belt-and-suspenders defense. If it fails after all
  // previous checks pass, something is very wrong — leave the claim
  // untouched for admin reconciliation.
  // ----------------------------------------------------------------
  const recipientIdx = accountKeys.indexOf(expectedRecipient)
  if (recipientIdx < 0) {
    return {
      ok: false,
      reason: 'RECIPIENT_NOT_IN_TX',
      detail: `expected ${expectedRecipient} not found in accountKeys`,
      safe: true,
    }
  }
  const preBalance = txInfo.meta?.preBalances?.[recipientIdx]
  const postBalance = txInfo.meta?.postBalances?.[recipientIdx]
  if (!Number.isFinite(preBalance) || !Number.isFinite(postBalance)) {
    return { ok: false, reason: 'BALANCE_NOT_AVAILABLE', safe: true }
  }
  const recipientIncrease = postBalance - preBalance
  if (recipientIncrease + RECIPIENT_INCREASE_FEE_TOLERANCE_LAMPORTS < expectedRewardAmountLamports) {
    return {
      ok: false,
      reason: 'RECIPIENT_DID_NOT_RECEIVE_REWARD',
      detail: `increase=${recipientIncrease}, expected >= ${expectedRewardAmountLamports} (with ${RECIPIENT_INCREASE_FEE_TOLERANCE_LAMPORTS} lamports fee tolerance)`,
      safe: true, // ambiguous — tx succeeded but balance doesn't add up; do NOT revert
    }
  }

  return {
    ok: true,
    instructionIndex: entry.ixIndex,
    decoded,
    feePayer,
    resolvedAccounts: {
      admin: adminOnChain,
      reward_config: configOnChain,
      reward_vault: vaultOnChain,
      recipient: recipientOnChain,
    },
    preBalance,
    postBalance,
    recipientIncrease,
  }
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

  // -------------------------------------------------------------------
  // STEP 1: Fetch the authoritative claim row from Supabase.
  //
  // The DB claim row is the source of truth for the recipient wallet,
  // points claimed, and reward amount. We do NOT trust a `wallet`
  // parameter sent by the frontend beyond using it as a sanity hint.
  // -------------------------------------------------------------------
  let claimRow
  try {
    claimRow = await fetchClaimRow(claimId)
  } catch (error) {
    console.error('[claim-confirm] fetchClaimRow failed:', error?.message || error, { claimId })
    return apiError(res, 502, 'CLAIM_FETCH_FAILED', 'Could not load the reward claim from the database.')
  }
  if (!claimRow) {
    return apiError(res, 404, 'CLAIM_NOT_FOUND', 'No reward claim was found for that claimId.')
  }

  // -------------------------------------------------------------------
  // STEP 2: Validate the claim row.
  //
  //   - claim.wallet_address must be a valid Solana PublicKey
  //   - claim.points_claimed must be > 0
  //   - claim.reward_amount must be > 0
  // -------------------------------------------------------------------
  const expectedRecipient = String(claimRow.wallet_address || '').trim()
  try {
    // Throws if the address is not a valid base58 32-byte pubkey.
    // eslint-disable-next-line no-new
    new PublicKey(expectedRecipient)
  } catch {
    return apiError(res, 500, 'CLAIM_WALLET_INVALID', 'The claim row has an invalid wallet_address.')
  }

  const expectedPointsClaimed = Math.floor(Number(claimRow.points_claimed))
  const rewardAmountSol = Number(claimRow.reward_amount)
  if (!Number.isFinite(expectedPointsClaimed) || expectedPointsClaimed <= 0) {
    return apiError(res, 400, 'INVALID_POINTS', 'The claim has no claimable points.')
  }
  if (!Number.isFinite(rewardAmountSol) || rewardAmountSol <= 0) {
    return apiError(res, 400, 'INVALID_REWARD_AMOUNT', 'The claim has no reward amount.')
  }

  // Convert SOL → lamports using the same logic as claim-prepare.
  let expectedRewardAmountLamports
  try {
    const scaledSol = Math.round(rewardAmountSol * 1_000_000_000)
    if (!Number.isSafeInteger(scaledSol) || scaledSol <= 0) {
      throw new Error('INVALID_LAMPORTS')
    }
    expectedRewardAmountLamports = scaledSol
  } catch (err) {
    console.error('[claim-confirm] SOL→lamports conversion failed:', err?.message || err, { claimId, rewardAmountSol })
    return apiError(res, 500, 'INVALID_REWARD_AMOUNT', 'The reward amount could not be converted to lamports.')
  }

  // -------------------------------------------------------------------
  // STEP 3: Derive the expected on-chain PDAs and admin (authoritative).
  //
  // The admin pubkey comes from the on-chain RewardConfig account
  // itself — not from a server-side env var. This protects against
  // admin rotation mismatches.
  // -------------------------------------------------------------------
  const [expectedRewardConfigPda] = getRewardConfigPda()
  const [expectedRewardVaultPda] = getRewardVaultPda()

  let expectedAdmin
  try {
    const programState = await getRewardsProgramState()
    expectedAdmin = programState.admin
  } catch (error) {
    console.error('[claim-confirm] getRewardsProgramState failed:', error?.message || error, { claimId })
    return apiError(res, 502, 'SOLANA_PROGRAM_STATE_UNAVAILABLE',
      'Could not read the on-chain reward program state. Try again shortly.')
  }

  console.info('[claim-confirm] verifying tx', {
    claimId,
    signature,
    expectedRecipient,
    expectedPointsClaimed,
    expectedRewardAmountLamports,
    expectedAdmin: String(expectedAdmin),
    expectedRewardConfigPda: String(expectedRewardConfigPda),
    expectedRewardVaultPda: String(expectedRewardVaultPda),
    programId: String(RONIN_REWARDS_PROGRAM_ID),
    dbClaimStatus: claimRow.status,
  })

  // -------------------------------------------------------------------
  // STEP 4: Poll Solana for the tx (up to 30s).
  // -------------------------------------------------------------------
  const connection = getRewardsConnection()
  console.info('[claim-confirm] polling Solana for tx', { claimId, signature, wallet: expectedRecipient })
  const pollResult = await pollTransaction(connection, signature)
  console.info('[claim-confirm] poll result', {
    claimId,
    signature,
    status: pollResult.status,
    hasTxInfo: Boolean(pollResult.txInfo),
  })

  if (pollResult.status === 'not_found') {
    // Tx not yet landed. Leave the claim ENTITLED — the user can retry
    // /claim-confirm later. Do NOT revert: the tx might still land.
    console.warn('[claim-confirm] tx not found on Solana (may still land)', { claimId, signature })
    return json(res, 200, {
      success: false,
      pending: true,
      claim_id: claimId,
      signature,
      message: 'The transaction has not been confirmed on Solana yet. Wait a few seconds and retry /api/rewards/claim-confirm.',
    })
  }

  // -------------------------------------------------------------------
  // STEP 5: Verify the on-chain tx.
  // -------------------------------------------------------------------
  const verification = verifyTxMatchesClaim({
    txInfo: pollResult.txInfo,
    expectedRecipient,
    expectedProgramId: RONIN_REWARDS_PROGRAM_ID,
    expectedRewardConfigPda,
    expectedRewardVaultPda,
    expectedAdmin,
    expectedClaimId: claimId,
    expectedPointsClaimed,
    expectedRewardAmountLamports,
  })

  console.info('[claim-confirm] tx verification result', {
    claimId,
    signature,
    ok: verification.ok,
    reason: verification.reason,
    detail: verification.detail,
    instructionIndex: verification.instructionIndex,
    decoded: verification.decoded,
    feePayer: verification.feePayer,
    resolvedAccounts: verification.resolvedAccounts,
    preBalance: verification.preBalance,
    postBalance: verification.postBalance,
    recipientIncrease: verification.recipientIncrease,
    safe: verification.safe,
  })

  if (!verification.ok) {
    // ACCOUNTING SAFETY (requirement #15):
    //
    //   - If `verification.safe === true` → ambiguous parsing. The tx
    //     SUCCEEDED on-chain but we could not positively confirm it
    //     represents this claim. DO NOT revert. Leave the claim
    //     ENTITLED (or PENDING_PAYOUT if mid-flow) for admin
    //     reconciliation. NEVER create the state:
    //       SOL successfully paid on-chain + DB points restored.
    //
    //   - If `verification.safe === false` → positive failure. The tx
    //     either failed on-chain OR clearly does not represent this
    //     claim (wrong program, wrong recipient, wrong claim data).
    //     Safe to revert.
    if (verification.safe) {
      console.warn('[claim-confirm] AMBIGUOUS verification — leaving claim untouched for reconciliation', {
        claimId,
        signature,
        reason: verification.reason,
        detail: verification.detail,
      })
      return apiError(res, 422, 'TX_VERIFICATION_AMBIGUOUS',
        `The on-chain transaction succeeded but verification was ambiguous (${verification.reason}). ` +
        `The claim has been left for admin reconciliation — your points were NOT restored and the payout MAY have succeeded. ` +
        `Contact support with this signature: ${signature}`)
    }

    // Positive failure — safe to revert.
    console.warn('[claim-confirm] tx verification FAILED — reverting claim', {
      claimId,
      signature,
      reason: verification.reason,
      detail: verification.detail,
    })
    await safeRevertFailedClaim(
      claimId,
      `TX_VERIFICATION_FAILED: ${verification.reason} ${verification.detail || ''}`.slice(0, 500)
    )
    return apiError(res, 422, 'TX_VERIFICATION_FAILED',
      `The on-chain transaction did not match the expected claim. Reason: ${verification.reason}. The claim has been reverted.`)
  }

  // -------------------------------------------------------------------
  // STEP 6: Tx confirmed + verified. Transition ENTITLED →
  // PENDING_PAYOUT → COMPLETED.
  // -------------------------------------------------------------------
  console.info('[claim-confirm] tx verified — marking PENDING_PAYOUT', { claimId, signature })
  try {
    await callSupabaseRpc('mark_reward_claim_pending_payout', { p_claim_id: claimId })
    console.info('[claim-confirm] mark_pending_payout done', { claimId, signature })
  } catch (error) {
    // mark_reward_claim_pending_payout is idempotent — if the claim
    // was already PENDING_PAYOUT or COMPLETED, it returns the existing
    // row. Only fail on hard errors.
    console.warn('claim-confirm mark_pending_payout RPC returned non-fatal error:',
      error?.message || error, { claimId, signature })
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
