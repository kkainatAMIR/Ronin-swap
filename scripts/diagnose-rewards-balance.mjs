// Local end-to-end diagnostic for the "Unable to load reward balance" error.
//
// Run this from your local Ronin-swap repo root with `npm run dev` running:
//   node scripts/diagnose-rewards-balance.mjs
//
// It will hit your local Vite dev server (http://localhost:5173) and report
// exactly where the chain breaks: Vite route registration, API handler,
// Supabase RPC, or on-chain read.

const DEV_SERVER = 'http://localhost:5173'
const WALLET = process.env.TEST_WALLET || 'jcJnPd1i1VzaTy4gR4LrKcMyZSgKmC8vy5n5fLo7EHv'

console.log('================================================================')
console.log(' Rewards Balance Diagnostic')
console.log('================================================================')
console.log(`  Dev server: ${DEV_SERVER}`)
console.log(`  Test wallet: ${WALLET}`)
console.log('')

// ---------- Step 1: Vite route registration ----------
console.log('[1/4] Checking if /api/rewards/balance route is registered in Vite...')
let step1Pass = false
try {
  const resp = await fetch(`${DEV_SERVER}/api/rewards/balance?wallet=${WALLET}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  const text = await resp.text()
  const contentType = resp.headers.get('content-type') || ''

  console.log(`    HTTP status: ${resp.status}`)
  console.log(`    Content-Type: ${contentType}`)

  if (contentType.includes('application/json')) {
    console.log('    [OK] Route is registered and returned JSON')
    step1Pass = true
  } else if (contentType.includes('text/html')) {
    console.log('    [FAIL] Route returned HTML (the SPA index.html).')
    console.log('           This means /api/rewards/balance is NOT in vite.config.js LOCAL_API_HANDLERS.')
    console.log('           Fix: pull the latest commit (9423776) and RESTART npm run dev.')
    console.log('           First 200 chars of body:', text.slice(0, 200))
  } else {
    console.log('    [?] Unexpected content type. First 200 chars:', text.slice(0, 200))
  }
} catch (e) {
  console.log(`    [FAIL] Could not reach dev server: ${e.message}`)
  console.log('           Is `npm run dev` running on port 5173?')
}
console.log('')

if (!step1Pass) {
  console.log('================================================================')
  console.log(' DIAGNOSIS: Vite route not registered.')
  console.log('================================================================')
  console.log('The /api/rewards/balance route is not being served by your dev server.')
  console.log('This is why RewardClaimPanel shows "Unable to load reward balance".')
  console.log('')
  console.log('Fix:')
  console.log('  1. Confirm you pulled the latest code: git pull origin main')
  console.log('  2. Check vite.config.js contains the line:')
  console.log("     '/api/rewards/balance': '/api/rewards/balance.mjs',")
  console.log('  3. FULLY restart npm run dev (Ctrl+C, then npm run dev)')
  console.log('     Vite does NOT hot-reload vite.config.js.')
  console.log('  4. Hard refresh browser (Ctrl+Shift+R)')
  process.exit(1)
}

// ---------- Step 2: Parse the JSON response ----------
console.log('[2/4] Parsing JSON response from /api/rewards/balance...')
let balance = null
try {
  const resp = await fetch(`${DEV_SERVER}/api/rewards/balance?wallet=${WALLET}`, {
    signal: AbortSignal.timeout(10_000),
  })
  balance = await resp.json()
  if (resp.status === 200 && !balance.error) {
    console.log('    [OK] Valid JSON response received')
    console.log('    earned_points:      ', balance.earned_points)
    console.log('    claimed_points:     ', balance.claimed_points)
    console.log('    claimable_points:   ', balance.claimable_points)
    console.log('    rewards_enabled:    ', balance.rewards_enabled)
    console.log('    has_active_season:  ', balance.has_active_season)
    console.log('    network:            ', balance.network)
  } else {
    console.log('    [FAIL] API returned an error response:')
    console.log('    ', JSON.stringify(balance, null, 2))
  }
} catch (e) {
  console.log(`    [FAIL] Could not parse JSON: ${e.message}`)
}
console.log('')

// ---------- Step 3: Check the /api/admin/rewards/status endpoint ----------
console.log('[3/4] Checking /api/admin/rewards/status (admin panel endpoint)...')
try {
  const resp = await fetch(`${DEV_SERVER}/api/admin/rewards/status`, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(10_000),
  })
  const text = await resp.text()
  const contentType = resp.headers.get('content-type') || ''
  console.log(`    HTTP status: ${resp.status}`)
  console.log(`    Content-Type: ${contentType}`)
  if (contentType.includes('application/json')) {
    const body = JSON.parse(text)
    if (body.error && resp.status === 401) {
      console.log('    [OK] Route registered — requires admin login (expected)')
    } else if (body.onChain) {
      console.log('    [OK] Admin status loaded:')
      console.log('    network:                ', body.network)
      console.log('    programId:              ', body.programId)
      console.log('    adminSignerConfigured:  ', body.adminSignerConfigured)
      console.log('    on-chain admin:         ', body.onChain.admin)
      console.log('    paused:                 ', body.onChain.paused)
      console.log('    vault balance (SOL):    ', body.onChain.vaultBalanceSol)
    } else {
      console.log('    [?] Unexpected response:', JSON.stringify(body).slice(0, 400))
    }
  } else if (contentType.includes('text/html')) {
    console.log('    [FAIL] Route returned HTML — not registered in vite.config.js')
  }
} catch (e) {
  console.log(`    [FAIL] ${e.message}`)
}
console.log('')

// ---------- Step 4: Final diagnosis ----------
console.log('[4/4] Final diagnosis...')
if (balance && balance.rewards_enabled && balance.has_active_season && balance.claimable_points > 0) {
  console.log('    [OK] All checks passed. The Claim button should be enabled.')
  console.log('    If you STILL see "Unable to load reward balance" in the browser:')
  console.log('    - Hard refresh (Ctrl+Shift+R) to bypass browser cache')
  console.log('    - Check browser DevTools Network tab for the actual HTTP response')
} else if (balance && !balance.rewards_enabled) {
  console.log('    [FAIL] rewards_enabled is false — run the Supabase migration')
  console.log('    supabase/migrations/20260920000000_enable_mainnet_rewards.sql')
} else if (balance && !balance.has_active_season) {
  console.log('    [FAIL] No active season — check samurai_seasons table')
} else if (balance && balance.claimable_points === 0) {
  console.log('    [WARN] claimable_points is 0 — no points to claim')
}
console.log('================================================================')
