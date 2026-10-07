import test from 'node:test'
import assert from 'node:assert/strict'
import { countCampaignParticipants, getVisibleCampaigns } from './campaignOverview.mjs'

test('campaign visibility uses configured status and earning dates', () => {
  const now = Date.parse('2026-10-06T12:00:00.000Z')
  const campaigns = getVisibleCampaigns([
    { id: 'active', name: 'Active', multiplier: 2, startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-10-10T00:00:00.000Z' },
    { id: 'upcoming', multiplier: 1, start_at: '2026-10-08T00:00:00.000Z', end_at: '2026-10-12T00:00:00.000Z' },
    { id: 'disabled', enabled: false },
    { id: 'expired', endDate: '2026-10-06T11:59:59.000Z' },
    { id: 'invalid-date', endDate: 'not-a-date' },
  ], now)

  assert.deepEqual(campaigns.map(({ id, status }) => [id, status]), [
    ['active', 'ACTIVE'],
    ['upcoming', 'UPCOMING'],
  ])
  assert.throws(() => getVisibleCampaigns([{ id: 'invalid', multiplier: 'not-a-number' }], now), /INVALID_CAMPAIGN_MULTIPLIER/)
})

test('campaign participant totals count eligible identities and combine active wallet links', () => {
  const counts = countCampaignParticipants([
    { campaign_id: 'buy', wallet_address: 'SolWalletOne', eligibility_status: 'qualified', flag_status: 'CLEAR', final_points: 25 },
    { campaign_id: 'buy', wallet_address: '0xAa00000000000000000000000000000000000001', eligibility_status: 'qualified', flag_status: 'CLEAR', final_points: 15 },
    { campaign_id: 'buy', wallet_address: '0xbb00000000000000000000000000000000000002', eligibility_status: 'qualified', flag_status: 'CLEAR', final_points: 10 },
    { campaign_id: 'buy', wallet_address: 'SolWalletIgnored', eligibility_status: 'not_qualified', flag_status: 'CLEAR', final_points: 0 },
    { campaign_id: 'buy', wallet_address: 'SolWalletExcluded', eligibility_status: 'qualified', flag_status: 'EXCLUDED', final_points: 5 },
    { campaign_id: 'sell', wallet_address: 'SolWalletOne', eligibility_status: 'qualified', flag_status: 'CLEAR', final_points: 5 },
  ], [
    { solana_wallet: 'SolWalletOne', evm_wallet: '0xaa00000000000000000000000000000000000001', status: 'ACTIVE' },
    { solana_wallet: 'SolWalletOther', evm_wallet: '0xbb00000000000000000000000000000000000002', status: 'REVOKED' },
  ])

  assert.equal(counts.get('buy'), 2)
  assert.equal(counts.get('sell'), 1)
})
