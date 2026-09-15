const TRENDING_CACHE = new Map()
const CACHE_TTL_MS = 45_000

export async function getLiveTrendingTokens({ chain, timeframe = '24h', force = false } = {}) {
  const key = `${chain}:${timeframe}`
  const cached = TRENDING_CACHE.get(key)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.body

  const response = await fetch(`/api/trending?chain=${encodeURIComponent(chain)}&timeframe=${encodeURIComponent(timeframe)}`, { cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || 'Trending data temporarily unavailable.')
  TRENDING_CACHE.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, body })
  return body
}
