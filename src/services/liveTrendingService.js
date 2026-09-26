const TRENDING_CACHE = new Map()
const CACHE_TTL_MS = 45_000

export async function getLiveTrendingTokens({ chain, timeframe = '24h', force = false } = {}) {
  const key = `${chain}:${timeframe}`
  const cached = TRENDING_CACHE.get(key)
  const now = Date.now()
  if (!force && cached && cached.expiresAt > now) {
    // Cache hit — return the cached body without hitting the network.
    // Helps debug whether the "Ethereum trending not refreshing" issue
    // is actually a stale-cache problem.
    console.info('[liveTrendingService] cache HIT', {
      chain,
      timeframe,
      tokens: (cached.body?.tokens || []).length,
      dataAvailable: cached.body?.dataAvailable,
      ageMs: now - cached.fetchedAt,
      ttlRemainingMs: cached.expiresAt - now,
    })
    return cached.body
  }

  const url = `/api/trending?chain=${encodeURIComponent(chain)}&timeframe=${encodeURIComponent(timeframe)}`
  console.info('[liveTrendingService] request STARTED', { chain, timeframe, url, forceRefresh: force, cacheState: cached ? 'expired' : 'empty' })
  const startedAt = Date.now()
  const response = await fetch(url, { cache: 'no-store' })
  const elapsedMs = Date.now() - startedAt
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    console.warn('[liveTrendingService] request FAILED', {
      chain,
      timeframe,
      url,
      httpStatus: response.status,
      elapsedMs,
      error: body?.error || 'Unknown error',
      code: body?.code,
    })
    throw new Error(body?.error || 'Trending data temporarily unavailable.')
  }
  console.info('[liveTrendingService] request OK', {
    chain,
    timeframe,
    httpStatus: response.status,
    elapsedMs,
    dataAvailable: body.dataAvailable,
    tokenCount: (body.tokens || []).length,
    pinnedCount: (body.tokens || []).filter((t) => t.pinned).length,
    cached: Boolean(body.cached),
    updatedAt: body.updatedAt,
  })
  TRENDING_CACHE.set(key, { expiresAt: now + CACHE_TTL_MS, fetchedAt: now, body })
  return body
}
