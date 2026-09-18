#!/usr/bin/env node
// =====================================================================
// Read-only verification of a deployed Ronin Rewards program.
// Works against any cluster (Devnet, Mainnet) — pass the RPC URL.
//
// Usage:
//   node scripts/verify-program.mjs                        # uses SOLANA_RPC_URL env var
//   node scripts/verify-program.mjs https://api.devnet.solana.com
//   node scripts/verify-program.mjs https://api.mainnet-beta.solana.com
//
// This is SAFE — it only READS on-chain state. It does not submit any
// transactions. Useful for verifying deployment without running the
// full deploy script.
// =====================================================================

import { Connection, PublicKey } from '@solana/web3.js'

const PROGRAM_ID = new PublicKey('FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU')
const rpcUrl = process.argv[2] || process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com'

console.log('='.repeat(70))
console.log('Ronin Rewards — on-chain verification')
console.log('='.repeat(70))
console.log('Program ID:', PROGRAM_ID.toBase58())
console.log('RPC URL:   ', rpcUrl)
console.log('')

const conn = new Connection(rpcUrl, 'confirmed')

const [rewardConfig] = PublicKey.findProgramAddressSync(
  [Buffer.from('reward_config')], PROGRAM_ID
)
const [rewardVault] = PublicKey.findProgramAddressSync(
  [Buffer.from('reward_vault')], PROGRAM_ID
)

console.log('Derived PDAs:')
console.log('  reward_config:', rewardConfig.toBase58())
console.log('  reward_vault :', rewardVault.toBase58())
console.log('')

const programInfo = await conn.getAccountInfo(PROGRAM_ID, 'confirmed')
if (!programInfo) {
  console.log('❌ Program does NOT exist on this cluster.')
  process.exit(1)
}
console.log('Program account:')
console.log('  Owner:      ', programInfo.owner.toBase58(), '(should be BPFLoaderUpgradeable)')
console.log('  Executable: ', programInfo.executable)
console.log('  Lamports:   ', programInfo.lamports, '(rent-exempt minimum)')
console.log('  Data length:', programInfo.data.length, 'bytes')
console.log('')

const configInfo = await conn.getAccountInfo(rewardConfig, 'confirmed')
if (!configInfo) {
  console.log('ℹ️  RewardConfig PDA does NOT exist on this cluster.')
  console.log('   → The program is deployed but initialize() has not been called yet.')
  console.log('   → Run scripts/initialize-mainnet.sh to create it.')
  process.exit(0)
}

// Decode RewardConfig (Anchor layout):
// [0..7] discriminator = sha256("account:RewardConfig")[0..8]
// [8..39] admin (32 bytes)
// [40] bump (1 byte)
// [41] vault_bump (1 byte)
// [42..49] total_claimed (u64 LE)
// [50..57] total_claims (u64 LE)
// [58] paused (bool)
const data = configInfo.data
const admin = new PublicKey(data.subarray(8, 40))
const bump = data[40]
const vaultBump = data[41]
const totalClaimed = data.readBigUInt64LE(42)
const totalClaims = data.readBigUInt64LE(50)
const paused = Boolean(data[58])

console.log('RewardConfig PDA (initialized):')
console.log('  Admin:        ', admin.toBase58())
console.log('  Bump:         ', bump)
console.log('  Vault bump:   ', vaultBump)
console.log('  Total claimed:', totalClaimed.toString(), 'lamports (' + (Number(totalClaimed) / 1e9) + ' SOL)')
console.log('  Total claims: ', totalClaims.toString())
console.log('  Paused:       ', paused)
console.log('')

const vaultInfo = await conn.getAccountInfo(rewardVault, 'confirmed')
if (!vaultInfo) {
  console.log('❌ RewardVault PDA does NOT exist on this cluster.')
  process.exit(1)
}
console.log('RewardVault PDA:')
console.log('  Owner:   ', vaultInfo.owner.toBase58())
console.log('  Balance: ', vaultInfo.lamports, 'lamports (' + (vaultInfo.lamports / 1e9) + ' SOL)')
console.log('')

console.log('='.repeat(70))
console.log('✅ Verification complete.')
console.log('='.repeat(70))
