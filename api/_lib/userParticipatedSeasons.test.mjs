import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const migration = await readFile(new URL('../../supabase/migrations/20261012000000_user_participated_reward_seasons.sql', import.meta.url), 'utf8')
const panel = await readFile(new URL('../../src/components/RewardClaimPanel.jsx', import.meta.url), 'utf8')
const balanceRoute = await readFile(new URL('../../api_routes/rewards/balance.mjs', import.meta.url), 'utf8')
const claimPrepareRoute = await readFile(new URL('../../api_routes/rewards/claim-prepare.mjs', import.meta.url), 'utf8')
const claimRoute = await readFile(new URL('../../api_routes/rewards/claim.mjs', import.meta.url), 'utf8')
const claimConfirmRoute = await readFile(new URL('../../api_routes/rewards/claim-confirm.mjs', import.meta.url), 'utf8')
const claimCancelRoute = await readFile(new URL('../../api_routes/rewards/claim-cancel.mjs', import.meta.url), 'utf8')

function sqlFunction(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} must be defined in the migration`)
  const end = sql.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `${name} must have a complete function body`)
  return sql.slice(start, end)
}

const seasonReward = sqlFunction(migration, 'get_wallet_season_reward')

test('season reward response is limited to seasons with positive participation', () => {
  assert.match(seasonReward, /get_verified_reward_identity\(p_wallet_address\)/i)
  assert.match(seasonReward, /and participation\.samurai_points > 0/i)
  assert.match(seasonReward, /where s\.reward_pool_status in \('CONFIGURED', 'FINALIZED'\)/i)
})

test('participation uses immutable frozen snapshots or verified qualifying live points', () => {
  assert.match(seasonReward, /when s\.frozen_at is not null then coalesce\(snapshot_points\.points, 0\)/i)
  assert.match(seasonReward, /ss\.snapshot_version = coalesce\(nullif\(s\.allocation_version, 0\), 1\)/i)
  assert.match(seasonReward, /ss\.canonical_wallet_id = v_canonical_wallet_id/i)
  assert.match(seasonReward, /st\.verification_status = 'verified'/i)
  assert.match(seasonReward, /sp\.eligibility_status = 'qualified'/i)
  assert.match(seasonReward, /coalesce\(sp\.flag_status, ''\) <> 'EXCLUDED'/i)
  assert.match(seasonReward, /sp\.final_points > 0/i)
  assert.match(seasonReward, /sum\(sp\.qualifying_volume_usd\)/i)
  assert.match(seasonReward, /sum\(ss\.qualifying_swaps\)::bigint/i)
  assert.match(seasonReward, /count\(\*\)::bigint as qualifying_swaps/i)
  assert.match(seasonReward, /'eligibility_status', participation\.eligibility_status/i)
})

test('participation values are computed after their lateral sources', () => {
  assert.ok(seasonReward.indexOf(') snapshot_points on') < seasonReward.indexOf(') participation'))
  assert.ok(seasonReward.indexOf(') live_points on') < seasonReward.indexOf(') participation'))
})

test('season and campaign details are distinct by aggregation at one row per season', () => {
  assert.match(seasonReward, /jsonb_agg\(distinct jsonb_build_object\(/i)
  assert.match(seasonReward, /'campaigns', participation\.campaigns/i)
  assert.match(seasonReward, /jsonb_agg\([\s\S]*order by s\.start_at desc/i)
  assert.match(seasonReward, /from public\.samurai_seasons s/i)
  assert.match(seasonReward, /cross join lateral/i)
  assert.match(seasonReward, /'eligible_wallet_count', s\.eligible_wallet_count/i)
})

test('profile shows compact participated-season cards and opens the detail dialog', () => {
  assert.match(panel, /title="Your Participated Seasons & Campaigns"/)
  assert.match(panel, /You haven&apos;t participated in any reward season or campaign yet\./)
  assert.match(panel, /seasonRewards\.map\(\(seasonReward\)/)
  assert.match(panel, /className="profile-season-reward-card"/)
  assert.match(panel, /role="dialog"/)
  assert.match(panel, /QUALIFYING SWAPS/)
  assert.match(panel, /QUALIFYING VOLUME/)
  assert.match(panel, /SAMURAI POINTS/)
  assert.match(panel, /profile-season-dialog-art/)
  assert.match(panel, /onClick=\{onClaim\}/)
  assert.match(panel, /onClaim=\{\(\) => handleClaim\(selectedSeasonReward\)\}/)
  assert.match(panel, /loadedBalanceIdentity === balanceIdentity/)
})

test('unclaimed season allocation amounts are not returned or rendered', () => {
  assert.match(seasonReward, /'has_reward', coalesce\(a\.reward_amount, 0\) > 0/i)
  assert.match(seasonReward, /when latest\.claim->>'status' = 'COMPLETED' then a\.reward_amount/i)
  assert.match(seasonReward, /when rc\.status = 'COMPLETED' then rc\.reward_amount else null/i)
  assert.match(balanceRoute, /item\.claim\?\.status === 'COMPLETED'[\s\S]*item\.allocation\.reward_amount/)
  assert.match(balanceRoute, /c\.status === 'COMPLETED' \? Number\(c\.reward_amount \|\| 0\) : null/)
  assert.match(panel, /isClaimed && claim\?\.reward_amount != null/)
  assert.match(panel, /claim\.status === 'COMPLETED' && claim\.reward_amount != null/)
  assert.doesNotMatch(panel, /allocation\.reward_amount/)
})

test('balance endpoint requires proof of ownership for the requested wallet', () => {
  assert.match(balanceRoute, /rewardViewerWalletMatches\(req, wallet\)/)
  assert.match(balanceRoute, /REWARD_VIEWER_AUTH_REQUIRED/)
  assert.match(claimPrepareRoute, /rewardViewerWalletMatches\(req, wallet\)/)
  assert.match(claimRoute, /rewardViewerWalletMatches\(req, wallet\)/)
  assert.match(claimConfirmRoute, /rewardViewerWalletMatches\(req, claimRow\.wallet_address\)/)
  assert.match(claimCancelRoute, /rewardViewerWalletMatches\(req, claimWallet\)/)
  assert.match(migration, /create table if not exists public\.reward_viewer_auth_challenges/i)
  assert.match(migration, /grant execute on function public\.consume_reward_viewer_auth_challenge\(text, text\) to service_role/i)
  assert.match(migration, /challenge\.used_at is null[\s\S]*challenge\.expires_at > clock_timestamp\(\)/i)
})
