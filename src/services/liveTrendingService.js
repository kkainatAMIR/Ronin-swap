const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com'

function pairActivity(pair) {
  const txns = pair?.txns?.h24 || {}
  const buys = Number(txns.buys || 0)
  const sells = Number(txns.sells || 0)
  const volumeUsd = Number(pair?.volume?.h24 || 0)
  const liquidityUsd = Number(pair?.liquidity?.usd || 0)
  const priceChange24h = Number(pair?.priceChange?.h24 || 0)
  return { buys, sells, transactions: buys + sells, volumeUsd, liquidityUsd, priceChange24h }
}

function rankingScore(activity) {
  return Math.log10(activity.volumeUsd + 1) * 5
    + Math.log10(activity.liquidityUsd + 1) * 3
    + Math.log10(activity.transactions + 1) * 2
    - Math.min(Math.abs(activity.priceChange24h) / 30, 3)
}

function bestPairForChain(pairs, chainSlug) {
  return (Array.isArray(pairs) ? pairs : [])
    .filter((pair) => pair?.chainId === chainSlug && Number.isFinite(Number(pair?.priceUsd)))
    .sort((left, right) => pairActivity(right).volumeUsd - pairActivity(left).volumeUsd)[0] || null
}

function trendingKey(token) {
  return String(token?.address || token?.mint || token?.symbol || '').toLowerCase()
}

async function fetchTrendingMetaSlugs(limit = 50) {
  const response = await fetch(`${DEXSCREENER_BASE_URL}/metas/trending/v1`, { signal: AbortSignal.timeout(8_000) })
  if (!response.ok) return []
  const body = await response.json().catch(() => [])
  return Array.isArray(body) ? body.slice(0, limit).map((item) => String(item?.slug || '').trim()).filter(Boolean) : []
}

async function fetchMetaPairs(slug) {
  const response = await fetch(`${DEXSCREENER_BASE_URL}/metas/meta/v1/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(8_000) })
  if (!response.ok) return null
  return response.json().catch(() => null)
}

function pairToToken(pair, chainId) {
  const baseToken = pair?.baseToken || {}
  const activity = pairActivity(pair)
  const address = String(baseToken.address || '').trim()
  if (!address) return null
  return {
    chainId,
    chainKey: String(pair?.chainId || '').toLowerCase(),
    type: 'erc20',
    address,
    symbol: baseToken.symbol || 'UNKNOWN',
    name: baseToken.name || baseToken.symbol || 'Unknown token',
    decimals: Number(baseToken.decimals ?? 18),
    logoURI: baseToken.icon || null,
    marketUrl: pair.url || null,
    pairAddress: pair.pairAddress || null,
    activity,
    score: rankingScore(activity),
  }
}

async function discoverTrendingByMetaFeed({ chainId, chainSlug, limit }) {
  const slugs = await fetchTrendingMetaSlugs(Math.max(limit * 6, 30))
  if (!slugs.length) return []

  const metas = await Promise.all(slugs.map(async (slug) => fetchMetaPairs(slug)))
  const byAddress = new Map()

  for (const meta of metas.filter(Boolean)) {
    for (const pair of Array.isArray(meta?.pairs) ? meta.pairs : []) {
      if (String(pair?.chainId || '').toLowerCase() !== String(chainSlug).toLowerCase()) continue
      if (!Number.isFinite(Number(pair?.priceUsd))) continue
      const token = pairToToken(pair, chainId)
      if (!token) continue
      const key = trendingKey(token)
      if (!key) continue
      const current = byAddress.get(key)
      if (!current || token.score > current.score) byAddress.set(key, token)
    }
  }

  return [...byAddress.values()].sort((left, right) => right.score - left.score).slice(0, limit)
}

async function discoverTrendingFromTokens({ chainId, chainSlug, tokens, limit }) {
  const seen = new Set()
  const candidates = (Array.isArray(tokens) ? tokens : [])
    .filter(Boolean)
    .filter((token) => {
      const key = trendingKey(token)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return Boolean(token.address || token.mint)
    })

  const marketResults = await Promise.all(candidates.map(async (token) => {
    const lookupAddress = String(token.address || token.mint || '').trim()
    if (!lookupAddress) return null
    try {
      const response = await fetch(`${DEXSCREENER_BASE_URL}/latest/dex/tokens/${lookupAddress}`, { signal: AbortSignal.timeout(8_000) })
      if (!response.ok) return null
      const body = await response.json().catch(() => null)
      const pair = bestPairForChain(body?.pairs, chainSlug)
      if (!pair) return null
      const activity = pairActivity(pair)
      return {
        ...token,
        chainId,
        activity,
        marketUrl: pair.url || null,
        pairAddress: pair.pairAddress || null,
        score: rankingScore(activity),
      }
    } catch {
      return null
    }
  }))

  const uniqueBySymbol = new Map()
  for (const item of marketResults.filter(Boolean).sort((left, right) => right.score - left.score)) {
    const symbol = String(item.symbol || item.name || item.address || item.mint || '').toUpperCase()
    if (!symbol || uniqueBySymbol.has(symbol)) continue
    uniqueBySymbol.set(symbol, item)
  }

  return [...uniqueBySymbol.values()].slice(0, limit)
}

export async function getLiveTrendingTokens({ chainId, chainSlug, tokens = [], limit = 10 }) {
  const liveResults = await discoverTrendingByMetaFeed({ chainId, chainSlug, limit }).catch(() => [])
  if (liveResults.length) return liveResults
  return discoverTrendingFromTokens({ chainId, chainSlug, tokens, limit }).catch(() => [])
}
