// =====================================================================
// Wallet Link — verify-handler schema-sync regression test
// =====================================================================
// Regression test for the bug where the verify handler returned 503
// WALLET_LINK_STORE_UNAVAILABLE because `getPendingChallenge()` asked
// Supabase for a column (`evm_chain_scope`) that no longer exists in
// the wallet_link_challenges table.
//
// Root cause: the migration (supabase/migrations/20260926000000_wallet_links.sql)
// does NOT define an `evm_chain_scope` column on `wallet_link_challenges`
// (the column was intentionally removed — see the migration comments).
// But `getPendingChallenge()` still requested it in the `select=` query
// clause, so Supabase rejected the request (PSQL ERROR 42703 — column
// does not exist) and the handler surfaced it as 503.
//
// This test parses the migration's CREATE TABLE statement for
// `wallet_link_challenges` to extract the actual column names, then
// asserts that EVERY column referenced in `getPendingChallenge()`'s
// `select=` clause actually exists in the table.
//
// Run:
//   node /home/z/my-project/scripts/test_wallet_link_select_clause.mjs
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
  const migrationPath = path.join(repoRoot, 'supabase/migrations/20260926000000_wallet_links.sql')
  const walletLinkAuthPath = path.join(repoRoot, 'api/_lib/walletLinkAuth.mjs')

  const migrationSql = fs.readFileSync(migrationPath, 'utf8')
  const walletLinkAuthSrc = fs.readFileSync(walletLinkAuthPath, 'utf8')

  // ---------------------------------------------------------------------
  // Extract the wallet_link_challenges CREATE TABLE column list
  // ---------------------------------------------------------------------
  // The CREATE TABLE block is between `create table if not exists public.wallet_link_challenges`
  // and the closing `);`.
  function extractTableColumns(sql, tableName) {
    const marker = `create table if not exists public.${tableName} (`
    const start = sql.indexOf(marker)
    if (start < 0) throw new Error(`CREATE TABLE for ${tableName} not found in migration`)
    const openParen = sql.indexOf('(', start)
    // Find the matching close paren — naive but works for our migration
    // (no nested parens at the table level).
    let depth = 1
    let i = openParen + 1
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth += 1
      else if (sql[i] === ')') depth -= 1
      i += 1
    }
    const body = sql.slice(openParen + 1, i - 1)
    // Each line that starts with a column name (lowercase_word or
    // lowercase_word lower_case_word). Skip constraint lines.
    const columns = new Set()
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '').trim()
      if (!line) continue
      if (line.startsWith('constraint ') || line.startsWith('primary key') || line.startsWith('check') || line.startsWith('foreign key') || line.startsWith('unique')) continue
      // The first token (until whitespace) is the column name.
      const colMatch = line.match(/^([a-z_]+)\s/)
      if (colMatch) columns.add(colMatch[1])
    }
    return columns
  }

  const challengesColumns = extractTableColumns(migrationSql, 'wallet_link_challenges')
  const walletLinksColumns = extractTableColumns(migrationSql, 'wallet_links')
  const consumptionColumns = extractTableColumns(migrationSql, 'wallet_point_consumption')

  await test('wallet_link_challenges table has the expected core columns', () => {
    for (const expected of ['challenge_id', 'nonce', 'solana_wallet', 'evm_wallet', 'message_evm', 'message_solana', 'expires_at', 'status', 'used_at', 'created_at']) {
      assert.ok(challengesColumns.has(expected), `Missing column: ${expected} (got: ${[...challengesColumns].join(', ')})`)
    }
  })

  await test('wallet_link_challenges does NOT have evm_chain_scope column (per architecture)', () => {
    assert.ok(!challengesColumns.has('evm_chain_scope'),
      'evm_chain_scope column found on wallet_link_challenges — this should have been removed. ' +
      'If you intentionally re-added it, also update getPendingChallenge() to include it in the select= clause.')
  })

  await test('wallet_links table does NOT have evm_chain_scope column (per architecture)', () => {
    assert.ok(!walletLinksColumns.has('evm_chain_scope'),
      'evm_chain_scope column found on wallet_links — should be removed (per architecture: an EVM address is one row in public.wallets regardless of chain).')
  })

  await test('getPendingChallenge() select clause does NOT request evm_chain_scope', () => {
    // Find the SELECT clause for wallet_link_challenges.
    const selectMatch = walletLinkAuthSrc.match(/wallet_link_challenges\?[^`]*select=([^&`]+)/)
    assert.ok(selectMatch, 'getPendingChallenge select clause not found')
    const selectClause = selectMatch[1]
    assert.ok(!selectClause.includes('evm_chain_scope'),
      `getPendingChallenge select clause still requests evm_chain_scope — Supabase will return 400 (column does not exist) and the verify handler will surface 503 WALLET_LINK_STORE_UNAVAILABLE. select= clause: "${selectClause}"`)
  })

  await test('every column in getPendingChallenge select clause exists in the table', () => {
    // This is the actual regression test — it would have caught the
    // 503 bug the user hit.
    const selectMatch = walletLinkAuthSrc.match(/wallet_link_challenges\?[^`]*select=([^&`]+)/)
    assert.ok(selectMatch, 'getPendingChallenge select clause not found')
    const selectClause = selectMatch[1]
    const requestedCols = selectClause.split(',').map((s) => s.trim()).filter(Boolean)
    for (const col of requestedCols) {
      assert.ok(challengesColumns.has(col),
        `getPendingChallenge requests column "${col}" but it does NOT exist on wallet_link_challenges. ` +
        `Supabase will reject the request and the verify handler will return 503. ` +
        `Actual columns: ${[...challengesColumns].join(', ')}`)
    }
  })

  await test('getPendingChallenge does not map evm_chain_scope in the response', () => {
    // Find the function body (everything from the function signature
    // to the next top-level `}` at column 0). The lazy [\s\S]*? match
    // stops at the first `^}`, which is the function's closing brace.
    const getPendingFnMatch = walletLinkAuthSrc.match(/export async function getPendingChallenge[\s\S]*?^}/m)
    assert.ok(getPendingFnMatch, 'getPendingChallenge function not found')
    const fnBody = getPendingFnMatch[0]
    // Strip comments before checking — the function's documentation
    // comments intentionally mention evm_chain_scope to explain WHY
    // it's not in the select clause. We only care about executable
    // code referencing it.
    const stripped = fnBody
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    assert.ok(!/evm_chain_scope/.test(stripped),
      'getPendingChallenge response still references evm_chain_scope in executable code — should be removed since the column no longer exists.')
  })

  await test('createWalletLinkChallenge POST body does NOT include evm_chain_scope', () => {
    const createFnMatch = walletLinkAuthSrc.match(/export async function createLinkChallenge[\s\S]*?^}/m)
    assert.ok(createFnMatch, 'createLinkChallenge function not found')
    const fnBody = createFnMatch[0]
    // Strip comments (same reason as above).
    const stripped = fnBody
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    assert.ok(!/evm_chain_scope/.test(stripped),
      'createLinkChallenge POST body still includes evm_chain_scope — Supabase would reject the INSERT with 42703 if the column doesn\'t exist (it would silently ignore unknown columns via PostgREST, but better to not send it).')
  })

  await test('frontend walletLinkService does NOT send evmChainScope', () => {
    const svcPath = path.join(repoRoot, 'src/services/walletLinkService.js')
    const svcSrc = fs.readFileSync(svcPath, 'utf8')
    // Strip comments before checking — the file's source comments may
    // mention evmChainScope as part of explaining the security model.
    const stripped = svcSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    assert.ok(!/evmChainScope/.test(stripped),
      'walletLinkService sends evmChainScope in executable code — should be removed since the backend ignores it.')
  })

  // ----- Print summary -----
  const passed = RESULTS.filter((r) => r.status === 'PASS').length
  const failed = RESULTS.filter((r) => r.status === 'FAIL')
  console.log('\n=========================================')
  console.log('Wallet Link Schema-Sync Regression Test')
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
