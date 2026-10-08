import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [snapshotMigration, versioningMigration, claimsMigration] = await Promise.all([
  readFile(new URL('../../supabase/migrations/20261011000000_authoritative_season_snapshot.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/migrations/20261008000000_versioned_season_reward_restart.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/migrations/20261009000000_later_season_claim_window_access.sql', import.meta.url), 'utf8'),
])

function sqlFunction(sql, name) {
  const declaration = `create or replace function public.${name}`
  const start = sql.indexOf(declaration)
  assert.notEqual(start, -1, `${name} must be defined in the migration`)
  const end = sql.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `${name} must have a complete function body`)
  return sql.slice(start, end)
}

const freeze = sqlFunction(snapshotMigration, 'freeze_samurai_season')
const finalize = sqlFunction(snapshotMigration, 'finalize_samurai_season_rewards')
const leaderboard = sqlFunction(versioningMigration, 'get_samurai_leaderboard')
const walletStats = sqlFunction(versioningMigration, 'get_samurai_wallet_stats')
const restart = sqlFunction(versioningMigration, 'restart_finalized_samurai_season')
const claim = sqlFunction(claimsMigration, 'claim_finalized_season_reward')
const claimPrepare = await readFile(new URL('../../api_routes/rewards/claim-prepare.mjs', import.meta.url), 'utf8')

test('freeze locks the season and writes a unique canonical snapshot for its version', () => {
  assert.match(freeze, /where id = p_id\s+for update/i)
  assert.match(freeze, /season_row\.status <> 'ENDED'/i)
  assert.match(freeze, /get_verified_reward_identity/i)
  assert.match(freeze, /group by canonical\.id, canonical\.wallet_address/i)
  assert.match(snapshotMigration, /unique index if not exists samurai_season_snapshot_canonical_wallet_version_uidx/i)
  assert.match(freeze, /snapshot_version_value := coalesce\(nullif\(season_row\.allocation_version, 0\), 1\)/i)
})

test('snapshot captures only verified, qualified, eligible positive points', () => {
  assert.match(freeze, /st\.verification_status = 'verified'/i)
  assert.match(freeze, /sp\.eligibility_status = 'qualified'/i)
  assert.match(freeze, /coalesce\(sp\.flag_status, ''\) <> 'EXCLUDED'/i)
  assert.match(freeze, /coalesce\(point_wallet\.flag_status, ''\) <> 'EXCLUDED'/i)
  assert.match(freeze, /sp\.final_points > 0/i)
})

test('snapshot stores eligible points, their total, timestamp, and version', () => {
  assert.match(snapshotMigration, /add column if not exists canonical_wallet_id uuid/i)
  assert.match(snapshotMigration, /add column if not exists eligible_points numeric/i)
  assert.match(snapshotMigration, /add column if not exists total_eligible_points numeric/i)
  assert.match(snapshotMigration, /add column if not exists snapshot_at timestamptz/i)
  assert.match(freeze, /eligible_points,\s+total_eligible_points,\s+snapshot_at/i)
  assert.match(freeze, /sum\(eligible_points\) over \(\)/i)
  assert.match(freeze, /final_points = snapshot\.total_eligible_points/i)
})

test('linked wallets aggregate under the verified canonical reward identity', () => {
  assert.match(freeze, /identity->>'solana_wallet' as canonical_wallet/i)
  assert.match(freeze, /join public\.wallets canonical\s+on canonical\.wallet_address = identity\.canonical_wallet/i)
  assert.match(freeze, /group by canonical\.id, canonical\.wallet_address/i)
})

test('reward finalization allocates only from the captured snapshot values', () => {
  assert.match(finalize, /ss\.eligible_points/i)
  assert.match(finalize, /from public\.samurai_season_leaderboard_snapshots ss/i)
  assert.match(finalize, /ss\.snapshot_version = allocation_version_value/i)
  assert.match(finalize, /season_row\.reward_pool_amount \* ss\.eligible_points\s+\/ nullif\(total_points, 0\)/i)
  assert.doesNotMatch(finalize, /from public\.samurai_points/i)
  assert.match(finalize, /floor\(/i)
})

test('later live-point changes cannot recalculate finalized leaderboard or rewards', () => {
  assert.doesNotMatch(finalize, /samurai_points/i)
  assert.match(leaderboard, /from public\.samurai_season_leaderboard_snapshots ss/i)
  assert.match(leaderboard, /ss\.snapshot_version = coalesce\(nullif\(s\.allocation_version, 0\), 1\)/i)
  assert.match(walletStats, /from public\.samurai_season_leaderboard_snapshots ss/i)
  assert.match(walletStats, /ss\.snapshot_version = coalesce\(nullif\(s\.allocation_version, 0\), 1\)/i)
})

test('repeated finalization is locked and returns the existing finalized version', () => {
  assert.match(finalize, /where id = p_id\s+for update/i)
  assert.match(finalize, /if season_row\.reward_pool_status = 'FINALIZED' then/i)
  assert.match(finalize, /'idempotent', true/i)
})

test('normal reward finalization requires a frozen snapshot', () => {
  assert.match(finalize, /season_row\.status <> 'FROZEN' or season_row\.frozen_at is null/i)
  assert.match(finalize, /raise exception 'SEASON_NOT_FROZEN'/i)
})

test('explicit restart creates a new version without deleting historical rows', () => {
  assert.match(restart, /allocation_version = coalesce\(allocation_version, 0\) \+ 1/i)
  assert.doesNotMatch(restart, /\b(delete\s+from|truncate)\b/i)
  assert.match(leaderboard, /ss\.snapshot_version = coalesce\(nullif\(s\.allocation_version, 0\), 1\)/i)
})

test('zero eligible points avoid division and produce no reward allocation rows', () => {
  assert.match(finalize, /and total_points > 0/i)
  assert.match(finalize, /nullif\(total_points, 0\)/i)
  assert.match(finalize, /coalesce\(sum\(ss\.eligible_points\), 0\)/i)
})

test('claims consume the persisted allocation for the active finalized version', () => {
  assert.match(claim, /a\.allocation_version = s\.allocation_version/i)
  assert.match(claim, /s\.reward_pool_status = 'FINALIZED'/i)
  assert.match(claim, /now\(\) >= s\.claim_window_start/i)
  assert.match(claim, /now\(\) < s\.claim_window_end/i)
})

test('proportional allocation is fixed from each wallet share of that season pool', () => {
  assert.match(finalize, /season_row\.reward_pool_amount \* ss\.eligible_points\s+\/ nullif\(total_points, 0\)/i)
  assert.match(finalize, /floor\([\s\S]*?\* 1000000000\s*\)\s*\/ 1000000000/i)
  assert.match(finalize, /reward_amount,[\s\S]*?season_row\.reward_pool_amount,[\s\S]*?floor\(/i)
})

test('finalization is season- and snapshot-version-isolated', () => {
  assert.match(freeze, /where sp\.season_id = p_id/i)
  assert.match(finalize, /where ss\.season_id = p_id\s+and ss\.snapshot_version = allocation_version_value/i)
  assert.match(finalize, /where a\.season_id = p_id\s+and a\.allocation_version = allocation_version_value/i)
})

test('claim order and timing cannot change a finalized allocation', () => {
  assert.match(claim, /allocation\.reward_amount/)
  assert.match(claim, /allocation\.eligible_points, 'SOL', allocation\.reward_amount/i)
  assert.doesNotMatch(finalize, /reward_claims|vault_balance/i)
  assert.doesNotMatch(claim, /vault_balance|reward_pool_amount\s*\*|eligible_points\s*\/\s*total_eligible_points/i)
})

test('an insufficient vault blocks the fixed claim instead of reducing its amount', () => {
  assert.match(claimPrepare, /programState\.vaultBalanceLamports < rewardAmountLamports/)
  assert.match(claimPrepare, /safeRevertFailedClaim\(claimId, 'VAULT_INSUFFICIENT_BALANCE'\)/)
  assert.match(claimPrepare, /'VAULT_INSUFFICIENT_BALANCE'/)
  assert.match(claim, /allocation\.reward_amount/)
  assert.doesNotMatch(claimPrepare, /rewardAmountLamports\s*=\s*Math\.min|rewardAmountSol\s*=\s*Math\.min/i)
})

test('claim-window expiry gates claiming without changing the proportional formula', () => {
  assert.match(claim, /now\(\) >= s\.claim_window_start/)
  assert.match(claim, /now\(\) < s\.claim_window_end/)
  assert.match(claim, /raise exception 'SEASON_CLAIM_WINDOW_CLOSED'/)
  assert.match(claim, /allocation\.reward_amount/)
  assert.doesNotMatch(claim, /claim_window[\s\S]{0,500}reward_amount\s*=/i)
})

test('repeated finalization preserves saved allocations and returns the finalized version', () => {
  assert.match(finalize, /if season_row\.reward_pool_status = 'FINALIZED' then/i)
  assert.match(finalize, /'idempotent', true/i)
  assert.match(finalize, /on conflict \(season_id, wallet_id, allocation_version\) do nothing/i)
  assert.match(restart, /allocation_version = coalesce\(allocation_version, 0\) \+ 1/i)
  assert.doesNotMatch(restart, /\b(delete\s+from|truncate)\b/i)
})
