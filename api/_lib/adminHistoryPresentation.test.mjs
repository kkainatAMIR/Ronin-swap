import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const admin = await readFile(new URL('../../src/pages/Admin.jsx', import.meta.url), 'utf8')

test('campaign and season history show newest records incrementally and independently', () => {
  assert.match(admin, /const newestCampaigns = \[\.\.\.filteredCampaigns\]\.sort/)
  assert.match(admin, /const newestSeasons = \[\.\.\.filteredSeasons\]\.sort/)
  assert.match(admin, /newestCampaigns\.slice\(0, visibleHistoryCampaignCount\)/)
  assert.match(admin, /newestSeasons\.slice\(0, visibleHistorySeasonCount\)/)
  assert.match(admin, /setVisibleHistoryCampaignCount\(\(count\) => count \+ 1\)/)
  assert.match(admin, /setVisibleHistorySeasonCount\(\(count\) => count \+ 1\)/)
  assert.match(admin, /View more campaigns/)
  assert.match(admin, /View more seasons/)
})

test('season creation form is hidden until requested without changing its submit action', () => {
  assert.match(admin, /showSeasonCreateForm \? 'Hide season form' : 'Create new season'/)
  assert.match(admin, /\{showSeasonCreateForm && \(/)
  assert.match(admin, /onClick=\{createSeasonRecord\}>Create draft season/)
})

test('history filters and existing record-management actions remain wired', () => {
  assert.match(admin, /setHistoryQuery\(event\.target\.value\)/)
  assert.match(admin, /setHistoryStatus\(event\.target\.value\)/)
  assert.match(admin, /onClick=\{\(\) => seasonAction\(season\.id, 'activate'\)\}/)
  assert.match(admin, /onClick=\{\(\) => updateSeasonMinimum\(season\)\}/)
  assert.match(admin, /onClick=\{saveSettings\}>Save campaigns/)
})

test('history archive presents independent record totals with a dedicated search and status layout', () => {
  assert.match(admin, /admin-history-counts/)
  assert.match(admin, /admin-history-count"><strong>\{filteredCampaigns\.length\}<\/strong><span>Campaigns/)
  assert.match(admin, /admin-history-count"><strong>\{filteredSeasons\.length\}<\/strong><span>Seasons/)
  assert.match(admin, /className="admin-history-search"/)
  assert.match(admin, /className="admin-history-status"/)
})
