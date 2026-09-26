// =====================================================================
// Wallet Link — link_wallets() ON CONFLICT partial-index test
// =====================================================================
// Regression test for the bug where the link_wallets() RPC raised:
//
//   "there is no unique or exclusion constraint matching the
//    ON CONFLICT specification"
//
// Root cause: the RPC used `ON CONFLICT (solana_wallet, evm_wallet)`
// but the unique constraint is a PARTIAL index that only applies
// WHERE status = 'ACTIVE'. Postgres requires the index predicate to
// be included in the ON CONFLICT clause.
//
// This test parses both migration files (the original + the fix)
// and verifies that AT LEAST ONE of them has the correct ON CONFLICT
// clause with the partial-index predicate.
//
// Run:
//   node /home/z/my-project/scripts/test_wallet_link_on_conflict.mjs
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
  const fixMigration = path.join(repoRoot, 'supabase/migrations/20260927000000_link_wallets_on_conflict_fix.sql')

  const originalSql = fs.readFileSync(originalMigration, 'utf8')
  const fixSql = fs.existsSync(fixMigration) ? fs.readFileSync(fixMigration, 'utf8') : ''

  await test('original migration defines the partial unique index', () => {
    assert.match(
      originalSql,
      /create unique index if not exists wallet_links_pair_active_uidx[\s\S]*?on public\.wallet_links\s*\(\s*solana_wallet\s*,\s*evm_wallet\s*\)\s*where status = 'ACTIVE'/i,
      'the partial unique index on (solana_wallet, evm_wallet) WHERE status=\'ACTIVE\' must exist in the original migration'
    )
  })

  await test('original link_wallets RPC has ON CONFLICT (solana_wallet, evm_wallet) — but WITHOUT the partial-index predicate (the bug)', () => {
    // Extract the link_wallets function body from the original migration.
    const fnStart = originalSql.indexOf('create or replace function public.link_wallets(')
    const fnEnd = originalSql.indexOf('revoke execute on function public.link_wallets')
    assert.ok(fnStart > 0 && fnEnd > fnStart, 'link_wallets function not found in original migration')
    const fnBody = originalSql.slice(fnStart, fnEnd)
    // The buggy version: ON CONFLICT (solana_wallet, evm_wallet) — no
    // partial-index predicate. This SHOULD be flagged by this test
    // (we expect to find the buggy version here, so we can verify
    // the fix migration corrects it).
    assert.match(
      fnBody,
      /on conflict\s*\(\s*solana_wallet\s*,\s*evm_wallet\s*\)\s*do update/i,
      'original link_wallets RPC should have the buggy ON CONFLICT (without WHERE clause)'
    )
    // The buggy version does NOT include the WHERE status='ACTIVE' predicate
    // on the ON CONFLICT clause. Verify it's missing.
    const onConflictMatch = fnBody.match(/on conflict\s*\(\s*solana_wallet\s*,\s*evm_wallet\s*\)([\s\S]*?)do update/i)
    assert.ok(onConflictMatch, 'ON CONFLICT clause not found in original RPC')
    const betweenClauseAndDo = onConflictMatch[1]
    assert.ok(
      !/where\s+status\s*=\s*'ACTIVE'/i.test(betweenClauseAndDo),
      'original link_wallets RPC has the partial-index predicate in the ON CONFLICT clause — but this test expected the BUGGY version (no predicate). ' +
      'If you intentionally fixed the original migration, update this test to skip this assertion.'
    )
  })

  await test('fix migration exists and contains a corrected link_wallets RPC with the partial-index predicate', () => {
    assert.ok(fixSql, 'fix migration file (20260927000000_link_wallets_on_conflict_fix.sql) is missing — create it with the corrected link_wallets function')
    // The fix migration must define the link_wallets function with
    // `ON CONFLICT (solana_wallet, evm_wallet) WHERE status = 'ACTIVE'`
    assert.match(
      fixSql,
      /on conflict\s*\(\s*solana_wallet\s*,\s*evm_wallet\s*\)\s*where status = 'ACTIVE'\s*do update/i,
      'fix migration must include `ON CONFLICT (solana_wallet, evm_wallet) WHERE status = \'ACTIVE\' DO UPDATE` — this is the partial-index predicate that Postgres requires'
    )
  })

  await test('fix migration does NOT change the table schema (only the function)', () => {
    // Strip comments before checking — the migration's documentation
    // comments intentionally mention 'unique index' / 'alter table'
    // etc. as part of explaining the fix. We only care about
    // executable SQL not changing the schema.
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
    assert.match(fixSql, /security definer/i, 'fix must preserve SECURITY DEFINER')
    assert.match(fixSql, /set search_path = public/i, 'fix must preserve `set search_path = public`')
    assert.match(fixSql, /revoke execute on function public\.link_wallets\(text, text, text, text, text\) from public, anon, authenticated/i,
      'fix must revoke execute from public/anon/authenticated')
    assert.match(fixSql, /grant execute on function public\.link_wallets\(text, text, text, text, text\) to service_role/i,
      'fix must grant execute to service_role only')
  })

  await test('fix migration preserves all the original exception codes (CHALLENGE_NOT_FOUND, CHALLENGE_NOT_PENDING, etc)', () => {
    // The fix should not silently remove any of the original exception
    // codes — those are part of the security model.
    for (const code of [
      'CHALLENGE_ID_REQUIRED',
      'EVM_SIGNATURE_REQUIRED',
      'SOLANA_SIGNATURE_REQUIRED',
      'CHALLENGE_NOT_FOUND',
      'CHALLENGE_NOT_PENDING',
      'CHALLENGE_EXPIRED',
      'EVM_SIGNER_MISMATCH',
      'SOLANA_SIGNER_MISMATCH',
      'EVM_ALREADY_LINKED_ELSEWHERE',
    ]) {
      assert.ok(
        fixSql.includes(`'${code}'`),
        `fix migration is missing exception code: ${code} — the original RPC raised this in some path; the fix must preserve it`
      )
    }
  })

  // ----- Print summary -----
  const passed = RESULTS.filter((r) => r.status === 'PASS').length
  const failed = RESULTS.filter((r) => r.status === 'FAIL')
  console.log('\n=========================================')
  console.log('Wallet Link ON CONFLICT partial-index test')
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
