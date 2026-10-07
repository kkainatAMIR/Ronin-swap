import test from 'node:test'
import assert from 'node:assert/strict'
import {
  filterAdminHistory,
  getAdminCampaignStatus,
  isAdminSeasonActive,
} from './adminCampaignSeasonFilters.mjs'

const now = Date.parse('2026-10-15T12:00:00.000Z')

test('campaign status respects enabled state and configured date bounds', () => {
  assert.equal(getAdminCampaignStatus({ enabled: true, startDate: '2026-10-15T12:00:00.000Z', endDate: '2026-10-16T00:00:00.000Z' }, now), 'ACTIVE')
  assert.equal(getAdminCampaignStatus({ enabled: true, startDate: '2026-10-16T00:00:00.000Z' }, now), 'UPCOMING')
  assert.equal(getAdminCampaignStatus({ enabled: false }, now), 'DISABLED')
  assert.equal(getAdminCampaignStatus({ enabled: true, endDate: '2026-10-15T11:59:59.000Z' }, now), 'ENDED')
  assert.equal(getAdminCampaignStatus({ status: 'DRAFT' }, now), 'DRAFT')
})

test('only an in-range ACTIVE season is classified as active', () => {
  const activeSeason = {
    status: 'ACTIVE',
    start_at: '2026-10-15T11:00:00.000Z',
    end_at: '2026-10-15T13:00:00.000Z',
  }
  assert.equal(isAdminSeasonActive(activeSeason, now), true)
  assert.equal(isAdminSeasonActive({ ...activeSeason, start_at: '2026-10-15T13:00:00.000Z' }, now), false)
  assert.equal(isAdminSeasonActive({ ...activeSeason, status: 'DRAFT' }, now), false)
  assert.equal(isAdminSeasonActive({ ...activeSeason, end_at: 'invalid' }, now), false)
})

test('history filtering keeps drafts and supports status and case-insensitive search', () => {
  const items = [
    { id: 'draft-season', name: 'Autumn Draft', status: 'DRAFT' },
    { id: 'ended-season', name: 'Summer Season', status: 'ENDED' },
    { id: 'upcoming-campaign', name: 'Autumn Promo', status: 'UPCOMING' },
  ]
  const getStatus = (item) => item.status
  const getSearchText = (item) => `${item.name} ${item.id}`

  assert.deepEqual(
    filterAdminHistory(items, { status: 'ALL', getStatus, getSearchText }).map(({ id }) => id),
    ['draft-season', 'ended-season', 'upcoming-campaign'],
  )
  assert.deepEqual(
    filterAdminHistory(items, { query: 'AUTUMN', status: 'DRAFT', getStatus, getSearchText }).map(({ id }) => id),
    ['draft-season'],
  )
})
