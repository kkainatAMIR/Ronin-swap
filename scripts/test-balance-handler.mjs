// Mimics EXACTLY what api/rewards/balance.mjs does — uses process.env directly
// (not the supabaseBackend.mjs constants) to call the Supabase RPC.
//
// This reproduces the Vite dev server's code path outside of Vite, so we can
// see the exact Supabase error without the Vite middleware in the way.
//
// Run: node scripts/test-balance-handler.mjs

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local', override: true })

const WALLET = process.env.TEST_WALLET || 'jcJnPd1i1VzaTy4gR4LrKcMyZSgKmC8vy5n5fLo7EHv'

console.log('================================================================')
console.log(' Test: api/rewards/balance handler code path')
console.log('================================================================')
console.log('')

// ---------- Check raw env values (including hidden characters) ----------
console.log('[1] Raw env values (with hidden characters shown):')
const supabaseUrl = process.env.SUPABASE_URL || ''
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

console.log(`    SUPABASE_URL length: ${supabaseUrl.length}`)
console.log(`    SUPABASE_URL value:  "${supabaseUrl}"`)
console.log(`    SUPABASE_URL hex (last 10 chars): ${Buffer.from(supabaseUrl.slice(-10)).toString('hex')}`)
console.log('')
console.log(`    SUPABASE_SERVICE_ROLE_KEY length: ${supabaseKey.length}`)
console.log(`    SUPABASE_SERVICE_ROLE_KEY first 30: ${supabaseKey.slice(0, 30)}`)
console.log(`    SUPABASE_SERVICE_ROLE_KEY last 30:  ${supabaseKey.slice(-30)}`)
console.log(`    SUPABASE_SERVICE_ROLE_KEY hex (last 10 chars): ${Buffer.from(supabaseKey.slice(-10)).toString('hex')}`)
console.log('')

// Check for hidden characters (CRLF, stray quotes, etc.)
if (supabaseUrl.includes('\r')) {
  console.log('    [!] SUPABASE_URL contains \\r (Windows line ending issue)')
}
if (supabaseUrl.endsWith('"') || supabaseUrl.endsWith("'")) {
  console.log(`    [!] SUPABASE_URL ends with a stray quote: ${supabaseUrl.slice(-3)}`)
}
if (supabaseKey.includes('\r')) {
  console.log('    [!] SUPABASE_SERVICE_ROLE_KEY contains \\r (Windows line ending issue)')
}
if (supabaseKey.endsWith('"') || supabaseKey.endsWith("'")) {
  console.log(`    [!] SUPABASE_SERVICE_ROLE_KEY ends with a stray quote: ${supabaseKey.slice(-3)}`)
}
console.log('')

// ---------- Reproduce the exact balance.mjs fetch ----------
console.log('[2] Calling Supabase RPC (same code as api/rewards/balance.mjs)...')
console.log(`    URL: ${supabaseUrl}/rest/v1/rpc/get_wallet_reward_balance`)
console.log(`    Wallet: ${WALLET}`)
console.log('')

try {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/get_wallet_reward_balance`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ p_wallet_address: WALLET }),
    signal: AbortSignal.timeout(15_000),
  })

  const text = await response.text()
  console.log(`    HTTP status: ${response.status}`)
  console.log(`    HTTP ok: ${response.ok}`)
  console.log(`    Response body (first 500 chars):`)
  console.log(`    ${text.slice(0, 500)}`)
  console.log('')

  if (!response.ok) {
    console.log('    [FAIL] Supabase returned an error!')
    console.log('    This is the EXACT error the Vite dev server would log as:')
    console.log(`    "rewards/balance RPC failed: ${response.status} ${text.slice(0, 200)}"`)
    console.log('')

    if (response.status === 401 || response.status === 403) {
      console.log('    DIAGNOSIS: Supabase rejected the service role key.')
      console.log('    Check for:')
      console.log('      - Stray quotes at the end of SUPABASE_SERVICE_ROLE_KEY in .env.local')
      console.log('      - Windows CRLF (\\r) characters in the value')
      console.log('      - The key was rotated/changed and is no longer valid')
    } else if (response.status === 404) {
      console.log('    DIAGNOSIS: The RPC function get_wallet_reward_balance does not exist.')
      console.log('    Run: supabase/migrations/20260917000000_reward_claims.sql')
    } else if (response.status === 500) {
      console.log('    DIAGNOSIS: Supabase internal error. The RPC function raised an exception.')
      console.log('    Check the Supabase dashboard → Logs → Postgres for the error.')
    }
  } else {
    const body = JSON.parse(text)
    console.log('    [OK] RPC succeeded!')
    console.log(`    earned_points:      ${body.earned_points}`)
    console.log(`    claimable_points:   ${body.claimable_points}`)
    console.log(`    rewards_enabled:    ${body.rewards_enabled}`)
    console.log('')
    console.log('    If the Vite dev server STILL returns 502, the issue is that Vite is')
    console.log('    not loading .env.local correctly. Fix:')
    console.log('      1. Ctrl+C the dev server')
    console.log('      2. npm run dev')
    console.log('      3. Hard refresh browser (Ctrl+Shift+R)')
  }
} catch (error) {
  console.log(`    [FAIL] fetch threw an error: ${error.message}`)
  console.log('')
  if (error.name === 'TypeError') {
    console.log('    This is usually an invalid URL. Check SUPABASE_URL for:')
    console.log('      - Stray quotes at the end')
    console.log('      - Windows CRLF (\\r) characters')
    console.log('      - Missing protocol (http:// or https://)')
  }
}
console.log('')

// ---------- Also check SOLANA_RPC_URL for the same issues ----------
console.log('[3] Checking SOLANA_RPC_URL for issues...')
const solanaRpc = process.env.SOLANA_RPC_URL || ''
console.log(`    Value: "${solanaRpc}"`)
console.log(`    Length: ${solanaRpc.length}`)
console.log(`    Hex (last 10 chars): ${Buffer.from(solanaRpc.slice(-10)).toString('hex')}`)
if (solanaRpc.includes('\r')) {
  console.log('    [!] Contains \\r (Windows line ending)')
}
if (solanaRpc.endsWith('"') || solanaRpc.endsWith("'")) {
  console.log(`    [!] Ends with stray quote: ${solanaRpc.slice(-3)}`)
}
if (solanaRpc.includes('devnet')) {
  console.log('    [!] Points to DEVNET — should be mainnet for production rewards')
  console.log('    Fix: change to https://mainnet.helius-rpc.com/?api-key=...')
}
if (solanaRpc.includes('mainnet')) {
  console.log('    [OK] Points to mainnet')
}
console.log('================================================================')
