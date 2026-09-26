// =====================================================================
// revert_failed_reward_claim() consumption-ledger regression test
// =====================================================================
// Regression test for the bug where reverting a claim marked it as
// FAILED but did NOT restore the user's claimable points.
//
// Root cause: the original revert_failed_reward_claim() RPC only
// decremented wallets.claimed_points (the legacy counter) but did
// NOT delete the wallet_point_consumption rows for that claim_id.
// In the new accounting model, wallet_point_consumption is the
// AUTHORITATIVE consumed-points ledger — so the consumed points
// stayed high and claimable stayed at 0.
//
// This test verifies the fix migration includes a DELETE from
// wallet_point_consumption inside the revert RPC.
//
// Run:
//   node /home/z/my-project/scripts/test_wallet_link_revert_consumption.mjs
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
  const originalMigration = path.join(repoRoot, 'supabase/migrations/20260918000000_reward_payout_int.sql')
  const fixMigration = path.join(repoRoot, 'supabase/migrations/20260929000000_revert_claim_consumption_fix.sql')

  const originalSql = fs.readFileSync(originalMigration, 'utf8')
  const fixSql = fs.existsSync(fixMigration) ? fs.readFileSync(fixMigration, 'utf8') : ''

  await test('original revert_failed_reward_claim RPC does NOT delete wallet_point_consumption rows (the bug)', () => {
    // Extract the function body from the original migration.
    const fnStart = originalSql.indexOf('create or replace function public.revert_failed_reward_claim(')
    const fnEnd = originalSql.indexOf('revoke execute on function public.revert_failed_reward_claim')
    assert.ok(fnStart > 0 && fnEnd > fnStart, 'revert_failed_reward_claim function not found in original migration')
    const fnBody = originalSql.slice(fnStart, fnEnd)
    // Strip comments before checking.
    const stripped = fnBody
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '')
    // The buggy version does NOT delete from wallet_point_consumption.
    assert.ok(!/delete from public\.wallet_point_consumption/i.test(stripped),
      'original revert_failed_reward_claim RPC already has a DELETE from wallet_point_consumption — but this test expected the BUGGY version (no DELETE).')
  })

  await test('fix migration exists', () => {
    assert.ok(fixSql, 'fix migration file (20260929000000_revert_claim_consumption_fix.sql) is missing')
  })

  await test('fix migration includes DELETE from wallet_point_consumption WHERE claim_id = p_claim_id', () => {
    assert.ok(fixSql, 'fix migration is missing')
    assert.match(
      fixSql,
      /delete from public\.wallet_point_consumption\s+where claim_id = p_claim_id/i,
      'fix migration must include `DELETE FROM public.wallet_point_consumption WHERE claim_id = p_claim_id` — this is the fix that restores the user\'s claimable points when a claim is reverted'
    )
  })

  await test('fix migration deletes BEFORE decrementing claimed_points', () => {
    // The DELETE must happen BEFORE the claimed_points decrement so
    // that if anything fails mid-revert, the consumption ledger is
    // already clean (the authoritative source is correct even if
    // the legacy counter is stale).
    const deleteIdx = fixSql.search(/delete from public\.wallet_point_consumption/i)
    const decrementIdx = fixSql.search(/update public\.wallets\s+set claimed_points/i)
    assert.ok(deleteIdx > 0, 'DELETE statement not found')
    assert.ok(decrementIdx > 0, 'UPDATE wallets.claimed_points statement not found')
    assert.ok(deleteIdx < decrementIdx,
      'DELETE from wallet_point_consumption must come BEFORE the UPDATE wallets.claimed_points — so the authoritative ledger is cleaned first')
  })

  await test('fix migration does NOT delete MIGRATION_BACKFILL rows', () => {
    // MIGRATION_BACKFILL rows have claim_id = NULL. The DELETE
    // `WHERE claim_id = p_claim_id` won't match NULL (NULL != any
    // value in SQL). So backfill rows are preserved — which is
    // correct, because they represent legacy claimed_points that
    // were claimed before the wallet-link migration.
    assert.match(
      fixSql,
      /delete from public\.wallet_point_consumption\s+where claim_id = p_claim_id/i,
      'fix migration must use `WHERE claim_id = p_claim_id` (not `WHERE claim_id IS NULL` or no WHERE) — MIGRATION_BACKFILL rows have claim_id=NULL and are preserved by the NULL-safe WHERE clause'
    )
    // Verify the fix migration does NOT delete ALL rows (no DELETE
    // without WHERE).
    assert.ok(!/delete from public\.wallet_point_consumption\s*;$/im.test(fixSql),
      'fix migration must NOT delete ALL wallet_point_consumption rows — only the ones for this claim_id')
  })

  await test('fix migration preserves all original exception codes + idempotency + security', () => {
    // Codes that appear in `raise exception` statements:
    const raiseCodes = [
      'CLAIM_ID_REQUIRED',
      'CLAIM_NOT_FOUND',
      'CANNOT_REVERT_COMPLETED',
      'INVALID_REVERSION_STATE',
      'WALLET_NOT_FOUND',
    ]
    for (const code of raiseCodes) {
      const pattern = new RegExp(`raise exception '${code}[':]`)
      assert.ok(pattern.test(fixSql),
        `fix migration is missing raise-exception code: ${code}`)
    }
    // ALREADY_FAILED is returned as a reason string in the idempotent
    // path (not raised as an exception), so we check for it differently.
    assert.ok(fixSql.includes("'ALREADY_FAILED'"),
      'fix migration is missing the ALREADY_FAILED idempotent reason string')
    // Idempotent: already FAILED → no-op (returns reverted=false)
    assert.match(fixSql, /if claim_row\.status = 'FAILED' then/i, 'fix must preserve idempotency (already FAILED → no-op)')
    // Won't revert COMPLETED claims
    assert.match(fixSql, /if claim_row\.status = 'COMPLETED' then/i, 'fix must preserve CANNOT_REVERT_COMPLETED check')
    // SECURITY DEFINER + search_path + service_role-only
    assert.match(fixSql, /security definer/i)
    assert.match(fixSql, /set search_path = public/i)
    assert.match(fixSql, /revoke execute on function public\.revert_failed_reward_claim\(text, text\) from public, anon, authenticated/i)
    assert.match(fixSql, /grant execute on function public\.revert_failed_reward_claim\(text, text\) to service_role/i)
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

  // ----- Print summary -----
  const passed = RESULTS.filter((r) => r.status === 'PASS').length
  const failed = RESULTS.filter((r) => r.status === 'FAIL')
  console.log('\n=========================================')
  console.log('revert_failed_reward_claim consumption-ledger test')
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
