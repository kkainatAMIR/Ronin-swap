export function getAdminCampaignStatus(campaign, now = Date.now()) {
  if (String(campaign?.status || '').toUpperCase() === 'DRAFT') return 'DRAFT'
  if (campaign?.enabled === false) return 'DISABLED'

  const startAt = campaign?.startDate || campaign?.start_at || null
  const endAt = campaign?.endDate || campaign?.end_at || null
  const startTime = startAt ? Date.parse(startAt) : Number.NEGATIVE_INFINITY
  const endTime = endAt ? Date.parse(endAt) : Number.POSITIVE_INFINITY

  if ((startAt && !Number.isFinite(startTime)) || (endAt && !Number.isFinite(endTime))) return 'DRAFT'
  if (endTime <= now) return 'ENDED'
  if (startTime > now) return 'UPCOMING'
  return 'ACTIVE'
}

export function isAdminSeasonActive(season, now = Date.now()) {
  const startsAt = Date.parse(season?.start_at)
  const endsAt = Date.parse(season?.end_at)
  return season?.status === 'ACTIVE'
    && Number.isFinite(startsAt)
    && Number.isFinite(endsAt)
    && startsAt <= now
    && now < endsAt
}

export function filterAdminHistory(items, { query = '', status = 'ALL', getStatus, getSearchText }) {
  const normalizedQuery = query.trim().toLowerCase()
  return items.filter((item) => {
    const itemStatus = getStatus(item)
    if (status !== 'ALL' && itemStatus !== status) return false
    return !normalizedQuery || getSearchText(item).toLowerCase().includes(normalizedQuery)
  })
}
