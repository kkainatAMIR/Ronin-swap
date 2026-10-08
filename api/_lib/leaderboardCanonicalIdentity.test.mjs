import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [rankPage, service, route, backend, migration] = await Promise.all([
  readFile(new URL('../../src/pages/Rank.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/services/leaderboardService.js', import.meta.url), 'utf8'),
  readFile(new URL('../../api_routes/leaderboard.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./supabaseBackend.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../../supabase/migrations/20261017000000_canonical_season_leaderboard_wallets.sql', import.meta.url), 'utf8'),
])

function sqlFunction(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} must be defined in the migration`)
  const end = sql.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `${name} must have a complete function body`)
  return sql.slice(start, end)
}

const leaderboard = sqlFunction(migration, 'get_samurai_leaderboard')
const walletStats = sqlFunction(migration, 'get_samurai_wallet_stats')

test('Rank passes the selected season through the service to the leaderboard API', () => {
  assert.match(rankPage, /value=\{selectedSeasonId\}/)
  assert.match(rankPage, /onChange=\{\(event\) => setSelectedSeasonId\(event\.target\.value\)\}/)
  assert.match(rankPage, /return defaultSeason\?\.id \|\| ''/)
  assert.match(rankPage, /seasonId:\s*selectedSeasonId \|\| currentSeason\?\.id/)
  assert.match(rankPage, /\[leaderboardPeriod, leaderboardWallet, selectedSeasonId, currentSeason\?\.id, seasonsState\]/)
  assert.match(service, /if \(seasonId\) params\.set\('seasonId', seasonId\)/)
  assert.match(route, /req\.query\?\.seasonId \|\| process\.env\.SAMURAI_CURRENT_SEASON_ID/)
  assert.match(route, /getLeaderboard\(\{ period, seasonId, page, limit \}\)/)
  assert.match(backend, /p_season_id: seasonId/)
})

test('explicit historical season selection takes precedence over the configured current season', () => {
  assert.match(route, /String\(req\.query\?\.seasonId \|\| process\.env\.SAMURAI_CURRENT_SEASON_ID/)
  assert.match(leaderboard, /p_period = 'season'\s+and p_season_id is not null/)
  assert.match(leaderboard, /s\.id = p_season_id/)
  assert.match(walletStats, /ss\.season_id = p_season_id/)
})

test('live leaderboard aggregates verified linked addresses by canonical identity before ranking', () => {
  assert.match(leaderboard, /live_wallets_by_address as\s*\([\s\S]*?group by ps\.wallet_address/i)
  assert.match(leaderboard, /public\.get_verified_reward_identity\(raw\.wallet_address\)/i)
  assert.match(leaderboard, /coalesce\(identity\.result->>'solana_wallet', raw\.wallet_address\)/i)
  assert.ok(leaderboard.indexOf('group by coalesce(identity.result') < leaderboard.indexOf('row_number() over'))
})

test('unlinked live addresses retain their own identity', () => {
  assert.match(leaderboard, /coalesce\(identity\.result->>'solana_wallet', raw\.wallet_address\)/i)
  assert.match(leaderboard, /group by coalesce\(identity\.result->>'solana_wallet', raw\.wallet_address\)/i)
})

test('frozen personal season stats resolve linked EVM wallets to the canonical snapshot wallet', () => {
  assert.match(walletStats, /public\.get_verified_reward_identity\(p_wallet\)/i)
  assert.match(walletStats, /coalesce\(identity\.result->>'solana_wallet', p_wallet\) as season_wallet/i)
  assert.match(walletStats, /left join season s on s\.wallet_address = requested\.season_wallet/i)
  assert.match(walletStats, /left join season_ranked sr on sr\.wallet_address = requested\.season_wallet/i)
})

test('frozen and archived leaderboards use versioned snapshots, while ended-unfrozen remains live', () => {
  assert.match(leaderboard, /ss\.snapshot_version = coalesce\(nullif\(s\.allocation_version, 0\), 1\)/i)
  assert.match(leaderboard, /s\.status in \('FROZEN', 'ARCHIVED'\)/i)
  assert.match(leaderboard, /s\.status not in \('FROZEN', 'ARCHIVED'\)/i)
  assert.match(walletStats, /ss\.snapshot_version = coalesce\(nullif\(s\.allocation_version, 0\), 1\)/i)
  assert.match(walletStats, /s\.status in \('FROZEN', 'ARCHIVED'\)/i)
  assert.match(walletStats, /ss\.status not in \('FROZEN', 'ARCHIVED'\)/i)
})
