import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [guardMigration, snapshotMigration, rewardPoolMigration, finalizationMigration, claimMigration] = await Promise.all([
  readFile(new URL('../../supabase/migrations/20261016000000_season_snapshot_allocation_immutability.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/migrations/20261011000000_authoritative_season_snapshot.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/migrations/20261006000000_samurai_season_reward_pool.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/migrations/20261011000000_authoritative_season_snapshot.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/migrations/20261009000000_later_season_claim_window_access.sql', import.meta.url), 'utf8'),
])

function sqlFunction(sql, name) {
  const declaration = `create or replace function public.${name}`
  const start = sql.indexOf(declaration)
  assert.notEqual(start, -1, `${name} must be defined`)
  const end = sql.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `${name} must have a complete function body`)
  return sql.slice(start, end)
}

const snapshotGuard = sqlFunction(guardMigration, 'guard_samurai_season_snapshot_immutability')
const allocationGuard = sqlFunction(guardMigration, 'guard_samurai_season_reward_allocation_immutability')
const freeze = sqlFunction(snapshotMigration, 'freeze_samurai_season')
const finalize = sqlFunction(finalizationMigration, 'finalize_samurai_season_rewards')
const claimStatusTrigger = sqlFunction(rewardPoolMigration, 'sync_samurai_season_reward_allocation_claim_status')
const claim = sqlFunction(claimMigration, 'claim_finalized_season_reward')

test('frozen snapshot rows cannot be updated, deleted, or appended', () => {
  assert.match(snapshotGuard, /tg_op in \('UPDATE', 'DELETE'\)[\s\S]*SEASON_SNAPSHOT_IMMUTABLE/i)
  assert.match(snapshotGuard, /s\.status = 'ENDED'/i)
  assert.match(snapshotGuard, /new\.snapshot_version = coalesce\(nullif\(s\.allocation_version, 0\), 1\)/i)
  assert.match(guardMigration, /before insert or update or delete[\s\S]*samurai_season_leaderboard_snapshots/i)
})

test('freeze still inserts a versioned snapshot before setting the season frozen', () => {
  assert.match(freeze, /security definer/i)
  assert.match(freeze, /where id = p_id\s+for update/i)
  assert.match(freeze, /insert into public\.samurai_season_leaderboard_snapshots/i)
  assert.match(freeze, /set status = 'FROZEN'/i)
})

test('allocation entitlement fields are immutable while claim metadata remains updateable', () => {
  assert.match(allocationGuard, /if tg_op = 'DELETE' then[\s\S]*SEASON_REWARD_ALLOCATION_IMMUTABLE/i)
  assert.match(allocationGuard, /new\.reward_amount,[\s\S]*new\.allocation_version,[\s\S]*new\.created_at/i)
  assert.match(allocationGuard, /old\.reward_amount,[\s\S]*old\.allocation_version,[\s\S]*old\.created_at/i)
  assert.match(allocationGuard, /return new;\s+end if;/i)
  assert.doesNotMatch(allocationGuard, /new\.claim_status,[\s\S]*old\.claim_status/i)
  assert.match(guardMigration, /before insert or update or delete[\s\S]*samurai_season_reward_allocations/i)
})

test('finalization inserts only the snapshot-derived finalized version', () => {
  assert.match(allocationGuard, /season_row\.status <> 'FROZEN'/i)
  assert.match(allocationGuard, /season_row\.reward_pool_status <> 'CONFIGURED'/i)
  assert.match(allocationGuard, /snapshot_row\.eligible_points/i)
  assert.match(allocationGuard, /season_row\.reward_pool_amount \* snapshot_row\.eligible_points/i)
  assert.match(finalize, /security definer/i)
  assert.match(finalize, /insert into public\.samurai_season_reward_allocations/i)
  assert.match(finalize, /ss\.eligible_points/i)
})

test('claim-status synchronization remains allowed and claims read the saved amount', () => {
  assert.match(claimStatusTrigger, /security definer/i)
  assert.match(claimStatusTrigger, /set claim_status = case new\.status[\s\S]*updated_at = now\(\)/i)
  assert.match(claim, /allocation\.reward_amount/)
  assert.match(claim, /allocation\.eligible_points, 'SOL', allocation\.reward_amount/i)
  assert.doesNotMatch(claim, /reward_pool_amount\s*\*|vault_balance/i)
})
