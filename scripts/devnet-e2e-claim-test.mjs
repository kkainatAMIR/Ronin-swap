#!/usr/bin/env node
// =====================================================================
// REAL END-TO-END DEVNET CLAIM TEST
// =====================================================================
// Run this LOCALLY with your env vars set. It performs the complete
// flow described in the user's verification checklist:
//
//   7.  Real POST /api/rewards/claim with a real Devnet wallet
//   8.  Small safe test reward (0.01 SOL = 10M lamports)
//   9.  Verify the transaction on Devnet (recipient, claim PDA, fields)
//   10. Verify Supabase after the transaction
//   11. Attempt the SAME claim_id again — must NOT double-payout
//   12. Attempt to claim after points consumed — must be rejected
//   13. Verify final balances
//
// USAGE:
//
//   1. Set env vars in your .env.local (or export them in the shell):
//
//        SUPABASE_URL=https://your-project.supabase.co
//        SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
//        SOLANA_RPC_URL=https://api.devnet.solana.com
//        SOLANA_REWARDS_ADMIN_KEYPAIR=/path/to/admin-keypair.json
//          -- OR --
//        SOLANA_REWARDS_ADMIN_SECRET_KEY=[123,456,...,789]
//
//      Optional: TEST_WALLET=<solana base58 address>  (a wallet that
//      has claimable Samurai Points in your Supabase)
//
//   2. Run:
//
//        node scripts/devnet-e2e-claim-test.mjs
//
//   3. Paste the OUTPUT back to me. Output contains only public keys,
//      signatures, and balances — NO secret keys.
// =====================================================================

import 'dotenv/config'  // loads .env.local automatically
import { Connection, PublicKey } from '@solana/web3.js'
import { createHash } from 'node:crypto'

const PROGRAM_ID = new PublicKey('FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU')
const DEVNET_RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com'

// =====================================================================
// Helpers
// =====================================================================

function log(...args) { console.log(...args) }
function step(n, title) { console.log('\n' + '='.repeat(70) + `\n[${n}] ${title}\n` + '='.repeat(70)) }
function pass(msg) { console.log('  ✅ ' + msg) }
function fail(msg) { console.log('  ❌ ' + msg) }
function info(msg) { console.log('     ' + msg) }

function hashClaimId(claimId) {
  return createHash('sha256').update(Buffer.from(claimId, 'utf8')).digest()
}

async function callSupabase(name, params) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/${name}`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
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
    const err = new Error(`Supabase RPC ${name} failed: HTTP ${response.status}`)
    err.body = body
    err.status = response.status
    throw err
  }
  return Array.isArray(body) ? body[0] : body
}

async function callBackendClaim(wallet, claimId, pointsToClaim) {
  const response = await fetch('http://localhost:3000/api/rewards/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet, claimId, pointsToClaim }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: response.status, body }
}

// =====================================================================
// MAIN
// =====================================================================

async function main() {
  console.log('REAL END-TO-END DEVNET CLAIM TEST')
  console.log('Program ID:', PROGRAM_ID.toBase58())
  console.log('RPC:       ', DEVNET_RPC)

  // -----------------------------------------------------------------
  // Pre-flight: verify env vars are set
  // -----------------------------------------------------------------
  step(0, 'Pre-flight: env var check')
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
  const hasKeypairFile = Boolean(process.env.SOLANA_REWARDS_ADMIN_KEYPAIR)
  const hasKeypairSecret = Boolean(process.env.SOLANA_REWARDS_ADMIN_SECRET_KEY)
  if (!hasKeypairFile && !hasKeypairSecret) {
    required.push('SOLANA_REWARDS_ADMIN_KEYPAIR or SOLANA_REWARDS_ADMIN_SECRET_KEY')
  }
  const missing = required.filter(v => !process.env[v])
  if (missing.length > 0) {
    fail('Missing required env vars: ' + missing.join(', '))
    console.log('\nSet them in .env.local or export in your shell:')
    console.log('  SUPABASE_URL=...')
    console.log('  SUPABASE_SERVICE_ROLE_KEY=...')
    console.log('  SOLANA_REWARDS_ADMIN_KEYPAIR=/path/to/admin.json')
    console.log('    OR')
    console.log('  SOLANA_REWARDS_ADMIN_SECRET_KEY=[123,...,64 numbers]')
    process.exit(1)
  }
  pass('All required env vars are set.')

  // Test wallet: either TEST_WALLET env var, or auto-generate a new keypair.
  // If auto-generated, the script CANNOT receive the SOL (we don't have the
  // recipient's keypair), but the claim flow itself will still work because
  // the program transfers SOL to the recipient address whether or not we
  // control that address.
  let testWallet = process.env.TEST_WALLET
  if (!testWallet) {
    fail('TEST_WALLET env var is not set.')
    info('This must be a Solana wallet address that has claimable Samurai Points in your Supabase.')
    info('The wallet does NOT need to be controlled — the program pays SOL to whatever address is in the DB.')
    info('Set it like: TEST_WALLET=<base58 address> in your .env.local')
    process.exit(1)
  }
  pass(`Test wallet: ${testWallet}`)

  // -----------------------------------------------------------------
  // STEP 7-pre: Read on-chain state to know "before" snapshot
  // -----------------------------------------------------------------
  step(7, 'Pre-claim: read on-chain state and Supabase state')

  const conn = new Connection(DEVNET_RPC, 'confirmed')
  const [rewardConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('reward_config')], PROGRAM_ID
  )
  const [rewardVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('reward_vault')], PROGRAM_ID
  )

  info(`reward_config PDA: ${rewardConfigPda.toBase58()}`)
  info(`reward_vault  PDA: ${rewardVaultPda.toBase58()}`)

  // Read vault balance BEFORE
  const vaultBefore = await conn.getBalance(rewardVaultPda, 'confirmed')
  info(`Vault balance BEFORE: ${vaultBefore / 1e9} SOL (${vaultBefore} lamports)`)

  // Read recipient balance BEFORE
  const recipientBefore = await conn.getBalance(new PublicKey(testWallet), 'confirmed')
  info(`Recipient balance BEFORE: ${recipientBefore / 1e9} SOL (${recipientBefore} lamports)`)

  // Read RewardConfig state
  const configInfo = await conn.getAccountInfo(rewardConfigPda, 'confirmed')
  if (!configInfo) {
    fail('RewardConfig PDA not initialized on Devnet.')
    process.exit(2)
  }
  const data = configInfo.data
  const adminOnChain = new PublicKey(data.subarray(8, 40))
  const totalClaimsBefore = data.readBigUInt64LE(50)
  const totalClaimedBefore = data.readBigUInt64LE(42)
  info(`On-chain admin: ${adminOnChain.toBase58()}`)
  info(`Total claims BEFORE: ${totalClaimsBefore.toString()}`)
  info(`Total claimed BEFORE: ${totalClaimedBefore.toString()} lamports`)

  // Read Supabase state
  const balance = await callSupabase('get_wallet_reward_balance', { p_wallet_address: testWallet })
  info(`Supabase earned_points:  ${balance.earned_points}`)
  info(`Supabase claimed_points: ${balance.claimed_points}`)
  info(`Supabase claimable_points: ${balance.claimable_points}`)
  info(`Supabase rewards_enabled: ${balance.rewards_enabled}`)
  info(`Supabase has_active_season: ${balance.has_active_season} (id: ${balance.active_season_id})`)
  info(`Supabase reward_asset: ${balance.reward_asset}`)
  info(`Supabase reward_points_per_unit: ${balance.reward_points_per_unit}`)

  if (!balance.rewards_enabled) {
    fail('Supabase sol_rewards_enabled is FALSE. Enable it first:')
    info('PATCH /api/admin/dashboard?resource=settings body { "sol_rewards_enabled": true }')
    process.exit(3)
  }
  if (!balance.has_active_season) {
    fail('Supabase has no active Samurai season. Activate one first.')
    process.exit(3)
  }
  if (Number(balance.claimable_points) <= 0) {
    fail(`Test wallet ${testWallet} has 0 claimable points.`)
    info('Make a verified swap from this wallet to earn Samurai Points first.')
    process.exit(3)
  }
  pass(`Test wallet has ${balance.claimable_points} claimable points.`)

  // Decide the test claim amount
  const rate = Number(balance.reward_points_per_unit)
  const claimable = Number(balance.claimable_points)
  // Use a small safe amount: min(claimable, 100 points worth)
  // For 100 points at rate 1000 → 0.1 SOL. For 10 points → 0.01 SOL.
  // We'll target exactly 100 points (0.1 SOL) if available, else all available.
  const targetPoints = Math.min(claimable, 100)
  const expectedRewardSol = targetPoints / rate
  const expectedRewardLamports = Math.round(expectedRewardSol * 1_000_000_000)
  info(`Test claim target: ${targetPoints} points → ${expectedRewardSol} SOL (${expectedRewardLamports} lamports)`)

  if (expectedRewardLamports > vaultBefore) {
    fail(`Vault does NOT have enough SOL. Required: ${expectedRewardLamports} lamports. Available: ${vaultBefore} lamports.`)
    info('Fund the vault with Devnet SOL (https://faucet.solana.com) by sending to:')
    info(`  ${rewardVaultPda.toBase58()}`)
    info('Or call fund_vault() on the program from the admin keypair.')
    process.exit(4)
  }
  pass('Vault has enough SOL for the test claim.')

  // -----------------------------------------------------------------
  // STEP 7+8: Real POST /api/rewards/claim
  // -----------------------------------------------------------------
  step('7+8', `POST /api/rewards/claim for ${targetPoints} points`)

  const claimId = 'e2e-devnet-test-' + Date.now()
  info(`claim_id: ${claimId}`)

  // Note: this script assumes the backend is running locally on port 3000.
  // Start it with: npm run dev:all  (which runs vercel dev on port 3000)
  // OR: vercel dev --listen 3000
  const claimResponse = await callBackendClaim(testWallet, claimId, targetPoints)
  info(`HTTP status: ${claimResponse.status}`)
  if (claimResponse.status === 200) {
    pass('Backend returned 200 OK')
    info('Response body:')
    console.log(JSON.stringify(claimResponse.body, null, 2).split('\n').map(l => '     ' + l).join('\n'))
  } else {
    fail(`Backend returned non-200: ${claimResponse.status}`)
    info('Response body:')
    console.log(JSON.stringify(claimResponse.body, null, 2).split('\n').map(l => '     ' + l).join('\n'))
    process.exit(5)
  }

  const result = claimResponse.body
  if (!result.success) {
    fail('Backend reported success=false')
    process.exit(5)
  }
  if (!result.claim_tx_signature) {
    fail('Backend did not return a claim_tx_signature')
    process.exit(5)
  }
  pass(`Claim paid. tx signature: ${result.claim_tx_signature}`)
  const signature = result.claim_tx_signature

  // -----------------------------------------------------------------
  // STEP 9: Verify the transaction on Devnet
  // -----------------------------------------------------------------
  step(9, 'Verify transaction on Devnet')

  // Wait a moment for confirmation to be fully available
  await new Promise(r => setTimeout(r, 2000))

  const txInfo = await conn.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  if (!txInfo) {
    fail('Could not fetch transaction from Devnet (may not be confirmed yet).')
    info('Wait 10s and check https://solscan.io/tx/' + signature + '?cluster=devnet')
    process.exit(6)
  }
  pass('Transaction confirmed on Devnet.')
  info(`Slot: ${txInfo.slot}`)
  info(`Block time: ${new Date((txInfo.blockTime || 0) * 1000).toISOString()}`)
  info(`Fee: ${txInfo.meta.fee} lamports`)
  info(`Error: ${txInfo.meta.err || '(none)'}`)
  if (txInfo.meta.err) {
    fail(`Transaction failed on-chain: ${JSON.stringify(txInfo.meta.err)}`)
    process.exit(6)
  }

  // Find the recipient's balance change from the transaction
  const recipientKey = new PublicKey(testWallet)
  const preBalances = txInfo.meta.preTokenBalances || []
  const postBalances = txInfo.meta.postTokenBalances || []
  const accountKeys = txInfo.transaction.message.staticAccountKeys
    .concat(txInfo.meta.loadedAddresses?.writable || [])
    .concat(txInfo.meta.loadedAddresses?.readonly || [])

  // Find the recipient's index in accountKeys
  const recipientIdx = accountKeys.findIndex(k => k.equals(recipientKey))
  const vaultIdx = accountKeys.findIndex(k => k.equals(rewardVaultPda))

  info(`Recipient (${testWallet}) index in tx: ${recipientIdx}`)
  info(`Vault (${rewardVaultPda.toBase58()}) index in tx: ${vaultIdx}`)

  if (recipientIdx >= 0) {
    const pre = txInfo.meta.preBalances[recipientIdx] || 0
    const post = txInfo.meta.postBalances[recipientIdx] || 0
    const delta = post - pre
    info(`Recipient balance change: ${delta} lamports (pre=${pre}, post=${post})`)
    if (delta === expectedRewardLamports) {
      pass(`Recipient received EXACTLY ${expectedRewardLamports} lamports (${expectedRewardSol} SOL)`)
    } else {
      // The recipient may have paid a small tx fee if they were the fee payer, but in
      // our flow the ADMIN is the fee payer, so the recipient should receive exactly
      // the reward_amount with no deductions.
      fail(`Recipient received ${delta} lamports, expected ${expectedRewardLamports}`)
    }
  }

  if (vaultIdx >= 0) {
    const pre = txInfo.meta.preBalances[vaultIdx] || 0
    const post = txInfo.meta.postBalances[vaultIdx] || 0
    const delta = post - pre
    info(`Vault balance change: ${delta} lamports (pre=${pre}, post=${post})`)
    // The vault should have decreased by exactly expectedRewardLamports.
    // (The admin pays the tx fee, not the vault.)
    if (delta === -expectedRewardLamports) {
      pass(`Vault decreased by EXACTLY ${expectedRewardLamports} lamports`)
    } else {
      fail(`Vault changed by ${delta}, expected ${-expectedRewardLamports}`)
    }
  }

  // -----------------------------------------------------------------
  // Upgraded-contract checks (2026-09):
  // The upgraded `claim_reward` instruction no longer creates a per-claim
  // PDA. So instead of verifying a Claim PDA exists, we verify the
  // `RewardClaimed` event was emitted in the transaction logs and that
  // the program's `total_claims` / `total_claimed` counters advanced.
  // -----------------------------------------------------------------
  info(`RewardClaimed event verification (upgraded contract — no per-claim PDA):`)

  // 1. Look for the RewardClaimed event in the transaction's log messages.
  // Anchor events are emitted as base64-encoded Borsh under the
  // "Program data:" log prefix. We just check the event discriminator
  // appears — full Borsh decoding is intentionally skipped here to keep
  // the test resilient to minor schema additions.
  const REWARD_CLAIMED_DISCRIMINATOR = createHash('sha256')
    .update('event:RewardClaimed')
    .digest()
    .subarray(0, 8)

  const logs = Array.isArray(txInfo.meta.logMessages) ? txInfo.meta.logMessages : []
  const eventDataLogs = logs.filter(
    (line) => typeof line === 'string' && line.startsWith('Program data: ')
  )
  let eventFound = false
  for (const line of eventDataLogs) {
    const b64 = line.slice('Program data: '.length).trim()
    try {
      const bytes = Buffer.from(b64, 'base64')
      // Anchor wraps events with an 8-byte event discriminator
      // (sha256("event:<EventName>")[0..8]) followed by the Borsh-encoded
      // fields. We just match the discriminator.
      if (bytes.length >= 8 && Buffer.compare(bytes.subarray(0, 8), REWARD_CLAIMED_DISCRIMINATOR) === 0) {
        eventFound = true
        // Best-effort decode of the fields (all fixed-size in this event):
        //   claim_id: String (4-byte LE length + UTF-8)
        //   wallet_address: Pubkey (32 bytes)
        //   points_claimed: u64 LE
        //   reward_amount: u64 LE
        if (bytes.length >= 8 + 4) {
          const idLen = bytes.readUInt32LE(8)
          const idStart = 12
          const idEnd = idStart + idLen
          if (bytes.length >= idEnd) {
            const onChainClaimId = bytes.subarray(idStart, idEnd).toString('utf8')
            info(`  on-chain event claim_id: "${onChainClaimId}"`)
            if (onChainClaimId === claimId) pass('Event claim_id matches request claim_id')
            else fail(`Event claim_id "${onChainClaimId}" != "${claimId}"`)
          }
          const walletStart = idEnd
          if (bytes.length >= walletStart + 32) {
            const onChainWallet = new PublicKey(bytes.subarray(walletStart, walletStart + 32))
            info(`  on-chain event wallet_address: ${onChainWallet.toBase58()}`)
            if (onChainWallet.equals(recipientKey)) pass('Event wallet_address matches test wallet')
            else fail(`Event wallet_address ${onChainWallet.toBase58()} != ${recipientKey.toBase58()}`)
          }
          const ptsStart = walletStart + 32
          if (bytes.length >= ptsStart + 8) {
            const onChainPoints = bytes.readBigUInt64LE(ptsStart)
            info(`  on-chain event points_claimed: ${onChainPoints.toString()}`)
            if (Number(onChainPoints) === targetPoints) pass('Event points_claimed matches')
            else fail(`Event points_claimed ${onChainPoints} != ${targetPoints}`)
          }
          const rewStart = ptsStart + 8
          if (bytes.length >= rewStart + 8) {
            const onChainReward = bytes.readBigUInt64LE(rewStart)
            info(`  on-chain event reward_amount: ${onChainReward.toString()} lamports`)
            if (Number(onChainReward) === expectedRewardLamports) pass('Event reward_amount matches')
            else fail(`Event reward_amount ${onChainReward} != ${expectedRewardLamports}`)
          }
        }
        break
      }
    } catch {
      // Not a valid base64 / not our event — skip.
    }
  }
  if (eventFound) pass('RewardClaimed event emitted in tx logs')
  else fail('RewardClaimed event NOT found in tx logs')

  // 2. Verify no new per-claim account was created by the upgraded
  //    instruction. The old contract would create a Claim PDA; the
  //    upgraded contract must NOT. We check by computing the legacy
  //    PDA and confirming it doesn't exist on-chain (it may exist if
  //    the wallet had claims under the OLD contract — that's fine, we
  //    just confirm the account is NOT one of the accounts in THIS tx).
  const legacyClaimPda = PublicKey.findProgramAddressSync(
    [Buffer.from('claim'), rewardConfigPda.toBuffer(), hashClaimId(claimId)],
    PROGRAM_ID
  )[0]
  const legacyClaimIdx = accountKeys.findIndex((k) => k.equals(legacyClaimPda))
  info(`Legacy claim PDA (${legacyClaimPda.toBase58()}) present in tx: ${legacyClaimIdx >= 0}`)
  if (legacyClaimIdx < 0) pass('Upgraded claim_reward did NOT pass a per-claim PDA (4-account layout)')
  else fail('Upgraded claim_reward passed a per-claim PDA — contract may not actually be upgraded')

  // -----------------------------------------------------------------
  // STEP 10: Verify Supabase after the transaction
  // -----------------------------------------------------------------
  step(10, 'Verify Supabase after the transaction')

  const balanceAfter = await callSupabase('get_wallet_reward_balance', { p_wallet_address: testWallet })
  info(`earned_points:   ${balance.earned_points} → ${balanceAfter.earned_points}`)
  info(`claimed_points:  ${balance.claimed_points} → ${balanceAfter.claimed_points} (delta: ${Number(balanceAfter.claimed_points) - Number(balance.claimed_points)})`)
  info(`claimable_points:${balance.claimable_points} → ${balanceAfter.claimable_points}`)

  const claimedDelta = Number(balanceAfter.claimed_points) - Number(balance.claimed_points)
  if (claimedDelta === targetPoints) {
    pass(`claimed_points increased by EXACTLY ${targetPoints} points`)
  } else {
    fail(`claimed_points increased by ${claimedDelta}, expected ${targetPoints}`)
  }

  if (balanceAfter.recent_claims && balanceAfter.recent_claims.length > 0) {
    const latestClaim = balanceAfter.recent_claims[0]
    info(`Latest claim in DB:`)
    info(`  claim_id:              ${latestClaim.claim_id}`)
    info(`  status:               ${latestClaim.status}`)
    info(`  points_claimed:       ${latestClaim.points_claimed}`)
    info(`  reward_amount:        ${latestClaim.reward_amount}`)
    info(`  claim_tx_signature:   ${latestClaim.claim_tx_signature}`)
    if (latestClaim.status === 'COMPLETED') pass('reward_claims.status = COMPLETED')
    else fail(`reward_claims.status = ${latestClaim.status} (expected COMPLETED)`)
    if (latestClaim.claim_tx_signature === signature) pass('claim_tx_signature matches Solana tx')
    else fail(`claim_tx_signature ${latestClaim.claim_tx_signature} does not match ${signature}`)
  } else {
    fail('No recent claims returned by get_wallet_reward_balance')
  }

  // -----------------------------------------------------------------
  // STEP 11: Re-submit the SAME claim_id — must NOT double-payout
  // -----------------------------------------------------------------
  step(11, 'Re-submit the SAME claim_id (idempotency check)')

  const dupResponse = await callBackendClaim(testWallet, claimId, targetPoints)
  info(`HTTP status: ${dupResponse.status}`)
  if (dupResponse.status === 200) {
    pass('Backend returned 200 for duplicate claim_id')
    info('Response body:')
    console.log(JSON.stringify(dupResponse.body, null, 2).split('\n').map(l => '     ' + l).join('\n'))
    if (dupResponse.body.idempotent === true || dupResponse.body.already_completed === true) {
      pass('Backend correctly identified the duplicate (idempotent=true or already_completed=true)')
    } else {
      fail('Backend did NOT mark the duplicate as idempotent')
    }
    if (dupResponse.body.claim_tx_signature && dupResponse.body.claim_tx_signature !== signature) {
      fail(`Backend submitted a DIFFERENT tx signature: ${dupResponse.body.claim_tx_signature}`)
    } else if (dupResponse.body.claim_tx_signature === signature) {
      pass('Backend returned the SAME tx signature (no new payout)')
    }
  } else {
    fail(`Backend returned ${dupResponse.status} for duplicate claim_id`)
    info(JSON.stringify(dupResponse.body, null, 2))
  }

  // Verify no new transaction was submitted by checking the on-chain claim count
  const configInfoAfterDup = await conn.getAccountInfo(rewardConfigPda, 'confirmed')
  const totalClaimsAfterDup = configInfoAfterDup.data.readBigUInt64LE(50)
  info(`On-chain total_claims: ${totalClaimsBefore} → ${totalClaimsAfterDup}`)
  if (totalClaimsAfterDup === totalClaimsBefore + 1n) {
    pass('On-chain total_claims increased by exactly 1 (no duplicate payout)')
  } else {
    fail(`On-chain total_claims changed by ${totalClaimsAfterDup - totalClaimsBefore}`)
  }

  // -----------------------------------------------------------------
  // STEP 12: Attempt to claim more than is claimable (after consuming all)
  // -----------------------------------------------------------------
  step(12, 'Attempt to claim more than is now claimable')

  if (Number(balanceAfter.claimable_points) > 0) {
    info(`Wallet still has ${balanceAfter.claimable_points} claimable points — claim them all first`)
    // Claim the rest
    const drainClaimId = 'e2e-devnet-drain-' + Date.now()
    const drainResp = await callBackendClaim(testWallet, drainClaimId, null)
    info(`Drain claim HTTP ${drainResp.status}: ${JSON.stringify(drainResp.body).slice(0, 200)}`)
  }

  // Now try to claim again — should be rejected
  const overClaimId = 'e2e-devnet-over-' + Date.now()
  const overResp = await callBackendClaim(testWallet, overClaimId, 1)
  info(`HTTP status: ${overResp.status}`)
  if (overResp.status === 400 || overResp.status === 200 && !overResp.body.success) {
    pass('Backend correctly rejected claim with no claimable points')
    if (overResp.body.code) info(`Error code: ${overResp.body.code}`)
  } else {
    fail('Backend did NOT reject the over-claim')
    info(JSON.stringify(overResp.body, null, 2))
  }

  // -----------------------------------------------------------------
  // STEP 13: Final balances
  // -----------------------------------------------------------------
  step(13, 'Final balances')

  const vaultAfter = await conn.getBalance(rewardVaultPda, 'confirmed')
  const recipientAfter = await conn.getBalance(new PublicKey(testWallet), 'confirmed')
  const configInfoFinal = await conn.getAccountInfo(rewardConfigPda, 'confirmed')
  const totalClaimsFinal = configInfoFinal.data.readBigUInt64LE(50)
  const totalClaimedFinal = configInfoFinal.data.readBigUInt64LE(42)

  info(`Vault balance:       ${vaultBefore / 1e9} SOL → ${vaultAfter / 1e9} SOL (delta: ${(vaultAfter - vaultBefore) / 1e9} SOL)`)
  info(`Recipient balance:   ${recipientBefore / 1e9} SOL → ${recipientAfter / 1e9} SOL (delta: ${(recipientAfter - recipientBefore) / 1e9} SOL)`)
  info(`Total claims:        ${totalClaimsBefore} → ${totalClaimsFinal}`)
  info(`Total claimed:       ${totalClaimedBefore} → ${totalClaimedFinal} lamports`)

  const vaultDelta = vaultBefore - vaultAfter
  if (vaultDelta === expectedRewardLamports) {
    pass(`Vault decreased by EXACTLY the reward amount (${expectedRewardLamports} lamports)`)
  } else {
    fail(`Vault delta: ${vaultDelta} lamports, expected ${expectedRewardLamports}`)
    info(`  (Note: if you made a "drain" claim in step 12, vault will be lower by that amount too.)`)
  }

  console.log('\n' + '='.repeat(70))
  console.log('TEST COMPLETE')
  console.log('='.repeat(70))
  console.log(`Solana tx signature: ${signature}`)
  console.log(`Solscan URL: https://solscan.io/tx/${signature}?cluster=devnet`)
  console.log('Paste this output back to me for review.')
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err?.message || err)
  if (err?.body) console.error('Body:', JSON.stringify(err.body, null, 2))
  process.exit(1)
})
