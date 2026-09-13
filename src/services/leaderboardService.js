export async function getLeaderboard({ period, page = 1, limit = 25, wallet, seasonId } = {}) {
  const params = new URLSearchParams({ period, page: String(page), limit: String(limit) })
  if (wallet) params.set('wallet', wallet)
  if (seasonId) params.set('seasonId', seasonId)
  const response = await fetch(`/api/leaderboard?${params.toString()}`)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || 'Unable to load leaderboard.')
  return body
}

export async function getCurrentSeason() {
  const response = await fetch('/api/samurai/season/current')
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || 'Unable to load current season.')
  return body.season
}