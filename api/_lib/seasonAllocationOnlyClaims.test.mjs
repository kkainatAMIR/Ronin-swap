import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [legacyClaimRoute, claimPrepareRoute, balanceRoute, panel] = await Promise.all([
  readFile(new URL('../../api_routes/rewards/claim.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../../api_routes/rewards/claim-prepare.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../../api_routes/rewards/balance.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../../src/components/RewardClaimPanel.jsx', import.meta.url), 'utf8'),
])

test('legacy custodial conversion claims are rejected before any claim RPC', () => {
  const rejection = legacyClaimRoute.indexOf(
    "return apiError(res, 409, 'SEASON_ALLOCATION_REQUIRED'",
  )
  const claimRpc = legacyClaimRoute.indexOf("callSupabaseRpc('claim_reward'")

  assert.ok(rejection >= 0)
  assert.ok(claimRpc > rejection)
})

test('user-pays-fee claims require a season allocation ID', () => {
  const rejection = claimPrepareRoute.indexOf("if (!seasonId)")
  const seasonRpc = claimPrepareRoute.indexOf("callSupabaseRpc('claim_finalized_season_reward'")
  const legacyRpc = claimPrepareRoute.indexOf("callSupabaseRpc('claim_reward'")

  assert.ok(rejection >= 0)
  assert.ok(seasonRpc > rejection)
  assert.ok(legacyRpc > rejection)
  assert.match(claimPrepareRoute, /if \(!seasonId\)\s*\{\s*return apiError\(res, 409, 'SEASON_ALLOCATION_REQUIRED'/)
})

test('reward balance continues exposing historical claim records', () => {
  assert.match(balanceRoute, /recent_claims/)
})

test('profile hides the legacy claim action and keeps finalized-season claims', () => {
  assert.doesNotMatch(panel, /Claim all claimable points/)
  assert.doesNotMatch(panel, /onClick=\{[^}]*handleClaim\(\)/)
  assert.match(panel, /onClaim=\{\(\) => handleClaim\(selectedSeasonReward\)\}/)
  assert.match(panel, /seasonRewardRequest\s*\?\s*\{\s*seasonId: season\.id\s*\}\s*:\s*\{\}/)
})
