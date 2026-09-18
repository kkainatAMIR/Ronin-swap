// Read-only Devnet verification of the deployed ronin_rewards program.
// Connects to Solana Devnet, derives the program's PDAs, and reads
// the on-chain Reward Config + Reward Vault state.
//
// No secrets required — this is pure read-only inspection.

import { Connection, PublicKey } from '@solana/web3.js'
import { createHash } from 'node:crypto'

const PROGRAM_ID = new PublicKey('FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU')
const DEVNET_RPC = 'https://api.devnet.solana.com'

// Try multiple Devnet RPC endpoints in case the public one is rate-limited.
const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC_URL,
  process.env.HELIUS_API_KEY ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : '',
  DEVNET_RPC,
].filter(Boolean)

function hashClaimId(claimId) {
  return createHash('sha256').update(Buffer.from(claimId, 'utf8')).digest()
}

async function tryRpc(endpoint) {
  const conn = new Connection(endpoint, 'confirmed')
  // Quick connectivity check
  const slot = await conn.getSlot()
  return { conn, endpoint, slot }
}

async function main() {
  console.log('=' .repeat(70))
  console.log('Devnet Read-Only Verification of ronin_rewards program')
  console.log('=' .repeat(70))
  console.log('Program ID:', PROGRAM_ID.toBase58())
  console.log()

  // Try RPC endpoints
  let conn, endpoint, lastError
  for (const ep of RPC_ENDPOINTS) {
    try {
      console.log(`Trying RPC: ${ep}`)
      const result = await tryRpc(ep)
      conn = result.conn
      endpoint = result.endpoint
      console.log(`  OK — current slot: ${result.slot}`)
      break
    } catch (e) {
      console.log(`  FAIL: ${e.message}`)
      lastError = e
    }
  }
  if (!conn) {
    console.error('\nERROR: could not connect to any Solana RPC endpoint.')
    if (lastError) console.error('Last error:', lastError.message)
    process.exit(1)
  }
  console.log(`\nUsing RPC: ${endpoint}\n`)

  // ---------------------------------------------------------------
  // STEP 1: Confirm the program exists on Devnet.
  // ---------------------------------------------------------------
  console.log('[1] Checking if program account exists on Devnet...')
  const programAccountInfo = await conn.getAccountInfo(PROGRAM_ID, 'confirmed')
  if (!programAccountInfo) {
    console.log('  FAIL: program account NOT FOUND on Devnet.')
    console.log('  → The program ID ' + PROGRAM_ID.toBase58() + ' does not exist on Devnet.')
    console.log('  → Check whether the program was deployed to Devnet or mainnet.')
    process.exit(2)
  }
  console.log(`  OK — program account exists.`)
  console.log(`    Owner:        ${programAccountInfo.owner.toBase58()}`)
  console.log(`    Lamports:     ${programAccountInfo.lamports} (rent-exempt minimum for executables)`)
  console.log(`    Data length:  ${programAccountInfo.data.length} bytes`)
  console.log(`    Executable:   ${programAccountInfo.executable}`)
  if (!programAccountInfo.executable) {
    console.log('  WARN: account exists but is NOT executable — this is not a program.')
  }

  // ---------------------------------------------------------------
  // STEP 2: Derive PDAs.
  // ---------------------------------------------------------------
  console.log('\n[2] Deriving program PDAs...')
  const [rewardConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('reward_config')],
    PROGRAM_ID
  )
  const [rewardVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('reward_vault')],
    PROGRAM_ID
  )
  console.log(`  reward_config PDA: ${rewardConfigPda.toBase58()}`)
  console.log(`  reward_vault  PDA: ${rewardVaultPda.toBase58()}`)

  // Test claim PDA derivation for a sample claim_id (to confirm SHA-256 hashing matches the program)
  const sampleClaimId = 'devnet-test-claim-001'
  const [sampleClaimPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('claim'), rewardConfigPda.toBuffer(), hashClaimId(sampleClaimId)],
    PROGRAM_ID
  )
  console.log(`  claim PDA (sample "${sampleClaimId}"): ${sampleClaimPda.toBase58()}`)

  // ---------------------------------------------------------------
  // STEP 3: Read on-chain Reward Config state.
  // ---------------------------------------------------------------
  console.log('\n[3] Reading on-chain RewardConfig state...')
  const configInfo = await conn.getAccountInfo(rewardConfigPda, 'confirmed')
  if (!configInfo) {
    console.log('  FAIL: RewardConfig PDA is NOT initialized on Devnet.')
    console.log('  → The program was deployed but initialize() was never called.')
    console.log('  → Call initialize() from the admin keypair before claiming.')
    process.exit(3)
  }
  console.log(`  OK — RewardConfig account exists.`)
  console.log(`    Owner:        ${configInfo.owner.toBase58()} (should equal program ID)`)
  console.log(`    Lamports:     ${configInfo.lamports}`)
  console.log(`    Data length:  ${configInfo.data.length} bytes`)

  // Decode the RewardConfig layout.
  // The deployed program stores (per the spec):
  //   discriminator (8 bytes, Anchor: sha256("account:RewardConfig")[0..8])
  //   admin (32 bytes PublicKey)
  //   bump (1 byte)
  //   vault_bump (1 byte)
  //   total_claimed (8 bytes u64 LE)
  //   total_claims (8 bytes u64 LE)
  //   paused (1 byte bool)
  //
  // If the deployed program's actual layout differs, we'll see wrong values
  // but the byte offsets below match the documented structure.
  const data = configInfo.data
  if (data.length < 8 + 32 + 1 + 1 + 8 + 8 + 1) {
    console.log(`  WARN: data length ${data.length} is smaller than expected (59 bytes).`)
    console.log('  → The deployed program may use a different RewardConfig layout.')
  }

  const discriminator = data.subarray(0, 8)
  const expectedDiscriminator = createHash('sha256').update('account:RewardConfig').digest().subarray(0, 8)
  const discMatch = Buffer.compare(discriminator, expectedDiscriminator) === 0
  console.log(`    discriminator: ${Buffer.from(discriminator).toString('hex')}`)
  console.log(`    expected disc: ${Buffer.from(expectedDiscriminator).toString('hex')} (sha256("account:RewardConfig")[0..8])`)
  console.log(`    disc matches:  ${discMatch}`)

  // Decode fields — be defensive about the data length
  const adminPubkey = data.length >= 40 ? new PublicKey(data.subarray(8, 40)) : null
  const bump = data.length >= 41 ? data[40] : null
  const vaultBump = data.length >= 42 ? data[41] : null
  const totalClaimed = data.length >= 50 ? data.readBigUInt64LE(42) : null
  const totalClaims = data.length >= 58 ? data.readBigUInt64LE(50) : null
  // paused is at the end — its exact offset depends on whether the program pads
  // the bool field. We'll read it from offset 58 if available, and also check
  // the last byte as a fallback.
  const pausedAt58 = data.length >= 59 ? data[58] : null
  const lastByte = data.length > 0 ? data[data.length - 1] : null

  console.log()
  console.log('  Decoded RewardConfig fields:')
  console.log(`    admin:           ${adminPubkey ? adminPubkey.toBase58() : '(unknown — data too short)'}`)
  console.log(`    bump:            ${bump}`)
  console.log(`    vault_bump:      ${vaultBump}`)
  console.log(`    total_claimed:   ${totalClaimed !== null ? totalClaimed.toString() + ' lamports' : '(unknown)'}`)
  console.log(`    total_claims:    ${totalClaims !== null ? totalClaims.toString() : '(unknown)'}`)
  console.log(`    paused (byte 58):${pausedAt58 !== null ? ' ' + Boolean(pausedAt58) : ' (unknown)'}`)
  console.log(`    last byte:       ${lastByte} (paused if 1)`)
  console.log()
  console.log(`  → On-chain admin pubkey: ${adminPubkey ? adminPubkey.toBase58() : '(could not decode)'}`)
  console.log(`    This is the pubkey whose secret key must be set as`)
  console.log(`    SOLANA_REWARDS_ADMIN_KEYPAIR or SOLANA_REWARDS_ADMIN_SECRET_KEY.`)

  // ---------------------------------------------------------------
  // STEP 4: Read reward vault balance.
  // ---------------------------------------------------------------
  console.log('\n[4] Reading reward vault balance...')
  const vaultInfo = await conn.getAccountInfo(rewardVaultPda, 'confirmed')
  if (!vaultInfo) {
    console.log('  FAIL: reward_vault PDA account does not exist on Devnet.')
    console.log('  → Either fund_vault() was never called, or the vault was drained.')
    console.log('  → Fund it with: program fund_vault() instruction, or directly')
    console.log('    transfer SOL to: ' + rewardVaultPda.toBase58())
    process.exit(4)
  }
  const vaultBalanceLamports = vaultInfo.lamports
  const vaultBalanceSol = vaultBalanceLamports / 1_000_000_000
  console.log(`  OK — reward vault exists.`)
  console.log(`    Owner:        ${vaultInfo.owner.toBase58()} (should be SystemProgram if it's a plain SOL vault)`)
  console.log(`    Balance:      ${vaultBalanceLamports} lamports`)
  console.log(`    Balance:      ${vaultBalanceSol} SOL`)
  console.log(`    Data length:  ${vaultInfo.data.length} bytes (0 for plain SOL vaults)`)

  // ---------------------------------------------------------------
  // STEP 5: Check if vault has enough for a small test claim.
  // ---------------------------------------------------------------
  // For a 100-point claim at 1000 points/SOL = 0.1 SOL = 100_000_000 lamports
  // We'll suggest a small safe test amount.
  const TEST_REWARD_LAMPORTS = 10_000_000  // 0.01 SOL — small safe test
  console.log('\n[5] Checking vault has enough Devnet SOL for a small test claim...')
  console.log(`    Test claim target: 0.01 SOL (${TEST_REWARD_LAMPORTS} lamports)`)
  if (vaultBalanceLamports >= TEST_REWARD_LAMPORTS) {
    console.log(`  OK — vault has enough SOL for a 0.01 SOL test claim.`)
    console.log(`    After test, vault would have ~${(vaultBalanceLamports - TEST_REWARD_LAMPORTS) / 1e9} SOL`)
  } else {
    console.log(`  FAIL — vault does NOT have enough Devnet SOL.`)
    console.log(`    Required:  ${TEST_REWARD_LAMPORTS} lamports (0.01 SOL)`)
    console.log(`    Available: ${vaultBalanceLamports} lamports (${vaultBalanceSol} SOL)`)
    console.log(`    → Fund the vault first by sending Devnet SOL to: ${rewardVaultPda.toBase58()}`)
    console.log(`      or by calling fund_vault() on the program.`)
    console.log(`    → Get free Devnet SOL from: https://faucet.solana.com`)
  }

  // ---------------------------------------------------------------
  // STEP 6: Check if program is paused.
  // ---------------------------------------------------------------
  console.log('\n[6] Checking paused status...')
  // Read paused from the last byte of the config data (defensive)
  const isPaused = lastByte === 1
  console.log(`    paused: ${isPaused}`)
  if (isPaused) {
    console.log('  WARN: program appears to be PAUSED. Claim calls will be rejected.')
    console.log('  → Call set_paused(false) on the program from the admin keypair.')
  } else {
    console.log('  OK — program is NOT paused.')
  }

  console.log('\n' + '=' .repeat(70))
  console.log('SUMMARY')
  console.log('=' .repeat(70))
  console.log(`Program ID:           ${PROGRAM_ID.toBase58()}`)
  console.log(`Reward Config PDA:    ${rewardConfigPda.toBase58()}`)
  console.log(`Reward Vault PDA:     ${rewardVaultPda.toBase58()}`)
  console.log(`Vault Balance:        ${vaultBalanceSol} SOL (${vaultBalanceLamports} lamports)`)
  console.log(`On-chain Admin:       ${adminPubkey ? adminPubkey.toBase58() : '(could not decode)'}`)
  console.log(`Paused:               ${isPaused}`)
  console.log(`Total Claims (on-chain): ${totalClaims !== null ? totalClaims.toString() : '(unknown)'}`)
  console.log(`Total Claimed (on-chain): ${totalClaimed !== null ? totalClaimed.toString() + ' lamports' : '(unknown)'}`)
  console.log()
  console.log('NEXT STEPS:')
  console.log('  1. Find the admin keypair whose PUBLIC KEY matches the on-chain admin above.')
  console.log('     Common locations:')
  console.log('       ~/.config/solana/id.json')
  console.log('       <anchor-program-repo>/target/deploy/ronin_rewards-keypair.json')
  console.log('       <anchor-program-repo>/target/deploy/ronin_rewards.json')
  console.log('  2. Set it as env var:')
  console.log('       SOLANA_REWARDS_ADMIN_KEYPAIR=/path/to/admin.json  (local dev)')
  console.log('       OR')
  console.log('       SOLANA_REWARDS_ADMIN_SECRET_KEY=<JSON array of 64 bytes>  (Vercel)')
  console.log('  3. Ensure the vault has enough Devnet SOL for the test (see step 5 above).')
  console.log('  4. Set sol_rewards_enabled=true and activate a season in Supabase.')
  console.log('  5. Have a test wallet with claimable Samurai Points in Supabase.')
  console.log('  6. Then POST /api/rewards/claim with the test wallet.')
}

main().catch((err) => {
  console.error('\nFATAL:', err?.message || err)
  process.exit(1)
})
