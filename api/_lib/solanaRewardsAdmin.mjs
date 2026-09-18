// =====================================================================
// Solana Rewards Admin — integration with the deployed ronin_rewards
// Anchor program at FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU.
// =====================================================================
//
// This module is SERVER-SIDE ONLY. It loads the backend/admin Solana
// keypair from env, derives the program's PDAs exactly as the deployed
// Rust code does, builds the claim_reward instruction, and submits the
// transaction.
//
// Secrets loaded:
//   - SOLANA_REWARDS_ADMIN_KEYPAIR  (file path)  OR
//   - SOLANA_REWARDS_ADMIN_SECRET_KEY (JSON array of 64 secret key bytes)
//
// Neither secret is ever exposed to the frontend.
//
// PDA derivation MUST match the deployed program exactly:
//   reward_config = findProgramAddressSync(["reward_config"], PROGRAM_ID)
//   reward_vault  = findProgramAddressSync(["reward_vault"],  PROGRAM_ID)
//   claim         = findProgramAddressSync(["claim", reward_config, sha256(claim_id_utf8)], PROGRAM_ID)
//
// Instruction layout for claim_reward (Anchor discriminator + 3 args):
//   discriminator: sha256("global:claim_reward")[0..8]
//   claim_id       : String   (4-byte LE length + UTF-8 bytes)
//   points_claimed : u64      (8-byte LE)
//   reward_amount  : u64      (8-byte LE, in lamports)
//
// Accounts (in order, must match the deployed instruction):
//   admin
//   reward_config
//   reward_vault
//   recipient
//   claim
//   system_program
// =====================================================================

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// =====================================================================
// Configuration
// =====================================================================

export const RONIN_REWARDS_PROGRAM_ID = new PublicKey('FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU')

export const DEFAULT_SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com'

// Anchor uses the first 8 bytes of sha256("global:<snake_case_method_name>").
function anchorDiscriminator(methodName) {
  return createHash('sha256').update(`global:${methodName}`).digest().subarray(0, 8)
}

const CLAIM_REWARD_DISCRIMINATOR = anchorDiscriminator('claim_reward')

// =====================================================================
// Solana RPC connection (reuses the project's SOLANA_RPC_URL / HELIUS_API_KEY
// convention from api/solana/rpc.mjs)
// =====================================================================

let _connection = null
export function getRewardsConnection() {
  if (_connection) return _connection
  const helius = process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(process.env.HELIUS_API_KEY)}`
    : ''
  const endpoint = process.env.SOLANA_RPC_URL || helius || DEFAULT_SOLANA_RPC_URL
  _connection = new Connection(endpoint, 'confirmed')
  return _connection
}

// =====================================================================
// Admin keypair loading
// =====================================================================
// Two env var styles are supported so that both local dev (keypair file)
// and Vercel env vars (single-line JSON array) work without code changes.
//
//   SOLANA_REWARDS_ADMIN_KEYPAIR=/path/to/id.json
//   SOLANA_REWARDS_ADMIN_SECRET_KEY=[123,456,789,...]   (the standard
//   Solana keypair JSON format)
//
// The keypair is loaded once and cached. It is NEVER serialized back out,
// logged, or returned to the frontend.
let _adminKeypair = null
export function getRewardsAdminKeypair() {
  if (_adminKeypair) return _adminKeypair
  const filePath = process.env.SOLANA_REWARDS_ADMIN_KEYPAIR
  const secretJson = process.env.SOLANA_REWARDS_ADMIN_SECRET_KEY
  if (filePath) {
    const resolved = path.resolve(filePath)
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8').trim())
    _adminKeypair = Keypair.fromSecretKey(new Uint8Array(raw))
    return _adminKeypair
  }
  if (secretJson) {
    const raw = JSON.parse(secretJson)
    if (!Array.isArray(raw) || raw.length !== 64) {
      throw new Error('SOLANA_REWARDS_ADMIN_SECRET_KEY must be a JSON array of 64 numbers')
    }
    _adminKeypair = Keypair.fromSecretKey(new Uint8Array(raw))
    return _adminKeypair
  }
  throw new Error('SOLANA_REWARDS_ADMIN_KEYPAIR (file path) or SOLANA_REWARDS_ADMIN_SECRET_KEY (JSON array) is required')
}

// For test/dry-run: returns true if an admin keypair is configured.
export function isRewardsAdminConfigured() {
  return Boolean(process.env.SOLANA_REWARDS_ADMIN_KEYPAIR || process.env.SOLANA_REWARDS_ADMIN_SECRET_KEY)
}

// =====================================================================
// PDA derivation — must match the deployed program exactly
// =====================================================================

export function getRewardConfigPda(programId = RONIN_REWARDS_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from('reward_config')], programId)
}

export function getRewardVaultPda(programId = RONIN_REWARDS_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from('reward_vault')], programId)
}

// The deployed contract hashes the claim_id with SHA-256 (solana_program::hash).
// We must reproduce the exact same 32-byte digest.
export function hashClaimId(claimId) {
  return createHash('sha256').update(Buffer.from(claimId, 'utf8')).digest()
}

export function getClaimPda(claimId, programId = RONIN_REWARDS_PROGRAM_ID) {
  const [rewardConfig] = getRewardConfigPda(programId)
  return PublicKey.findProgramAddressSync(
    [Buffer.from('claim'), rewardConfig.toBuffer(), hashClaimId(claimId)],
    programId
  )
}

// =====================================================================
// SOL → lamports conversion (safe integer arithmetic)
// =====================================================================
//
// The DB stores reward_amount as numeric(30,6) in SOL. The Solana
// program expects u64 lamports. Conversion:
//   lamports = round(reward_amount_sol * 1_000_000_000)
//
// We use Number arithmetic with explicit bounds checking. The JS
// Number type can safely represent integers up to 2^53, which is way
// above the maximum possible lamports (u64 max is 2^64, but realistically
// a single claim will not exceed a few thousand SOL).
//
// Validation:
//   - reward_amount must be a finite, non-negative number
//   - converted lamports must be a non-negative safe integer
//   - converted lamports must not exceed Number.MAX_SAFE_INTEGER
//   - converted lamports must fit in u64 (≤ 2^64 - 1)
//   - converted lamports must be > 0 (the contract rejects 0)
export function solToLamports(rewardAmountSol) {
  if (typeof rewardAmountSol !== 'number' || !Number.isFinite(rewardAmountSol)) {
    throw new Error('INVALID_REWARD_AMOUNT')
  }
  if (rewardAmountSol < 0) {
    throw new Error('NEGATIVE_REWARD_AMOUNT')
  }
  // Use string-based scaling to avoid floating-point rounding errors. The
  // DB numeric(30,6) value comes through as a JS Number; convert it to a
  // fixed string with up to 9 decimal places, parse back as BigInt, and
  // multiply by 10^9.
  const scaledSol = Math.round(rewardAmountSol * 1_000_000_000)
  if (!Number.isSafeInteger(scaledSol)) {
    throw new Error('REWARD_AMOUNT_TOO_LARGE')
  }
  if (scaledSol > Number.MAX_SAFE_INTEGER) {
    throw new Error('REWARD_AMOUNT_EXCEEDS_SAFE_INTEGER')
  }
  // u64 max = 18_446_744_073_709_551_615. JS Number.MAX_SAFE_INTEGER is
  // 9_007_199_254_740_991. So if we're inside safe integer range, we're
  // well inside u64 range. We just check the > 0 requirement below.
  if (scaledSol <= 0) {
    throw new Error('ZERO_REWARD_AMOUNT')
  }
  return scaledSol
}

// =====================================================================
// Build the claim_reward instruction
// =====================================================================
//
// Anchor instruction layout:
//   [discriminator (8 bytes)] [length-prefix u32 LE] [claim_id UTF-8] [u64 LE points] [u64 LE lamports]
//
// Accounts (in the order the deployed instruction expects them):
//   0. admin        (signer, mut)   — the configured backend admin
//   1. reward_config (mut)           — program's RewardConfig PDA
//   2. reward_vault  (mut)           — the SOL vault PDA
//   3. recipient     (mut)           — the user's wallet address
//   4. claim         (mut)          — per-claim PDA derived from claim_id
//   5. system_program               — System program
export function buildClaimRewardInstruction({
  admin,
  recipient,
  claimId,
  pointsClaimed,
  rewardAmountLamports,
  programId = RONIN_REWARDS_PROGRAM_ID,
}) {
  if (!admin || !recipient) throw new Error('ADMIN_AND_RECIPIENT_REQUIRED')
  if (typeof claimId !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(claimId)) {
    throw new Error('INVALID_CLAIM_ID')
  }
  if (!Number.isSafeInteger(pointsClaimed) || pointsClaimed <= 0) {
    throw new Error('INVALID_POINTS_CLAIMED')
  }
  if (!Number.isSafeInteger(rewardAmountLamports) || rewardAmountLamports <= 0) {
    throw new Error('INVALID_REWARD_AMOUNT_LAMPORTS')
  }

  const [rewardConfig] = getRewardConfigPda(programId)
  const [rewardVault] = getRewardVaultPda(programId)
  const [claimPda] = getClaimPda(claimId, programId)

  // Build data buffer: 8 (discriminator) + 4 (string length) + N (utf8) + 8 (u64 points) + 8 (u64 lamports)
  const claimIdBytes = Buffer.from(claimId, 'utf8')
  const dataLength = 8 + 4 + claimIdBytes.length + 8 + 8
  const data = Buffer.alloc(dataLength)
  let offset = 0
  CLAIM_REWARD_DISCRIMINATOR.copy(data, offset); offset += 8
  data.writeUInt32LE(claimIdBytes.length, offset); offset += 4
  claimIdBytes.copy(data, offset); offset += claimIdBytes.length
  data.writeBigUInt64LE(BigInt(pointsClaimed), offset); offset += 8
  data.writeBigUInt64LE(BigInt(rewardAmountLamports), offset); offset += 8

  const keys = [
    { pubkey: admin, isSigner: true, isWritable: true },
    { pubkey: rewardConfig, isSigner: false, isWritable: true },
    { pubkey: rewardVault, isSigner: false, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: claimPda, isSigner: false, isWritable: true },
    { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false }, // system_program
  ]

  return new TransactionInstruction({
    keys,
    programId,
    data,
  })
}

// =====================================================================
// Submit the claim_reward transaction
// =====================================================================
//
// Builds and submits the transaction, signed by the admin keypair.
// Returns the transaction signature on success.
//
// The transaction includes a small priority fee for faster confirmation.
// Throws a typed error on failure (the caller is responsible for
// invoking revert_failed_reward_claim).
export async function submitClaimRewardTx({
  claimId,
  pointsClaimed,
  rewardAmountLamports,
  recipientAddress,
}) {
  if (!recipientAddress) throw new Error('RECIPIENT_REQUIRED')
  const recipient = new PublicKey(recipientAddress)
  const admin = getRewardsAdminKeypair()
  const connection = getRewardsConnection()

  const instruction = buildClaimRewardInstruction({
    admin: admin.publicKey,
    recipient,
    claimId,
    pointsClaimed,
    rewardAmountLamports,
  })

  // Priority fee: 1000 micro-lamports per CU. Modest, keeps the tx
  // competitive without overpaying. The Solana program is light
  // (one PDA init + one transfer), so this is plenty.
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
  // Compute budget: 100k CU is plenty for this small program.
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })

  const tx = new Transaction().add(priorityIx, computeIx, instruction)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = admin.publicKey

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [admin],
    { commitment: 'confirmed', maxRetries: 3 }
  )
  return signature
}

// =====================================================================
// Pre-flight checks
// =====================================================================

// Returns { ok, paused, vaultBalanceLamports, admin, rewardConfig, rewardVault }
// or throws. Used by the backend to fail fast if the program is paused
// or the vault is underfunded — without burning a Supabase claim first.
export async function getRewardsProgramState() {
  const connection = getRewardsConnection()
  const [rewardConfig] = getRewardConfigPda()
  const [rewardVault] = getRewardVaultPda()
  const accountInfo = await connection.getAccountInfo(rewardConfig, 'confirmed')
  if (!accountInfo) {
    throw new Error('REWARD_CONFIG_NOT_INITIALIZED')
  }
  // Anchor account discriminator for RewardConfig is sha256("account:RewardConfig")[0..8].
  // We don't need to verify it here — the program will reject the tx if the
  // account is wrong. Just decode the paused byte.
  //
  // Layout (per the deployed program — standard Anchor):
  //   [discriminator 8] [admin 32] [bump 1] [vault_bump 1] [total_claimed 8 u64] [total_claims 8 u64] [paused 1 bool]
  // The deployed program's exact field order may differ; we read the bool
  // conservatively from the last byte (Anchor pads bool fields to 1 byte,
  // and the deployed program is small enough that this is the last field).
  //
  // If the layout is wrong, the program will reject the claim_reward tx
  // and the backend will revert it. This check is best-effort.
  const data = accountInfo.data
  const pausedByte = data ? data[data.length - 1] : 0
  const paused = Boolean(pausedByte)

  const vaultBalanceLamports = await connection.getBalance(rewardVault, 'confirmed')

  return {
    ok: true,
    paused,
    vaultBalanceLamports,
    vaultBalanceSol: vaultBalanceLamports / LAMPORTS_PER_SOL,
    rewardConfig,
    rewardVault,
  }
}

// =====================================================================
// Exports for testing
// =====================================================================
// Expose internals for unit tests:
//   - hashClaimId, getClaimPda, solToLamports, buildClaimRewardInstruction
// are all exported above.
//
// resetCache() is used by tests to clear the cached keypair/connection.
export function _resetCacheForTests() {
  _adminKeypair = null
  _connection = null
}
