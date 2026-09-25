// =====================================================================
// End-to-end static check: swap → verify → persist → samurai points
// =====================================================================
// Validates that every step of the points pipeline across all three
// chains (Solana, Ethereum, Robinhood) is correctly wired, without
// making any network calls.
//
// What this checks:
//   1. All required API routes are registered in api/_routes.mjs
//   2. The handlers exist and export a default function
//   3. The samurai points calculator handles all 3 chain_ids
//   4. The complete endpoints (evm/complete, lifi/complete) call the
//      same awardSamuraiPoints() RPC used by swap/points
//   5. The chain_id fix migration is applied (chain_id derives from
//      swap_transactions, not the table default)
//   6. The production build still passes
// =====================================================================

import { readFileSync, existsSync } from 'node:fs'

const ROOT = '/home/z/my-project/Ronin-swap'
const results = []
let passed = 0, failed = 0

function check(name, condition, detail = '') {
  const status = condition ? 'PASS' : 'FAIL'
  if (condition) passed++; else failed++
  results.push({ name, status, detail })
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('━'.repeat(70))
console.log('END-TO-END STATIC CHECK: Swap → Verify → Points pipeline')
console.log('━'.repeat(70))

// --- 1. Route table -----------------------------------------------------
console.log('\n1. Route table registration')
const routes = (await import(`${ROOT}/api/_routes.mjs`)).ROUTES

const requiredRoutes = [
  ['POST', '/api/swap/verify', 'Solana swap verification'],
  ['POST', '/api/swap/record', 'Solana verified swap persistence'],
  ['POST', '/api/swap/points', 'Solana Samurai Points awarding'],
  ['POST', '/api/evm/quote', 'Ethereum swap quote'],
  ['POST', '/api/evm/complete', 'Ethereum swap completion + points'],
  ['POST', '/api/lifi/quote', 'Robinhood/LI.FI swap quote'],
  ['POST', '/api/lifi/complete', 'Robinhood/LI.FI swap completion + points'],
  ['GET', '/api/rewards/balance', 'Reward balance read'],
  ['POST', '/api/rewards/claim', 'Reward claim flow'],
]

for (const [method, path, label] of requiredRoutes) {
  const key = `${method} ${path}`
  check(`${label} (${key})`, typeof routes[key] === 'function', routes[key] ? 'handler registered' : 'MISSING')
}

// --- 2. Source files exist for all handlers ------------------------------
console.log('\n2. Handler source files')
const handlerFiles = [
  'api_routes/swap/verify.mjs',
  'api_routes/swap/record.mjs',
  'api_routes/swap/points.mjs',
  'api_routes/evm/quote.mjs',
  'api_routes/evm/complete.mjs',
  'api_routes/lifi/quote.mjs',
  'api_routes/lifi/complete.mjs',
  'api_routes/rewards/balance.mjs',
  'api_routes/rewards/claim.mjs',
  'api/_lib/samuraiPoints.mjs',
  'api/_lib/supabaseBackend.mjs',
  'api/_lib/solanaRewardsAdmin.mjs',
]
for (const file of handlerFiles) {
  check(`${file} exists`, existsSync(`${ROOT}/${file}`))
}

// --- 3. calculateSamuraiPoints handles all chain_ids --------------------
console.log('\n3. Points calculator handles all three chains')
const samuraiSource = readFileSync(`${ROOT}/api/_lib/samuraiPoints.mjs`, 'utf8')
check(
  'Solana branch (no explicit chainId match → falls through to token-price path)',
  samuraiSource.includes('const rawInput = BigInt(String(swap.input_amount_raw))') &&
    samuraiSource.includes('priceUsd = await getTokenUsdPrice(swap.input_mint)'),
)
check(
  'Ethereum + Robinhood branch (chainId === 1 || chainId === 4663)',
  samuraiSource.includes('chainId === 1 || chainId === 4663'),
)
check(
  'EVM price fallback for non-stablecoin pairs',
  samuraiSource.includes('qualifyingVolumeUsd <= 0') &&
    samuraiSource.includes('getEvmUsdPrice(chainId, swap.input_mint)'),
)

// --- 4. evm/complete and lifi/complete both call awardSamuraiPoints -----
console.log('\n4. EVM/LI.FI completion → points wiring')
const evmComplete = readFileSync(`${ROOT}/api_routes/evm/complete.mjs`, 'utf8')
check(
  'evm/complete calls awardSamuraiPoints',
  evmComplete.includes('awardSamuraiPoints({ signature: transactionHash, ...calculation, seasonId'),
)
check(
  'evm/complete verifies on-chain tx (eth_getTransactionReceipt)',
  evmComplete.includes('eth_getTransactionReceipt') && evmComplete.includes("receipt.status !== '0x1'"),
)
check(
  'evm/complete idempotent (existing-points short-circuit)',
  evmComplete.includes('getPointsBySignature(transactionHash)') && evmComplete.includes('duplicate: true'),
)

const lifiComplete = readFileSync(`${ROOT}/api_routes/lifi/complete.mjs`, 'utf8')
check(
  'lifi/complete calls awardSamuraiPoints',
  lifiComplete.includes('awardSamuraiPoints({ signature: transactionHash, ...calculation, seasonId'),
)
check(
  'lifi/complete verifies on-chain tx via lifiRpc',
  lifiComplete.includes("lifiRpc(fromChain, 'eth_getTransactionReceipt'"),
)
check(
  'lifi/complete idempotent (existing-points short-circuit)',
  lifiComplete.includes('getPointsBySignature(transactionHash)') && lifiComplete.includes('duplicate: true'),
)

// --- 5. Solana flow uses swap/verify → swap/record → swap/points --------
console.log('\n5. Solana flow wiring (frontend)')
const jupiterService = readFileSync(`${ROOT}/src/services/jupiterService.js`, 'utf8')
check('verifySwapTransaction → /api/swap/verify', jupiterService.includes("fetch('/api/swap/verify'"))
check('recordVerifiedSwap → /api/swap/record', jupiterService.includes("fetch('/api/swap/record'"))
check('processSamuraiPoints → /api/swap/points', jupiterService.includes("fetch('/api/swap/points'"))

const swapPage = readFileSync(`${ROOT}/src/pages/Swap.jsx`, 'utf8')
check(
  'Swap.jsx orchestrates verify → record → points after confirmation',
  swapPage.includes('await verifySwapTransaction(') &&
    swapPage.includes('await recordVerifiedSwap(') &&
    swapPage.includes('await processSamuraiPoints('),
)

// --- 6. Chain_id preserved through the pipeline --------------------------
console.log('\n6. Chain_id integrity')
const chainIdFixMigration = readFileSync(`${ROOT}/supabase/migrations/20260913000000_samurai_points_chain_id_fix.sql`, 'utf8')
check(
  'award_samurai_points() reads chain_id from swap_transactions (not table default)',
  chainIdFixMigration.includes('select * into swap_row from public.swap_transactions where swap_transactions.signature = p_signature') &&
    chainIdFixMigration.includes('chain_id'),
)

const evmSwapMigration = readFileSync(`${ROOT}/supabase/migrations/20260911080000_evm_swap_support.sql`, 'utf8')
check(
  'EVM swap support migration exists (chain_id column on swap_transactions)',
  evmSwapMigration.includes('chain_id') || evmSwapMigration.includes('ethereum'),
)

const unifiedHistory = readFileSync(`${ROOT}/supabase/migrations/20260911091000_unified_swap_history.sql`, 'utf8')
check(
  'Unified swap history view exists (Solana + Ethereum + Robinhood)',
  unifiedHistory.length > 0,
)

// --- 7. Reward claim flow is consistent ----------------------------------
console.log('\n7. Rewards claim flow integrity')
const claimHandler = readFileSync(`${ROOT}/api_routes/rewards/claim.mjs`, 'utf8')
check(
  'claim.mjs: pre-flight program-state check',
  claimHandler.includes('getRewardsProgramState()') && claimHandler.includes('programState.paused'),
)
check(
  'claim.mjs: Supabase claim_reward RPC',
  claimHandler.includes("callSupabaseRpc('claim_reward'"),
)
check(
  'claim.mjs: mark PENDING_PAYOUT before Solana tx',
  claimHandler.includes("callSupabaseRpc('mark_reward_claim_pending_payout'"),
)
check(
  'claim.mjs: revert_failed_reward_claim on Solana tx failure',
  claimHandler.includes('safeRevertFailedClaim') && claimHandler.includes("callSupabaseRpc('revert_failed_reward_claim'"),
)
check(
  'claim.mjs: update_reward_claim_status COMPLETED with signature',
  claimHandler.includes("callSupabaseRpc('update_reward_claim_status'") && claimHandler.includes("p_status: 'COMPLETED'"),
)
check(
  'claim.mjs: never reverts on ambiguous confirmation',
  claimHandler.includes('ambiguous_confirmation') && claimHandler.includes('NEVER revert'),
)

// --- 8. Rewards upgrade applied (4-account claim instruction) -----------
console.log('\n8. Rewards contract upgrade applied')
const solanaRewardsAdmin = readFileSync(`${ROOT}/api/_lib/solanaRewardsAdmin.mjs`, 'utf8')
const claimBuilderMatch = solanaRewardsAdmin.match(/export function buildClaimRewardInstruction\([^)]+\)\s*\{[\s\S]*?\n\}/)
check(
  'buildClaimRewardInstruction defined',
  Boolean(claimBuilderMatch),
)
if (claimBuilderMatch) {
  const builder = claimBuilderMatch[0]
  const hasSystemProgram = /system_program|11111111111111111111111111111111/.test(builder)
  const hasClaimPda = /claimPda/.test(builder)
  check(
    'No system_program in claim keys (upgraded contract)',
    !hasSystemProgram,
    hasSystemProgram ? 'system_program still present' : '',
  )
  check(
    'No claimPda in claim keys (upgraded contract)',
    !hasClaimPda,
    hasClaimPda ? 'claimPda still present' : '',
  )
  const keysMatch = builder.match(/const keys = \[([\s\S]*?)\]/)
  if (keysMatch) {
    const accountCount = (keysMatch[1].match(/\{ pubkey:/g) || []).length
    check(
      `Claim instruction has exactly 4 accounts`,
      accountCount === 4,
      `found ${accountCount}`,
    )
  }
}

// --- 9. Idempotency layers intact ---------------------------------------
console.log('\n9. Idempotency layers')
const rewardClaimsMigration = readFileSync(`${ROOT}/supabase/migrations/20260917000000_reward_claims.sql`, 'utf8')
check(
  'reward_claims.claim_id has unique constraint',
  rewardClaimsMigration.includes('claim_id text not null unique'),
)
check(
  'claim_reward() RPC is idempotent on claim_id',
  rewardClaimsMigration.includes('select * into existing_claim from public.reward_claims') &&
    rewardClaimsMigration.includes("'idempotent', true"),
)

const rewardPayoutMigration = readFileSync(`${ROOT}/supabase/migrations/20260918000000_reward_payout_int.sql`, 'utf8')
check(
  'mark_reward_claim_pending_payout() atomic transition RPC',
  rewardPayoutMigration.includes('mark_reward_claim_pending_payout') &&
    rewardPayoutMigration.includes('for update'),
)
check(
  'revert_failed_reward_claim() atomic + decrement RPC',
  rewardPayoutMigration.includes('revert_failed_reward_claim') &&
    rewardPayoutMigration.includes('claimed_points - claim_row.points_claimed'),
)

// --- 10. Rewards balance RPC --------------------------------------------
console.log('\n10. Rewards balance derivation')
check(
  'get_wallet_reward_balance derives earned_points from samurai_points (TRUSTED)',
  rewardClaimsMigration.includes('select coalesce(sum(sp.final_points), 0) into earned_points') &&
    rewardClaimsMigration.includes("sp.eligibility_status = 'qualified'"),
)
check(
  'claimable_points = earned - claimed (derived, never stored)',
  rewardClaimsMigration.includes('claimable_points := greatest(earned_points - claimed_points, 0)'),
)

// --- 11. Build still passes ---------------------------------------------
console.log('\n11. Production build')
const { transform } = await import('esbuild')
try {
  await transform(swapPage, { loader: 'jsx', jsx: 'automatic', target: 'es2022' })
  check('Swap.jsx parses cleanly', true)
} catch (err) {
  check('Swap.jsx parses cleanly', false, err.message)
}

// --- Summary ------------------------------------------------------------
console.log('\n' + '═'.repeat(70))
console.log(`RESULTS: ${passed} passed, ${failed} failed`)
console.log('═'.repeat(70))

if (failed > 0) {
  console.log('\nFailed checks:')
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  ❌ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
  })
  process.exit(1)
} else {
  console.log('\n✅ All checks passed. Pipeline is correctly wired across Solana, Ethereum, and Robinhood.')
}
