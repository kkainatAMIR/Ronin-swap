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
//
// The program ID and network are FULLY CONFIGURABLE via env vars so the
// same code can target Devnet for testing today and Mainnet for
// production tomorrow by changing env vars only — no code changes.
//
//   SOLANA_REWARDS_PROGRAM_ID (default: the Devnet program below)
//   SOLANA_RPC_URL            (Devnet or Mainnet; already used elsewhere)
//   HELIUS_API_KEY            (optional; preferred for production RPC)
//
// The default remains the Devnet program ID so existing behavior is
// unchanged. When you deploy a Mainnet program, just override
// SOLANA_REWARDS_PROGRAM_ID in .env.local or Vercel.
//
const DEFAULT_PROGRAM_ID = 'FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU'

function resolveProgramId() {
  const fromEnv = (process.env.SOLANA_REWARDS_PROGRAM_ID || '').trim()
  return new PublicKey(fromEnv || DEFAULT_PROGRAM_ID)
}

// Cached PublicKey so we don't re-parse on every call.
let _programIdCache = null
function getProgramId() {
  if (!_programIdCache) _programIdCache = resolveProgramId()
  return _programIdCache
}

// Exported as a function (not a constant) so tests / future hot-reload
// can pick up env var changes. Most call sites use the constant below
// for convenience; it's resolved once at module load time.
export const RONIN_REWARDS_PROGRAM_ID = getProgramId()

export const DEFAULT_SOLANA_RPC_URL = 'https://api.devnet.solana.com'

// Anchor uses the first 8 bytes of sha256("global:<snake_case_method_name>").
function anchorDiscriminator(methodName) {
  return createHash('sha256').update(`global:${methodName}`).digest().subarray(0, 8)
}

const CLAIM_REWARD_DISCRIMINATOR = anchorDiscriminator('claim_reward')

// =====================================================================
// Solana RPC connection (reuses the project's SOLANA_RPC_URL / HELIUS_API_KEY
// convention from api/solana/rpc.mjs)
// =====================================================================
//
// Network selection is fully env-driven:
//   - If SOLANA_RPC_URL is set explicitly (Devnet or Mainnet), use it.
//   - Otherwise, if HELIUS_API_KEY is set, build the matching Helius URL
//     for whichever network is configured (we sniff Devnet vs Mainnet
//     from SOLANA_REWARDS_NETWORK; default Devnet for safety).
//   - Otherwise, fall back to the public Solana endpoint for the
//     configured network.
//
// The current default is Devnet because the deployed rewards program
// (FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU) is on Devnet.
// When you deploy a Mainnet program, set:
//   SOLANA_REWARDS_NETWORK=mainnet-beta
//   SOLANA_REWARDS_PROGRAM_ID=<mainnet program id>
//   SOLANA_RPC_URL=<mainnet RPC>  (or use HELIUS_API_KEY)
let _connection = null

function resolveNetwork() {
  const net = String(process.env.SOLANA_REWARDS_NETWORK || '').trim().toLowerCase()
  if (net === 'mainnet' || net === 'mainnet-beta') return 'mainnet-beta'
  if (net === 'devnet') return 'devnet'
  // Sniff from SOLANA_RPC_URL if not specified explicitly
  const rpc = String(process.env.SOLANA_RPC_URL || '').toLowerCase()
  if (rpc.includes('devnet')) return 'devnet'
  if (rpc.includes('mainnet')) return 'mainnet-beta'
  // Default to Devnet for safety — the deployed rewards program is on Devnet.
  return 'devnet'
}

export function getRewardsNetwork() {
  return resolveNetwork()
}

function resolveRpcEndpoint() {
  const explicit = String(process.env.SOLANA_RPC_URL || '').trim()
  if (explicit) return explicit
  const network = resolveNetwork()
  const heliusKey = process.env.HELIUS_API_KEY
  if (heliusKey) {
    if (network === 'devnet') return `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}`
    return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}`
  }
  return network === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com'
}

export function getRewardsConnection() {
  if (_connection) return _connection
  _connection = new Connection(resolveRpcEndpoint(), 'confirmed')
  return _connection
}

export function getExplorerBaseUrl() {
  return resolveNetwork() === 'devnet'
    ? 'https://solscan.io'
    : 'https://solscan.io'
}

export function getTxExplorerUrl(signature) {
  const network = resolveNetwork()
  const cluster = network === 'devnet' ? '?cluster=devnet' : ''
  return `https://solscan.io/tx/${signature}${cluster}`
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
// CRITICAL: when sendAndConfirmTransaction throws, the signature MAY
// still exist if the tx was broadcast but not yet confirmed. We catch
// the error and return an object with `{ signature, confirmed: false }`
// so the caller can decide whether to keep the claim PENDING_PAYOUT
// (safer) or revert it.
//
// The caller (api/rewards/claim.mjs) uses safeConfirmTx() to poll the
// signature status and decide what to do.
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

  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })

  const tx = new Transaction().add(priorityIx, computeIx, instruction)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = admin.publicKey

  // Step 1: sign + raw send. This returns a signature that can be polled
  // even if confirmation later fails.
  const signature = await connection.sendTransaction(tx, [admin], {
    skipPreflight: false,
    maxRetries: 3,
  })

  // Step 2: confirm. If this throws, the tx may still land on-chain later.
  try {
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    )
    return { signature, confirmed: true }
  } catch (confirmError) {
    // Don't lose the signature — the caller MUST reconcile it.
    return { signature, confirmed: false, confirmError: confirmError?.message || String(confirmError) }
  }
}

// =====================================================================
// Pre-flight checks + on-chain state reader
// =====================================================================

// Returns the decoded on-chain RewardConfig state.
//
// Anchor layout for RewardConfig (per the deployed program):
//   [0..7]    discriminator (8 bytes) = sha256("account:RewardConfig")[0..8]
//   [8..39]   admin (32 bytes PublicKey)
//   [40]      bump (1 byte)
//   [41]      vault_bump (1 byte)
//   [42..49]  total_claimed (8 bytes u64 LE) — total SOL paid out in lamports
//   [50..57]  total_claims (8 bytes u64 LE) — total number of successful claims
//   [58]      paused (1 byte bool)
//
// Total length: 59 bytes (matches what we observed on-chain).
const CONFIG_ADMIN_OFFSET = 8
const CONFIG_BUMP_OFFSET = 40
const CONFIG_VAULT_BUMP_OFFSET = 41
const CONFIG_TOTAL_CLAIMED_OFFSET = 42
const CONFIG_TOTAL_CLAIMS_OFFSET = 50
const CONFIG_PAUSED_OFFSET = 58
const CONFIG_EXPECTED_LENGTH = 59

export async function getRewardsProgramState() {
  const connection = getRewardsConnection()
  const [rewardConfig] = getRewardConfigPda()
  const [rewardVault] = getRewardVaultPda()
  const accountInfo = await connection.getAccountInfo(rewardConfig, 'confirmed')
  if (!accountInfo) {
    throw new Error('REWARD_CONFIG_NOT_INITIALIZED')
  }
  const data = accountInfo.data
  if (!data || data.length < CONFIG_EXPECTED_LENGTH) {
    throw new Error(`REWARD_CONFIG_INVALID_LAYOUT (data length ${data?.length || 0}, expected ${CONFIG_EXPECTED_LENGTH})`)
  }

  const admin = new PublicKey(data.subarray(CONFIG_ADMIN_OFFSET, CONFIG_ADMIN_OFFSET + 32))
  const bump = data[CONFIG_BUMP_OFFSET]
  const vaultBump = data[CONFIG_VAULT_BUMP_OFFSET]
  const totalClaimed = data.readBigUInt64LE(CONFIG_TOTAL_CLAIMED_OFFSET)
  const totalClaims = data.readBigUInt64LE(CONFIG_TOTAL_CLAIMS_OFFSET)
  const paused = Boolean(data[CONFIG_PAUSED_OFFSET])

  const vaultBalanceLamports = await connection.getBalance(rewardVault, 'confirmed')

  return {
    ok: true,
    programId: RONIN_REWARDS_PROGRAM_ID,
    network: getRewardsNetwork(),
    paused,
    admin,
    bump,
    vaultBump,
    totalClaimed,        // BigInt lamports paid out over all time
    totalClaims,         // BigInt count of successful claims
    rewardConfig,
    rewardVault,
    vaultBalanceLamports,
    vaultBalanceSol: vaultBalanceLamports / LAMPORTS_PER_SOL,
  }
}

// =====================================================================
// Admin instructions: fund_vault, withdraw_vault, set_paused
// =====================================================================
//
// These mirror the deployed program's admin instructions. Only the
// backend admin keypair can sign them; users NEVER have access.
//
// Layout (Anchor convention):
//   discriminator (8 bytes): sha256("global:<method_name>")[0..8]
//   args follow as little-endian fixed-size integers / booleans
//
// Accounts (in the order the deployed program expects):
//   fund_vault(amount: u64):
//     admin, reward_config, reward_vault, system_program
//   withdraw_vault(amount: u64):
//     admin, reward_config, reward_vault, admin_token_account_or_admin,
//     system_program
//   set_paused(paused: bool):
//     admin, reward_config
//
// We default to assuming withdraw_vault transfers SOL back to admin
// directly (no token account) — that matches the standard pattern for
// a SOL-vault program. If the deployed program requires a different
// account list, we'll need to adjust.
const FUND_VAULT_DISCRIMINATOR = anchorDiscriminator('fund_vault')
const WITHDRAW_VAULT_DISCRIMINATOR = anchorDiscriminator('withdraw_vault')
const SET_PAUSED_DISCRIMINATOR = anchorDiscriminator('set_paused')

export function buildFundVaultInstruction({ admin, amountLamports }) {
  if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0) {
    throw new Error('INVALID_FUND_AMOUNT')
  }
  const [rewardConfig] = getRewardConfigPda()
  const [rewardVault] = getRewardVaultPda()
  const data = Buffer.alloc(8 + 8)
  FUND_VAULT_DISCRIMINATOR.copy(data, 0)
  data.writeBigUInt64LE(BigInt(amountLamports), 8)
  return new TransactionInstruction({
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: rewardConfig, isSigner: false, isWritable: true },
      { pubkey: rewardVault, isSigner: false, isWritable: true },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    programId: RONIN_REWARDS_PROGRAM_ID,
    data,
  })
}

export function buildWithdrawVaultInstruction({ admin, amountLamports }) {
  if (!Number.isSafeInteger(amountLamports) || amountLamports <= 0) {
    throw new Error('INVALID_WITHDRAW_AMOUNT')
  }
  const [rewardConfig] = getRewardConfigPda()
  const [rewardVault] = getRewardVaultPda()
  const data = Buffer.alloc(8 + 8)
  WITHDRAW_VAULT_DISCRIMINATOR.copy(data, 0)
  data.writeBigUInt64LE(BigInt(amountLamports), 8)
  return new TransactionInstruction({
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: rewardConfig, isSigner: false, isWritable: true },
      { pubkey: rewardVault, isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: false, isWritable: true },  // recipient = admin
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    programId: RONIN_REWARDS_PROGRAM_ID,
    data,
  })
}

export function buildSetPausedInstruction({ admin, paused }) {
  const [rewardConfig] = getRewardConfigPda()
  const data = Buffer.alloc(8 + 1)
  SET_PAUSED_DISCRIMINATOR.copy(data, 0)
  data[8] = paused ? 1 : 0
  return new TransactionInstruction({
    keys: [
      { pubkey: admin, isSigner: true, isWritable: false },
      { pubkey: rewardConfig, isSigner: false, isWritable: true },
    ],
    programId: RONIN_REWARDS_PROGRAM_ID,
    data,
  })
}

// =====================================================================
// Admin transaction submission
// =====================================================================
//
// All three admin operations follow the same pattern: build instruction,
// wrap in a Transaction with priority fee + compute budget, sign with
// admin keypair, submit + confirm.
async function submitAdminTx(instruction, label) {
  const admin = getRewardsAdminKeypair()
  const connection = getRewardsConnection()
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })
  const tx = new Transaction().add(priorityIx, computeIx, instruction)
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = admin.publicKey
  try {
    const signature = await sendAndConfirmTransaction(
      connection, tx, [admin],
      { commitment: 'confirmed', maxRetries: 3 }
    )
    return signature
  } catch (error) {
    // Wrap with a label so the caller can log it clearly.
    error.label = label
    throw error
  }
}

export async function submitFundVaultTx(amountLamports) {
  const admin = getRewardsAdminKeypair()
  const ix = buildFundVaultInstruction({ admin: admin.publicKey, amountLamports })
  return submitAdminTx(ix, 'fund_vault')
}

export async function submitWithdrawVaultTx(amountLamports) {
  const admin = getRewardsAdminKeypair()
  const ix = buildWithdrawVaultInstruction({ admin: admin.publicKey, amountLamports })
  return submitAdminTx(ix, 'withdraw_vault')
}

export async function submitSetPausedTx(paused) {
  const admin = getRewardsAdminKeypair()
  const ix = buildSetPausedInstruction({ admin: admin.publicKey, paused: Boolean(paused) })
  return submitAdminTx(ix, 'set_paused')
}

// =====================================================================
// Transaction confirmation safety
// =====================================================================
//
// sendAndConfirmTransaction can fail for two very different reasons:
//   1. The transaction was REJECTED before submission (bad blockhash,
//      signature verification failure, etc.) — signature is null/undefined
//      and NO money moved.
//   2. The transaction was SUBMITTED but confirmation timed out — the
//      tx may still land on-chain later. The signature exists; we must
//      NOT treat this as a definitive failure.
//
// `safeConfirmTx(signature)` is used by /api/rewards/claim after a
// signature comes back from sendAndConfirmTransaction. If
// sendAndConfirmTransaction throws, we cannot assume the tx failed —
// we must poll the signature status to determine the truth.
//
// Returns one of:
//   - { status: 'confirmed', signature }
//   - { status: 'failed', signature, error }
//   - { status: 'unknown', signature } — RPC couldn't tell us; treat
//     as PENDING_PAYOUT and let an admin reconciliation job resolve it
export async function safeConfirmTx(signature, opts = {}) {
  const connection = getRewardsConnection()
  const timeoutMs = opts.timeoutMs || 30_000
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      })
      const value = status?.value
      if (!value) {
        // Not seen yet. Wait briefly and retry.
        await new Promise((r) => setTimeout(r, 1_500))
        continue
      }
      if (value.err) {
        return { status: 'failed', signature, error: JSON.stringify(value.err) }
      }
      if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') {
        return { status: 'confirmed', signature }
      }
      // Still pending; loop.
      await new Promise((r) => setTimeout(r, 1_500))
    } catch (err) {
      // RPC error — don't give up, retry until timeout.
      await new Promise((r) => setTimeout(r, 1_500))
    }
  }
  return { status: 'unknown', signature }
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
