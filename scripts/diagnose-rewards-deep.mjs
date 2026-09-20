// Deep diagnostic for the "Unable to load reward balance" 502 error.
//
// This script isolates WHERE the failure is happening:
//   1. Are the env vars loaded correctly from .env.local?
//   2. Can we reach Supabase directly with those credentials?
//   3. Does the get_wallet_reward_balance RPC work?
//   4. Does the Vite dev server proxy the request correctly?
//
// Run from your repo root:
//   node scripts/diagnose-rewards-deep.mjs

import dotenv from 'dotenv'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// ---------- Step 1: Load .env.local the same way Vite + supabaseBackend.mjs do ----------
console.log('================================================================')
console.log(' Deep Rewards Diagnostic')
console.log('================================================================')
console.log('')

console.log('[1/5] Loading .env.local...')
dotenv.config({ path: '.env.local', override: true })

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '')
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

console.log(`    SUPABASE_URL:           ${SUPABASE_URL || '(NOT SET)'}`)
console.log(`    SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_KEY ? SUPABASE_KEY.slice(0, 20) + '...' + SUPABASE_KEY.slice(-10) : '(NOT SET)'}`)
console.log(`    SOLANA_RPC_URL:         ${process.env.SOLANA_RPC_URL || '(NOT SET)'}`)
console.log(`    SOLANA_REWARDS_NETWORK: ${process.env.SOLANA_REWARDS_NETWORK || '(NOT SET)'}`)
console.log(`    SOLANA_REWARDS_PROGRAM_ID: ${process.env.SOLANA_REWARDS_PROGRAM_ID || '(NOT SET - will use new mainnet default)'}`)
console.log(`    SOLANA_REWARDS_ADMIN_SECRET_KEY: ${process.env.SOLANA_REWARDS_ADMIN_SECRET_KEY ? '[SET, ' + process.env.SOLANA_REWARDS_ADMIN_SECRET_KEY.length + ' chars]' : '(NOT SET)'}`)
console.log(`    SOLANA_REWARDS_ADMIN_KEYPAIR: ${process.env.SOLANA_REWARDS_ADMIN_KEYPAIR ? '[STILL SET - REMOVE THIS]' : '(not set, good)'}`)
console.log('')

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('    [FAIL] Supabase credentials are NOT in .env.local')
  console.log('           Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local')
  process.exit(1)
}
console.log('    [OK] Supabase credentials are present')
console.log('')

// ---------- Step 2: Read the raw .env.local file to check for syntax issues ----------
console.log('[2/5] Checking .env.local for syntax issues...')
try {
  const raw = await readFile(path.resolve('.env.local'), 'utf8')
  const lines = raw.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'))
  let issues = 0
  for (const line of lines) {
    const eqIdx = line.indexOf('=')
    if (eqIdx < 0) continue
    const key = line.slice(0, eqIdx).trim()
    const val = line.slice(eqIdx + 1).trim()
    // Check for common issues:
    // - JSON array values without quotes (SOLANA_REWARDS_ADMIN_KEYPAIR=[...])
    // - Values with spaces but no quotes
    // - Trailing spaces after quotes
    if (key === 'SOLANA_REWARDS_ADMIN_KEYPAIR' && val.startsWith('[')) {
      console.log(`    [WARN] ${key} is set to a JSON array. This is the BUG from earlier.`)
      console.log('           The code treats this as a FILE PATH, not a JSON array.')
      console.log('           Remove this line and use SOLANA_REWARDS_ADMIN_SECRET_KEY instead.')
      issues += 1
    }
    if (key === 'SOLANA_REWARDS_ADMIN_SECRET_KEY' && !val.startsWith('[')) {
      console.log(`    [WARN] ${key} should be a JSON array starting with [`)
      issues += 1
    }
    // Check for unquoted values with special characters
    if (!val.startsWith('"') && !val.startsWith("'") && val.includes(' ') && !val.startsWith('[')) {
      console.log(`    [WARN] ${key} has unquoted value with spaces: ${val.slice(0, 40)}`)
      issues += 1
    }
  }
  if (issues === 0) {
    console.log('    [OK] No obvious syntax issues found')
  }
} catch (e) {
  console.log(`    [FAIL] Could not read .env.local: ${e.message}`)
}
console.log('')

// ---------- Step 3: Call the Supabase RPC directly ----------
console.log('[3/5] Calling Supabase RPC get_wallet_reward_balance directly...')
const WALLET = process.env.TEST_WALLET || 'jcJnPd1i1VzaTy4gR4LrKcMyZSgKmC8vy5n5fLo7EHv'
console.log(`    Wallet: ${WALLET}`)

try {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_wallet_reward_balance`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ p_wallet_address: WALLET }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await resp.text()
  console.log(`    HTTP status: ${resp.status}`)
  if (resp.ok) {
    const body = JSON.parse(text)
    console.log('    [OK] RPC succeeded!')
    console.log(`    earned_points:      ${body.earned_points}`)
    console.log(`    claimed_points:     ${body.claimed_points}`)
    console.log(`    claimable_points:   ${body.claimable_points}`)
    console.log(`    rewards_enabled:    ${body.rewards_enabled}`)
    console.log(`    has_active_season:  ${body.has_active_season}`)
    console.log(`    reward_asset:       ${body.reward_asset}`)
    console.log(`    reward_points_per_unit: ${body.reward_points_per_unit}`)
  } else {
    console.log('    [FAIL] RPC returned an error!')
    console.log(`    Response body: ${text.slice(0, 500)}`)
    if (resp.status === 404) {
      console.log('    The RPC function does not exist in Supabase.')
      console.log('    Run the migration: supabase/migrations/20260917000000_reward_claims.sql')
    } else if (resp.status === 401 || resp.status === 403) {
      console.log('    The service role key is invalid or expired.')
    }
  }
} catch (e) {
  console.log(`    [FAIL] Could not reach Supabase: ${e.message}`)
  console.log('    Check your internet connection and SUPABASE_URL value.')
}
console.log('')

// ---------- Step 4: Check the Supabase admin settings row ----------
console.log('[4/5] Checking samurai_admin_settings row...')
try {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/samurai_admin_settings?id=eq.default&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' },
  })
  const text = await resp.text()
  if (resp.ok) {
    const rows = JSON.parse(text)
    if (rows.length === 0) {
      console.log('    [FAIL] No row with id="default" exists in samurai_admin_settings')
      console.log('           Run: supabase/migrations/20260920000000_enable_mainnet_rewards.sql')
    } else {
      const s = rows[0]
      console.log(`    sol_rewards_enabled:    ${s.sol_rewards_enabled}`)
      console.log(`    points_enabled:         ${s.points_enabled}`)
      console.log(`    reward_asset:           ${s.reward_asset}`)
      console.log(`    reward_points_per_unit: ${s.reward_points_per_unit}`)
      console.log(`    updated_by:             ${s.updated_by || '(none)'}`)
      console.log(`    updated_at:             ${s.updated_at || '(none)'}`)
      if (!s.sol_rewards_enabled) {
        console.log('    [FAIL] sol_rewards_enabled is FALSE - run the mainnet migration!')
      } else {
        console.log('    [OK] sol_rewards_enabled is TRUE')
      }
    }
  } else {
    console.log(`    [FAIL] HTTP ${resp.status}: ${text.slice(0, 300)}`)
  }
} catch (e) {
  console.log(`    [FAIL] ${e.message}`)
}
console.log('')

// ---------- Step 5: Test the Vite dev server endpoint ----------
console.log('[5/5] Testing Vite dev server endpoint /api/rewards/balance...')
try {
  const resp = await fetch(`http://localhost:5173/api/rewards/balance?wallet=${WALLET}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await resp.text()
  console.log(`    HTTP status: ${resp.status}`)
  console.log(`    Content-Type: ${resp.headers.get('content-type')}`)
  if (resp.ok) {
    const body = JSON.parse(text)
    console.log('    [OK] Dev server returned a valid response!')
    console.log(`    earned_points:    ${body.earned_points}`)
    console.log(`    claimable_points: ${body.claimable_points}`)
    console.log(`    network:          ${body.network}`)
  } else {
    console.log('    [FAIL] Dev server returned an error')
    console.log(`    Body: ${text.slice(0, 400)}`)
    console.log('')
    console.log('    The dev server API handler is failing. Check the Vite terminal')
    console.log('    for this log line:')
    console.log('      "rewards/balance RPC failed: <status> <body>"')
    console.log('    That will show the exact Supabase error.')
  }
} catch (e) {
  console.log(`    [FAIL] Could not reach dev server: ${e.message}`)
  console.log('    Is `npm run dev` running on port 5173?')
}
console.log('')

// ---------- Final summary ----------
console.log('================================================================')
console.log(' If steps 3+4 passed but step 5 failed:')
console.log('   The issue is that Vite is not loading your .env.local correctly.')
console.log('   Fix: Ctrl+C the dev server, run `npm run dev` again.')
console.log('   Vite does NOT hot-reload .env.local or vite.config.js changes.')
console.log('================================================================')
