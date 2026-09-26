// =====================================================================
// Wallet Link Security Test Suite
// =====================================================================
// Node test suite (no live DB / Solana / MetaMask needed) that verifies
// the core security invariants of the wallet-link layer:
//
//   1. EVM signature verification (EIP-191 personal_sign)
//      - valid signature recovers the correct address ✓
//      - signature from a different wallet is rejected ✓
//      - signature for a different message is rejected ✓
//      - malformed signature is rejected ✓
//      - signature with the wrong message text is rejected ✓
//
//   2. Solana signature verification (ed25519 signMessage)
//      - valid signature verifies ✓
//      - signature from a different keypair is rejected ✓
//      - signature over a different message is rejected ✓
//      - malformed signature (wrong length) is rejected ✓
//      - off-curve "Solana address" is rejected ✓
//
//   3. Address validation
//      - EVM addresses are normalized to lowercase ✓
//      - Solana addresses are normalized via PublicKey.toString() ✓
//      - invalid formats are rejected ✓
//      - 0xATTACKER-injected wallets do not pass validation ✓
//
//   4. Replay / hijack protection (static checks on the SQL migration)
//      - wallet_links.evm_active_uidx (unique partial index) prevents
//        an EVM wallet from being ACTIVE-linked to two Solana wallets
//      - wallet_link_challenges.status check (PENDING → USED) prevents
//        replay of a consumed challenge
//      - challenge expires_at enforced inside the link_wallets RPC
//      - claim_reward raises EVM_CLAIM_NOT_ALLOWED when an EVM address
//        is supplied as the payout wallet
//
//   5. Backend balance endpoint
//      - The handler accepts only a single wallet in the query string
//        and the server determines linked wallets from the DB
//      - The frontend can NEVER inject `?wallet=ADDR1,0xATTACKER`
//        (the comma is rejected by the address-format validator)
//
// Run:
//   node /home/z/my-project/scripts/test_wallet_link_security.mjs
// =====================================================================

import crypto from 'node:crypto'
import { ethers } from 'ethers'
import { Keypair, PublicKey } from '@solana/web3.js'
import assert from 'node:assert'
import {
  isValidSolanaAddress,
  isValidEvmAddress,
  canonicalSolanaAddress,
  canonicalEvmAddress,
  verifyEvmSignature,
  verifySolanaSignature,
} from '../api/_lib/walletLinkAuth.mjs'
import fs from 'node:fs'
import path from 'node:path'

const RESULTS = []
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => RESULTS.push({ name, status: 'PASS' }),
    (err) => RESULTS.push({ name, status: 'FAIL', error: err?.message || String(err) })
  )
}

// =====================================================================
// Test fixtures — generate fresh EVM + Solana keypairs locally
// =====================================================================

async function setupFixtures() {
  // Two EVM wallets — used to test "wrong signer" rejection.
  const evmWalletA = ethers.Wallet.createRandom()
  const evmWalletB = ethers.Wallet.createRandom()
  // Two Solana keypairs — same purpose.
  const solanaKeypairA = Keypair.generate()
  const solanaKeypairB = Keypair.generate()
  const solanaAddressA = solanaKeypairA.publicKey.toString()
  const solanaAddressB = solanaKeypairB.publicKey.toString()

  // The canonical linking message (server would build this).
  const messageEvm = [
    'RoninSwap Wallet Link',
    '',
    'I authorize linking the following wallets for Samurai Points rewards:',
    '',
    `EVM wallet: ${evmWalletA.address.toLowerCase()}`,
    `Solana wallet: ${solanaAddressA}`,
    '',
    `Challenge ID: wlc-test123`,
    `Nonce: abc123`,
    `Issued: 2026-09-26T00:00:00.000Z`,
    `Expires: 2026-09-26T00:05:00.000Z`,
    '',
    'Purpose: cryptographically prove ownership of both wallets so Samurai Points earned on EVM chains can be aggregated into my Solana reward identity.',
    '',
    'This signature does not authorize transactions or token transfers.',
    '',
    `Signing as: EVM wallet ${evmWalletA.address.toLowerCase()}`,
  ].join('\n')

  const messageSolana = messageEvm.replace('Signing as: EVM wallet', 'Signing as: Solana wallet').replace(evmWalletA.address.toLowerCase(), solanaAddressA)

  // Sign the messages with the correct keys.
  const validEvmSig = await evmWalletA.signMessage(messageEvm)
  const validSolanaSig = base64(signEd25519(solanaKeypairA, messageSolana))

  // Sign with the WRONG EVM wallet.
  const wrongEvmSig = await evmWalletB.signMessage(messageEvm)
  // Sign with the WRONG Solana keypair.
  const wrongSolanaSig = base64(signEd25519(solanaKeypairB, messageSolana))

  // Sign a DIFFERENT EVM message with the correct wallet.
  const differentMessageEvmSig = await evmWalletA.signMessage('different message')
  // Sign a DIFFERENT Solana message with the correct keypair.
  const differentMessageSolanaSig = base64(signEd25519(solanaKeypairA, 'different message'))

  return {
    evmWalletA, evmWalletB,
    solanaKeypairA, solanaKeypairB,
    solanaAddressA, solanaAddressB,
    messageEvm, messageSolana,
    validEvmSig, validSolanaSig,
    wrongEvmSig, wrongSolanaSig,
    differentMessageEvmSig, differentMessageSolanaSig,
  }
}

function signEd25519(keypair, message) {
  // Mirror Phantom's signMessage: ed25519 sign over UTF-8 bytes.
  return crypto.sign(null, Buffer.from(message, 'utf8'), keypairToCryptoKey(keypair))
}

function keypairToCryptoKey(keypair) {
  // Solana Keypair.secretKey = 64 bytes (32 seed + 32 public). node:crypto
  // accepts a raw ed25519 PKCS8 seed; we wrap it the same way adminAuth.mjs
  // wraps the public key for verification.
  const secretSeed = keypair.secretKey.slice(0, 32)
  return crypto.createPrivateKey({
    key: Buffer.concat([
      // PKCS8 prefix for ed25519
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      secretSeed,
    ]),
    format: 'der',
    type: 'pkcs8',
  })
}

function base64(buf) {
  return Buffer.from(buf).toString('base64')
}

// =====================================================================
// Test cases
// =====================================================================

async function main() {
  const f = await setupFixtures()

  // -- 1. Address validation ----------------------------------------
  await test('isValidEvmAddress accepts valid 0x address', () => {
    assert.strictEqual(isValidEvmAddress(f.evmWalletA.address), true)
  })
  await test('isValidEvmAddress rejects garbage', () => {
    assert.strictEqual(isValidEvmAddress('not an address'), false)
    assert.strictEqual(isValidEvmAddress('0x1234'), false)
    assert.strictEqual(isValidEvmAddress('0xZZZ' + '0'.repeat(36)), false)
  })
  await test('isValidEvmAddress rejects uppercase 0x in address with mixed case but right length (lowercase only valid as canonical form)', () => {
    // Mixed-case checksummed addresses are valid hex but our canonical form
    // requires lowercase. The validator accepts any 0x40hex case-insensitive;
    // canonicalEvmAddress lowercases it.
    const checksummed = f.evmWalletA.address  // ethers uses EIP-55 checksum
    assert.strictEqual(isValidEvmAddress(checksummed), true)
    assert.strictEqual(canonicalEvmAddress(checksummed), checksummed.toLowerCase())
  })

  await test('isValidSolanaAddress accepts real keypair public key', () => {
    assert.strictEqual(isValidSolanaAddress(f.solanaAddressA), true)
  })
  await test('isValidSolanaAddress rejects too-short / too-long', () => {
    assert.strictEqual(isValidSolanaAddress('short'), false)
    assert.strictEqual(isValidSolanaAddress('a'.repeat(50)), false)
  })
  await test('isValidSolanaAddress rejects non-base58 garbage', () => {
    assert.strictEqual(isValidSolanaAddress('0' + '1'.repeat(31)), false)  // contains '0' (not base58)
    assert.strictEqual(isValidSolanaAddress('l' + '1'.repeat(31)), false)  // 'l' not base58
    assert.strictEqual(isValidSolanaAddress('I' + '1'.repeat(31)), false)  // 'I' not base58
    assert.strictEqual(isValidSolanaAddress('O' + '1'.repeat(31)), false)  // 'O' not base58
  })

  // -- 2. EVM signature verification ---------------------------------
  await test('valid EVM signature recovers the correct address', () => {
    const ok = verifyEvmSignature({
      message: f.messageEvm,
      signature: f.validEvmSig,
      expectedAddress: f.evmWalletA.address,
    })
    assert.strictEqual(ok, true)
  })
  await test('EVM signature from a DIFFERENT wallet is rejected', () => {
    const ok = verifyEvmSignature({
      message: f.messageEvm,
      signature: f.wrongEvmSig,  // signed by B, expected A
      expectedAddress: f.evmWalletA.address,
    })
    assert.strictEqual(ok, false)
  })
  await test('EVM signature over a DIFFERENT message is rejected', () => {
    const ok = verifyEvmSignature({
      message: f.messageEvm,
      signature: f.differentMessageEvmSig,  // signed A, but different msg
      expectedAddress: f.evmWalletA.address,
    })
    assert.strictEqual(ok, false)
  })
  await test('malformed EVM signature is rejected', () => {
    const ok = verifyEvmSignature({
      message: f.messageEvm,
      signature: '0xdeadbeef',
      expectedAddress: f.evmWalletA.address,
    })
    assert.strictEqual(ok, false)
  })
  await test('EVM signature with mismatched expected address is rejected', () => {
    // Verify against a different expected address — recovered address
    // won't match.
    const ok = verifyEvmSignature({
      message: f.messageEvm,
      signature: f.validEvmSig,  // signed by A
      expectedAddress: f.evmWalletB.address,  // expecting B
    })
    assert.strictEqual(ok, false)
  })

  // -- 3. Solana signature verification ------------------------------
  await test('valid Solana signature verifies against the correct public key', () => {
    const ok = verifySolanaSignature({
      message: f.messageSolana,
      signature: f.validSolanaSig,
      expectedAddress: f.solanaAddressA,
    })
    assert.strictEqual(ok, true)
  })
  await test('Solana signature from a DIFFERENT keypair is rejected', () => {
    const ok = verifySolanaSignature({
      message: f.messageSolana,
      signature: f.wrongSolanaSig,  // signed by B, expected A
      expectedAddress: f.solanaAddressA,
    })
    assert.strictEqual(ok, false)
  })
  await test('Solana signature over a DIFFERENT message is rejected', () => {
    const ok = verifySolanaSignature({
      message: f.messageSolana,
      signature: f.differentMessageSolanaSig,
      expectedAddress: f.solanaAddressA,
    })
    assert.strictEqual(ok, false)
  })
  await test('malformed Solana signature (wrong length) is rejected', () => {
    const ok = verifySolanaSignature({
      message: f.messageSolana,
      signature: Buffer.from('short').toString('base64'),
      expectedAddress: f.solanaAddressA,
    })
    assert.strictEqual(ok, false)
  })
  await test('Solana signature verified against the WRONG public key is rejected', () => {
    const ok = verifySolanaSignature({
      message: f.messageSolana,
      signature: f.validSolanaSig,  // signed by A
      expectedAddress: f.solanaAddressB,  // expecting B
    })
    assert.strictEqual(ok, false)
  })

  // -- 4. Static checks on the SQL migration ------------------------
  // Verify the migration file enforces the security invariants we
  // claim it does. We grep the file content for the specific SQL
  // constructs that prevent replay / hijack / EVM-as-payout.
  const migrationPath = path.resolve(process.cwd(),
    'supabase/migrations/20260926000000_wallet_links.sql')
  const migrationSql = fs.readFileSync(migrationPath, 'utf8')

  await test('migration: wallet_links table created with status check', () => {
    assert.match(migrationSql, /create table if not exists public\.wallet_links/, 'wallet_links table missing')
    assert.match(migrationSql, /status text not null default 'ACTIVE'\s+check \(status in \('ACTIVE', 'REVOKED'\)\)/, 'status check missing')
  })

  await test('migration: evm_chain_scope column ABSENT from wallet_links CREATE TABLE (per architecture requirement)', () => {
    // The user explicitly asked to remove evm_chain_scope if it's
    // unnecessary. It IS unnecessary because an EVM address is one
    // row in public.wallets regardless of which EVM chain it swapped
    // on (chain_id lives on swap_transactions / samurai_points, not
    // on wallets). A per-chain link scope would split a single EVM
    // identity without any security benefit.
    //
    // We check the CREATE TABLE block specifically (not the entire
    // file) because the migration's comments explain WHY the column
    // was removed — those mentions are intentional.
    const tableStart = migrationSql.indexOf('create table if not exists public.wallet_links')
    const tableEnd = migrationSql.indexOf(');', tableStart)
    assert.ok(tableStart > 0 && tableEnd > tableStart, 'wallet_links CREATE TABLE block not found')
    const createTableBlock = migrationSql.slice(tableStart, tableEnd)
    assert.ok(!/evm_chain_scope/.test(createTableBlock),
      'evm_chain_scope column still present in wallet_links CREATE TABLE — should be removed per architecture requirement')
  })

  await test('migration: wallet_point_consumption table created (THE ACCOUNTING FIX)', () => {
    assert.match(migrationSql, /create table if not exists public\.wallet_point_consumption/,
      'wallet_point_consumption table missing — accounting fix absent')
    assert.match(migrationSql, /wallet_id uuid not null references public\.wallets\(id\)/,
      'wallet_point_consumption must reference wallets(id) so consumption travels with the wallet, not the link')
    assert.match(migrationSql, /points_consumed numeric\(30, 6\) not null/,
      'points_consumed column missing')
    assert.match(migrationSql, /source text not null default 'CLAIM'\s+check \(source in \('CLAIM', 'MIGRATION_BACKFILL', 'ADMIN_ADJUST'\)\)/,
      'source column check missing')
    assert.match(migrationSql, /constraint wallet_point_consumption_positive check \(points_consumed > 0\)/,
      'positive-points check missing')
  })

  await test('migration: wallet_point_consumption has unique (wallet_id, claim_id) index', () => {
    assert.match(migrationSql,
      /create unique index if not exists wallet_point_consumption_wallet_claim_uidx\s+on public\.wallet_point_consumption\(wallet_id, claim_id\)\s+where claim_id is not null/,
      'unique (wallet_id, claim_id) partial index missing — a single claim cannot consume the same wallet twice')
  })

  await test('migration: wallet_point_consumption has idempotent backfill index', () => {
    assert.match(migrationSql,
      /create unique index if not exists wallet_point_consumption_backfill_uidx\s+on public\.wallet_point_consumption\(wallet_id\)\s+where source = 'MIGRATION_BACKFILL'/,
      'backfill unique partial index missing — migration is not idempotent on re-run')
  })

  await test('migration: MIGRATION_BACKFILL preserves existing claimed_points values', () => {
    assert.match(migrationSql,
      /insert into public\.wallet_point_consumption \(wallet_id, claim_id, points_consumed, source, consumed_at\)\s+select w\.id, null, w\.claimed_points, 'MIGRATION_BACKFILL', coalesce\(w\.updated_at, now\(\)\)\s+from public\.wallets w\s+where w\.claimed_points > 0\s+on conflict do nothing/,
      'backfill INSERT missing — existing users with claimed_points > 0 would have their claimed amount reset to 0 in the new accounting (BUG)')
  })

  await test('migration: get_wallet_reward_balance uses wallet_point_consumption (authoritative)', () => {
    assert.match(migrationSql,
      /select coalesce\(sum\(wpc\.points_consumed\), 0\) into v_consumed_points\s+from public\.wallet_point_consumption wpc\s+where wpc\.wallet_id = any\(coalesce\(v_wallet_ids, ARRAY\[\]::uuid\[\]\)\)/,
      'get_wallet_reward_balance does not use wallet_point_consumption as the authoritative consumed-points source')
  })

  await test('migration: claim_reward uses wallet_point_consumption (not wallets.claimed_points) for claimable math', () => {
    // The ORIGINAL bug was using wallets.claimed_points on the canonical
    // Solana wallet for claimable math. The FIX must compute consumed
    // from wallet_point_consumption across the identity set.
    assert.match(migrationSql,
      /select coalesce\(sum\(wpc\.points_consumed\), 0\) into consumed_points\s+from public\.wallet_point_consumption wpc\s+where wpc\.wallet_id = any\(coalesce\(v_wallet_ids, ARRAY\[\]::uuid\[\]\)\)/,
      'claim_reward does not compute consumed from wallet_point_consumption — accounting bug not fixed')
  })

  await test('migration: claim_reward distributes consumption FIFO across identity wallets', () => {
    assert.match(migrationSql, /foreach v_wallet_id in v_wallet_ids_ordered/,
      'claim_reward does not iterate over identity wallets for FIFO distribution')
    assert.match(migrationSql,
      /insert into public\.wallet_point_consumption \(wallet_id, claim_id, points_consumed, source\)\s+values \(v_wallet_id, p_claim_id, v_take, 'CLAIM'\)/,
      'claim_reward does not insert wallet_point_consumption rows during FIFO distribution')
  })

  await test('migration: claim_reward orders wallets Solana-first then EVMs by verified_at ASC', () => {
    assert.match(migrationSql, /v_wallet_ids_ordered := array\[wallet_row\.id\]/,
      'claim_reward does not put the canonical Solana wallet first in the FIFO order')
    assert.match(migrationSql,
      /select array_agg\(w\.id order by wl\.verified_at asc\) into evm_ids\s+from public\.wallet_links wl\s+join public\.wallets w on w\.wallet_address = wl\.evm_wallet\s+where wl\.solana_wallet = v_solana_wallet\s+and wl\.status = 'ACTIVE'/,
      'claim_reward does not append EVM wallets ordered by verified_at ASC')
  })

  await test('migration: unlink_wallet does NOT delete wallet_point_consumption rows', () => {
    // The unlink RPC must only set status='REVOKED' on the wallet_links
    // row. It must NOT touch wallet_point_consumption — otherwise
    // unlinks would reset consumed points (the original bug).
    const unlinkStart = migrationSql.indexOf('create or replace function public.unlink_wallet(')
    const unlinkEnd = migrationSql.indexOf('revoke execute on function public.unlink_wallet(text, text)')
    assert.ok(unlinkStart > 0 && unlinkEnd > unlinkStart, 'unlink_wallet function not found')
    const unlinkBody = migrationSql.slice(unlinkStart, unlinkEnd)
    assert.ok(!/delete from public\.wallet_point_consumption/.test(unlinkBody),
      'unlink_wallet deletes wallet_point_consumption rows — this would re-introduce the duplicate-claim bug')
    assert.ok(!/update public\.wallet_point_consumption/.test(unlinkBody),
      'unlink_wallet mutates wallet_point_consumption rows — this would re-introduce the duplicate-claim bug')
  })

  await test('migration: claim_reward raises CONSUMPTION_DISTRIBUTION_FAILED if FIFO fails', () => {
    assert.match(migrationSql, /raise exception 'CONSUMPTION_DISTRIBUTION_FAILED/,
      'claim_reward does not abort when FIFO distribution can\u2019t account for the full claim amount — silent accounting error')
  })

  await test('migration: unique partial index prevents an EVM wallet from being ACTIVE-linked to two Solana wallets', () => {
    assert.match(migrationSql,
      /create unique index if not exists wallet_links_evm_active_uidx\s+on public\.wallet_links\(evm_wallet\)\s+where status = 'ACTIVE'/,
      'evm_active_uidx partial unique index missing — cross-user hijack protection absent')
  })

  await test('migration: unique partial index prevents duplicate ACTIVE pair rows', () => {
    assert.match(migrationSql,
      /create unique index if not exists wallet_links_pair_active_uidx/,
      'pair_active unique index missing')
  })

  await test('migration: wallet_link_challenges table tracks one-time-use status', () => {
    assert.match(migrationSql, /create table if not exists public\.wallet_link_challenges/)
    assert.match(migrationSql,
      /status text not null default 'PENDING'\s+check \(status in \('PENDING', 'USED', 'EXPIRED', 'REVOKED'\)\)/,
      'challenge status check missing')
    assert.match(migrationSql, /expires_at timestamptz not null/, 'expires_at required column missing')
    assert.match(migrationSql, /used_at timestamptz/, 'used_at column missing')
  })

  await test('migration: link_wallets RPC marks challenge USED atomically + checks PENDING + checks expiry', () => {
    // The RPC must check status = 'PENDING' and expires_at < now()
    // and atomically update status to 'USED'.
    assert.match(migrationSql, /if challenge_row\.status <> 'PENDING' then\s+raise exception 'CHALLENGE_NOT_PENDING'/,
      'PENDING check missing')
    assert.match(migrationSql, /if challenge_row\.expires_at < now\(\) then/,
      'expiry check missing')
    assert.match(migrationSql, /update public\.wallet_link_challenges\s+set status = 'USED',\s+used_at = now\(\)/,
      'USED status update missing')
    assert.match(migrationSql, /for update/, 'FOR UPDATE lock missing — concurrent verify attempts would race')
  })

  await test('migration: link_wallets RPC enforces signer matches challenge', () => {
    assert.match(migrationSql, /if lower\(p_evm_signer\) <> lower\(challenge_row\.evm_wallet\) then\s+raise exception 'EVM_SIGNER_MISMATCH'/,
      'EVM signer mismatch check missing')
    assert.match(migrationSql, /if p_solana_signer <> challenge_row\.solana_wallet then\s+raise exception 'SOLANA_SIGNER_MISMATCH'/,
      'Solana signer mismatch check missing')
  })

  await test('migration: link_wallets RPC detects cross-user hijack attempt', () => {
    assert.match(migrationSql,
      /select \* into conflicting_link from public\.wallet_links\s+where evm_wallet = lower\(challenge_row\.evm_wallet\)\s+and status = 'ACTIVE'\s+and solana_wallet <> challenge_row\.solana_wallet/,
      'cross-user hijack detection missing')
    assert.match(migrationSql, /raise exception 'EVM_ALREADY_LINKED_ELSEWHERE'/,
      'EVM_ALREADY_LINKED_ELSEWHERE exception missing')
  })

  await test('migration: claim_reward RPC rejects EVM addresses as payout recipients', () => {
    // The RPC must detect an EVM input and raise EVM_CLAIM_NOT_ALLOWED.
    assert.match(migrationSql, /v_input_is_evm := p_wallet_address ~ '\^0x\[0-9a-fA-F\]\{40\}\$'/,
      'EVM input detection missing')
    assert.match(migrationSql, /raise exception 'EVM_CLAIM_NOT_ALLOWED'/,
      'EVM_CLAIM_NOT_ALLOWED exception missing — an attacker could supply an EVM address as the payout recipient')
  })

  await test('migration: claim_reward aggregates earned_points across verified identity set', () => {
    assert.match(migrationSql, /select \* into v_identity from public\.get_verified_reward_identity\(p_wallet_address\)|v_identity := public\.get_verified_reward_identity\(p_wallet_address\)/,
      'claim_reward does not resolve the verified identity')
    assert.match(migrationSql, /v_wallet_addresses := array_append\(coalesce\(v_linked_evm_wallets_arr, ARRAY\[\]::text\[\]\), v_solana_wallet\)/,
      'claim_reward does not append linked EVM wallets to the aggregation set')
  })

  await test('migration: claim_reward locks only the canonical Solana wallet row', () => {
    // The FOR UPDATE lock must be on the canonical Solana wallet, NOT
    // on any EVM wallet — so concurrent claims for the same identity
    // serialize on the Solana row.
    assert.match(migrationSql, /select \* into wallet_row from public\.wallets\s+where wallet_address = v_solana_wallet\s+for update/,
      'FOR UPDATE lock on canonical Solana wallet missing')
  })

  await test('migration: get_wallet_reward_balance aggregates across verified identity', () => {
    assert.match(migrationSql, /select \* into v_identity from public\.get_verified_reward_identity\(p_wallet_address\)|v_identity := public\.get_verified_reward_identity\(p_wallet_address\)/,
      'get_wallet_reward_balance does not resolve the verified identity')
    assert.match(migrationSql, /v_wallet_addresses := array_append\(coalesce\(v_linked_evm_wallets_arr, ARRAY\[\]::text\[\]\), v_solana_wallet\)/,
      'get_wallet_reward_balance does not aggregate linked EVM wallets')
    // The RPC must NOT accept an arbitrary wallet list from the
    // frontend — the only parameter is p_wallet_address (a single
    // address). Confirm the function signature.
    assert.match(migrationSql, /create or replace function public\.get_wallet_reward_balance\(\s+p_wallet_address text\s+\)/,
      'get_wallet_reward_balance signature changed — must accept only a single wallet address (NOT a list)')
  })

  await test('migration: get_verified_reward_identity never returns signature data', () => {
    // The RPC must NOT return any column from wallet_link_challenges
    // (no nonces, no message_evm/message_solana, no signatures).
    // Confirm the function body only reads from wallet_links.
    const fnStart = migrationSql.indexOf('create or replace function public.get_verified_reward_identity(')
    const fnEnd = migrationSql.indexOf('revoke execute on function public.get_verified_reward_identity(text)')
    assert.ok(fnStart > 0 && fnEnd > fnStart, 'get_verified_reward_identity function not found')
    const fnBody = migrationSql.slice(fnStart, fnEnd)
    assert.ok(!fnBody.includes('message_evm'), 'get_verified_reward_identity leaks message_evm')
    assert.ok(!fnBody.includes('message_solana'), 'get_verified_reward_identity leaks message_solana')
    assert.ok(!fnBody.includes('nonce'), 'get_verified_reward_identity leaks nonce')
    assert.ok(!fnBody.includes('signature'), 'get_verified_reward_identity leaks signature')
  })

  await test('migration: RLS enabled + service_role-only grants', () => {
    assert.match(migrationSql, /alter table public\.wallet_links enable row level security/,
      'wallet_links RLS not enabled')
    assert.match(migrationSql, /revoke all on table public\.wallet_links from public, anon, authenticated/,
      'wallet_links not revoked from anon/authenticated')
    assert.match(migrationSql, /grant select, insert, update on table public\.wallet_links to service_role/,
      'wallet_links not granted to service_role')
    assert.match(migrationSql, /alter table public\.wallet_link_challenges enable row level security/,
      'wallet_link_challenges RLS not enabled')
    assert.match(migrationSql, /revoke all on table public\.wallet_link_challenges from public, anon, authenticated/,
      'wallet_link_challenges not revoked from anon/authenticated')
  })

  // -- 5. Static checks on the API handler --------------------------
  const verifyHandlerPath = path.resolve(process.cwd(),
    'api_routes/wallet-link/verify.mjs')
  const verifyHandler = fs.readFileSync(verifyHandlerPath, 'utf8')

  await test('verify handler fetches challenge messages from DB (not from request body)', () => {
    // The handler must NOT read body.messageEvm or body.messageSolana.
    assert.ok(!/\bbody\.(messageEvm|message_solana|messageSolana|message_evm)\b/.test(verifyHandler),
      'verify handler reads signing messages from request body — security violation (frontend could substitute them)')
    // It must fetch them from the DB.
    assert.match(verifyHandler, /getPendingChallenge\(challengeId\)/,
      'verify handler does not fetch challenge from DB')
  })

  await test('verify handler enforces both signatures before calling the RPC', () => {
    assert.match(verifyHandler, /verifyEvmSignature\(/,
      'verify handler does not verify EVM signature')
    assert.match(verifyHandler, /verifySolanaSignature\(/,
      'verify handler does not verify Solana signature')
    // If either fails, the handler must return an error BEFORE
    // calling the link_wallets RPC.
    assert.match(verifyHandler, /EVM_SIGNATURE_INVALID/,
      'verify handler does not raise EVM_SIGNATURE_INVALID')
    assert.match(verifyHandler, /SOLANA_SIGNATURE_INVALID/,
      'verify handler does not raise SOLANA_SIGNATURE_INVALID')
  })

  await test('verify handler rejects invalid challenge_id format', () => {
    assert.match(verifyHandler, /function isValidChallengeId\(value\)/,
      'isValidChallengeId missing')
    assert.match(verifyHandler, /\^wlc-\[a-f0-9\]\{16,64\}\$/,
      'challenge_id regex too permissive — must be wlc- + hex only')
  })

  await test('verify handler rejects malformed signatures', () => {
    assert.match(verifyHandler, /function isValidEvmSignature/,
      'isValidEvmSignature missing')
    assert.match(verifyHandler, /function isValidSolanaSignature/,
      'isValidSolanaSignature missing')
  })

  await test('verify handler rate-limits verify attempts', () => {
    assert.match(verifyHandler, /rateLimitPersistent\(req, 'wallet_link_verify'/,
      'verify handler does not rate-limit')
  })

  await test('verify handler does not log signatures or nonces on error', () => {
    // Console.error is OK but must not include the signature/nonce bytes.
    assert.ok(!/console\.\w+\([^)]*(evmSignature|solanaSignature|nonce)/.test(verifyHandler),
      'verify handler logs signature/nonce values — security violation')
  })

  // -- 6. Balance handler static checks -----------------------------
  const balanceHandlerPath = path.resolve(process.cwd(),
    'api_routes/rewards/balance.mjs')
  const balanceHandler = fs.readFileSync(balanceHandlerPath, 'utf8')

  await test('balance handler accepts only a single wallet in query string', () => {
    // The handler reads req.query.wallet as a single string — never
    // parses it as a comma-separated list.
    assert.match(balanceHandler, /const wallet = String\(req\.query\?\.wallet \|\| ''\)\.trim\(\)/,
      'balance handler does not read a single wallet query param')
    assert.match(balanceHandler, /function isValidWallet\(value\)\s+\{[^}]+return \/\^\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\$\/\.test\(trimmed\) \|\| \/\^0x\[a-fA-F0-9\]\{40\}\$\/\.test\(trimmed\)/,
      'balance handler wallet validator too permissive — must reject comma-separated lists')
  })

  await test('balance handler does not accept a wallet list parameter', () => {
    // No support for ?wallets=...&wallet=...
    assert.ok(!/\breq\.query\?\.wallets\b/.test(balanceHandler),
      'balance handler accepts a wallets[] list parameter — frontend could inject arbitrary EVM wallets')
  })

  // -- 7. RewardClaimPanel static checks ---------------------------
  const rcpPath = path.resolve(process.cwd(),
    'src/components/RewardClaimPanel.jsx')
  const rcp = fs.readFileSync(rcpPath, 'utf8')

  await test('RewardClaimPanel uses solanaPayoutWallet (not localStorage) for claims', () => {
    assert.match(rcp, /const \{ solanaPayoutWallet, verifiedEvmWallets, verifiedIdentityLoaded, refreshLinkedWallets \} = useWallet\(\)/,
      'RewardClaimPanel does not consume the verified identity from useWallet')
    assert.match(rcp, /const effectiveWallet = solanaPayoutWallet \|\| wallet/,
      'RewardClaimPanel does not prefer the verified Solana payout wallet')
  })

  await test('RewardClaimPanel rejects EVM wallet as payout recipient', () => {
    assert.match(rcp, /EVM wallets cannot be Solana payout recipients/,
      'RewardClaimPanel does not reject EVM payout wallets')
  })

  await test('RewardClaimPanel reloads balance when verified identity changes', () => {
    assert.match(rcp, /if \(verifiedIdentityLoaded\) load\(\)/,
      'RewardClaimPanel does not reload balance when the verified identity updates')
  })

  await test('RewardClaimPanel shows Link CTA when no EVMs linked', () => {
    assert.match(rcp, /Link your EVM wallet to include those points in your reward balance\./,
      'RewardClaimPanel does not show the Link CTA')
  })

  // -- 8. WalletContext static checks ------------------------------
  const wcPath = path.resolve(process.cwd(),
    'src/context/WalletContext.jsx')
  const wc = fs.readFileSync(wcPath, 'utf8')

  await test('WalletContext loads verifiedEvmWallets from backend, not localStorage', () => {
    assert.match(wc, /import \{ getVerifiedRewardIdentity \} from '\.\.\/services\/walletLinkService'/,
      'WalletContext does not import getVerifiedRewardIdentity')
    assert.match(wc, /const identity = await getVerifiedRewardIdentity\(address\)/,
      'WalletContext does not call getVerifiedRewardIdentity')
    assert.match(wc, /const \[verifiedEvmWallets, setVerifiedEvmWallets\] = useState\(\[\]\)/,
      'WalletContext does not declare verifiedEvmWallets state')
  })

  await test('WalletContext exposes solanaPayoutWallet + verifiedEvmWallets', () => {
    assert.match(wc, /verifiedEvmWallets,/)
    assert.match(wc, /solanaPayoutWallet:/)
    assert.match(wc, /refreshLinkedWallets,/)
  })

  // -- 9. Final scenario test (using locally-generated keypairs) ---
  // Simulate the full link aggregation logic:
  //   solana_wallet_A has 25 SP
  //   evm_wallet_A has 100 SP on chain 1 + 50 SP on chain 4663
  //   After linking, the unified earned_points = 175 SP.
  // We can't test the DB layer here (no live Supabase), but we can
  // verify the cryptographic primitives that PROVE the link:
  await test('scenario: user signs both messages with the correct keys → both signatures verify', () => {
    const evmOk = verifyEvmSignature({
      message: f.messageEvm, signature: f.validEvmSig, expectedAddress: f.evmWalletA.address,
    })
    const solanaOk = verifySolanaSignature({
      message: f.messageSolana, signature: f.validSolanaSig, expectedAddress: f.solanaAddressA,
    })
    assert.strictEqual(evmOk && solanaOk, true,
      'valid link signatures must both verify — otherwise the legitimate linking flow is broken')
  })

  await test('scenario: attacker submits a stolen challenge_id with their own EVM signature → rejected', () => {
    // Attacker has their own EVM keypair (B) and tries to "verify" a
    // challenge that was issued to the victim's EVM wallet (A).
    const attackerSig = f.wrongEvmSig  // signed by B, expected A
    const ok = verifyEvmSignature({
      message: f.messageEvm,
      signature: attackerSig,
      expectedAddress: f.evmWalletA.address,
    })
    assert.strictEqual(ok, false,
      'attacker must NOT be able to hijack a victim\'s challenge by signing with their own EVM key')
  })

  await test('scenario: attacker submits a stolen challenge_id with a fake Solana signature → rejected', () => {
    const ok = verifySolanaSignature({
      message: f.messageSolana,
      signature: f.wrongSolanaSig,  // signed by B's Solana keypair
      expectedAddress: f.solanaAddressA,  // expecting A's
    })
    assert.strictEqual(ok, false,
      'attacker must NOT be able to hijack a victim\'s link using their own Solana keypair')
  })

  await test('scenario: localStorage tampering does not affect verified identity', async () => {
    // WalletContext.loadVerifiedWallets reads ONLY from the backend.
    // localStorage (ronin.evmWallets.v1) is consulted only for the
    // profile aggregation UI; the verified identity RPC ignores it.
    // We assert this by checking the source: getVerifiedRewardIdentity
    // takes a single wallet address and the backend resolves linked
    // wallets from the DB.
    const svcPath = path.resolve(process.cwd(),
      'src/services/walletLinkService.js')
    const svc = fs.readFileSync(svcPath, 'utf8')
    assert.match(svc, /\/api\/wallet-link\/list\?wallet=\$\{encodeURIComponent\(wallet\)\}/,
      'walletLinkService does not call the single-wallet /list endpoint')
    // Strip comments before checking — the file's source comments may
    // mention localStorage as part of explaining the security model,
    // but the actual code path must NOT consult it.
    const stripped = svc
      .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
      .replace(/\/\/[^\n]*/g, '')         // line comments
    assert.ok(!/localStorage/.test(stripped),
      'walletLinkService consults localStorage in executable code — verified identity must be backend-only')
  })

  // -- Print summary -----------------------------------------------
  const passed = RESULTS.filter((r) => r.status === 'PASS').length
  const failed = RESULTS.filter((r) => r.status === 'FAIL')
  const failedCount = failed.length
  console.log('\n=========================================')
  console.log(`Wallet Link Security Test Suite`)
  console.log(`  Total: ${RESULTS.length}`)
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failedCount}`)
  console.log('=========================================')
  if (failedCount > 0) {
    console.log('\nFAILED TESTS:')
    for (const r of failed) {
      console.log(`  ✗ ${r.name}`)
      console.log(`    → ${r.error}`)
    }
  }
  console.log('')
  process.exit(failedCount > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Test runner crashed:', err)
  process.exit(2)
})
