// =====================================================================
// claim_reward() ON CONFLICT partial-index regression test
// =====================================================================
// Regression test for the bug where claim_reward() raised:
//
//   "there is no unique or exclusion constraint matching the
//    ON CONFLICT specification"
//
// Root cause: the FIFO-distribution loop's INSERT into
// wallet_point_consumption used:
//
//   ON CONFLICT (wallet_id, claim_id) DO NOTHING
//
// But the unique constraint is a PARTIAL index that only applies
// WHERE claim_id IS NOT NULL. Postgres requires the predicate to be
// in the ON CONFLICT clause.
//
// This test parses both migration files and verifies:
//   1. The original migration defines the partial unique index
//   2. The original claim_reward RPC has the buggy ON CONFLICT
//      (without the predicate)
//   3. The fix migration defines a corrected claim_reward RPC with
//      `ON CONFLICT (wallet_id, claim_id) WHERE claim_id IS NOT NULL`
//   4. The fix migration doesn't change the table schema
//   5. The fix preserves all security invariants (SECURITY DEFINER,
//      search_path, service_role-only grants, all exception codes)
//
// Run:
//   node /home/z/my-project/scripts/test_wallet_link_claim_on_conflict.mjs
// =====================================================================

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'

const RESULTS = []
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => RESULTS.push({ name, status: 'PASS' }),
    (err) => RESULTS.push({ name, status: 'FAIL', error: err?.message || String(err) })
  )
}

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const originalMigration = path.join(repoRoot, 'supabase/migrations/20260926000000_wallet_links.sql')
  const fixMigration = path.join(repoRoot, 'supabase/migrations/20260928000000_claim_reward_on_conflict_fix.sql')

  const originalSql = fs.readFileSync(originalMigration, 'utf8')
  const fixSql = fs.existsSync(fixMigration) ? fs.readFileSync(fixMigration, 'utf8') : ''

  await test('original migration defines the partial unique index on wallet_point_consumption', () => {
    assert.match(
      originalSql,
      /create unique index if not exists wallet_point_consumption_wallet_claim_uidx[\s\S]*?on public\.wallet_point_consumption\s*\(\s*wallet_id\s*,\s*claim_id\s*\)\s*where claim_id is not null/i,
      'the partial unique index on (wallet_id, claim_id) WHERE claim_id IS NOT NULL must exist in the original migration'
    )
  })

  await test('original claim_reward RPC has ON CONFLICT (wallet_id, claim_id) — but WITHOUT the partial-index predicate (the bug)', () => {
    const fnStart = originalSql.indexOf('create or replace function public.claim_reward(')
    const fnEnd = originalSql.indexOf('revoke execute on function public.claim_reward')
    assert.ok(fnStart > 0 && fnEnd > fnStart, 'claim_reward function not found in original migration')
    const fnBody = originalSql.slice(fnStart, fnEnd)
    // The buggy version: ON CONFLICT (wallet_id, claim_id) — no
    // partial-index predicate.
    assert.match(
      fnBody,
      /on conflict\s*\(\s*wallet_id\s*,\s*claim_id\s*\)\s*do nothing/i,
      'original claim_reward RPC should have the buggy ON CONFLICT (without WHERE clause) on the wallet_point_consumption INSERT'
    )
    // Verify the buggy version does NOT include the WHERE clause.
    const onConflictMatch = fnBody.match(/on conflict\s*\(\s*wallet_id\s*,\s*claim_id\s*\)([\s\S]*?)do nothing/i)
    assert.ok(onConflictMatch, 'ON CONFLICT clause not found in original RPC')
    const betweenClauseAndDo = onConflictMatch[1]
    assert.ok(
      !/where\s+claim_id\s+is\s+not\s+null/i.test(betweenClauseAndDo),
      'original claim_reward RPC has the partial-index predicate in the ON CONFLICT clause — but this test expected the BUGGY version (no predicate).'
    )
  })

  await test('fix migration exists and contains a corrected claim_reward RPC with the partial-index predicate', () => {
    assert.ok(fixSql, 'fix migration file (20260928000000_claim_reward_on_conflict_fix.sql) is missing')
    assert.match(
      fixSql,
      /on conflict\s*\(\s*wallet_id\s*,\s*claim_id\s*\)\s*where claim_id is not null\s*do nothing/i,
      'fix migration must include `ON CONFLICT (wallet_id, claim_id) WHERE claim_id IS NOT NULL DO NOTHING` — this is the partial-index predicate'
    )
  })

  await test('fix migration does NOT change the table schema (only the function)', () => {
    const stripped = fixSql
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '')
    assert.ok(!/create table/i.test(stripped), 'fix migration should not create any tables')
    assert.ok(!/alter table/i.test(stripped), 'fix migration should not alter any tables')
    assert.ok(!/create (unique )?index/i.test(stripped), 'fix migration should not create any indexes')
    assert.ok(!/drop table/i.test(stripped), 'fix migration should not drop any tables')
    assert.ok(!/drop function/i.test(stripped), 'fix migration should not drop any functions')
  })

  await test('fix migration preserves SECURITY DEFINER + search_path=public + service_role-only grants', () => {
    assert.match(fixSql, /security definer/i)
    assert.match(fixSql, /set search_path = public/i)
    assert.match(fixSql, /revoke execute on function public\.claim_reward\(text, text, numeric, text, jsonb\) from public, anon, authenticated/i)
    assert.match(fixSql, /grant execute on function public\.claim_reward\(text, text, numeric, text, jsonb\) to service_role/i)
  })

  await test('fix migration preserves all original exception codes', () => {
    for (const code of [
      'WALLET_REQUIRED',
      'INVALID_CLAIM_ID',
      'INVALID_POINTS_AMOUNT',
      'EVM_CLAIM_NOT_ALLOWED',
      'INVALID_WALLET_FORMAT',
      'SOLANA_REWARD_IDENTITY_NOT_FOUND',
      'WALLET_NOT_FOUND',
      'WALLET_EXCLUDED',
      'REWARD_IDENTITY_WALLETS_NOT_FOUND',
      'CLAIM_ID_CONFLICT',
      'REWARDS_DISABLED',
      'NO_ACTIVE_SEASON',
      'NO_CLAIMABLE_POINTS',
      'INSUFFICIENT_CLAIMABLE_POINTS',
      'INVALID_CONVERSION_RATE',
      'CONSUMPTION_DISTRIBUTION_FAILED',
    ]) {
      // Some exception codes are followed by additional context
      // (e.g., 'CONSUMPTION_DISTRIBUTION_FAILED: remaining=%'), so
      // we check the code appears inside a quoted raise-exception
      // string. The pattern matches either:
      //   raise exception 'CODE'    (exact code, closing quote right after)
      //   raise exception 'CODE:...' (code followed by colon + context)
      // [':] is a character class — must include the brackets.
      const pattern = new RegExp(`raise exception '${code}[':]`)
      assert.ok(
        pattern.test(fixSql),
        `fix migration is missing exception code: ${code}`
      )
    }
  })

  await test('fix migration preserves EVM_CLAIM_NOT_ALLOWED (the security invariant: EVM addresses can never be Solana payout recipients)', () => {
    // This is the critical security invariant — must be present.
    assert.match(fixSql, /if v_input_is_evm then[\s\S]*?raise exception 'EVM_CLAIM_NOT_ALLOWED'/i,
      'fix migration must preserve the EVM_CLAIM_NOT_ALLOWED check at the top of claim_reward')
  })

  await test('fix migration preserves the FIFO distribution loop', () => {
    // The fix must not remove the per-wallet FIFO distribution
    // (Solana first, then EVMs by verified_at ASC).
    assert.match(fixSql, /foreach v_wallet_id in array v_wallet_ids_ordered/i,
      'fix migration must preserve the `foreach v_wallet_id in ARRAY v_wallet_ids_ordered` loop. ' +
      'NOTE: Postgres REQUIRES the `ARRAY` keyword — without it, Postgres raises: ' +
      'syntax error at or near "v_wallet_ids_ordered"')
    assert.match(fixSql, /v_wallet_ids_ordered := array\[wallet_row\.id\]/i,
      'fix migration must preserve the Solana-first ordering')
    assert.match(fixSql, /select array_agg\(w\.id order by wl\.verified_at asc\) into evm_ids/i,
      'fix migration must preserve the EVM-by-verified_at-asc ordering')
  })

  await test('fix migration preserves the MIGRATION_BACKFILL safety (does NOT touch wallet_point_consumption)', () => {
    // The fix must not DELETE or UPDATE wallet_point_consumption
    // outside of the FIFO INSERT loop. The backfill rows (existing
    // claimed_points values) must remain intact.
    const stripped = fixSql
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '')
    // Look for any DELETE or UPDATE on wallet_point_consumption.
    // (INSERTs are OK — they're the FIFO distribution.)
    assert.ok(!/delete from public\.wallet_point_consumption/i.test(stripped),
      'fix migration must not DELETE from wallet_point_consumption — would erase the MIGRATION_BACKFILL safety')
    assert.ok(!/update public\.wallet_point_consumption/i.test(stripped),
      'fix migration must not UPDATE wallet_point_consumption — would erase the MIGRATION_BACKFILL safety')
  })

  // ----- Print summary -----
  const passed = RESULTS.filter((r) => r.status === 'PASS').length
  const failed = RESULTS.filter((r) => r.status === 'FAIL')
  console.log('\n=========================================')
  console.log('claim_reward ON CONFLICT partial-index test')
  console.log(`  Total: ${RESULTS.length}`)
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failed.length}`)
  console.log('=========================================')
  if (failed.length > 0) {
    console.log('\nFAILED TESTS:')
    for (const r of failed) {
      console.log(`  ✗ ${r.name}`)
      console.log(`    → ${r.error}`)
    }
  }
  console.log('')
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Test runner crashed:', err)
  process.exit(2)
})
