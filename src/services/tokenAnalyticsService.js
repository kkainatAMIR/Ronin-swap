const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com/latest/dex/tokens'
const GECKOTERMINAL_BASE_URL = 'https://api.geckoterminal.com/api/v2'
const CACHE_TTL_MS = 45_000
const cache = new Map()
const inflight = new Map()

const chains = {
  solana: { dex: 'solana', gecko: 'solana' },
  ethereum: { dex: 'ethereum', gecko: 'eth' },
  robinhood: { dex: 'robinhood', gecko: 'robinhood' },
}

const ranges = {
  '1H': { timeframe: 'minute', aggregate: 1, limit: 60 },
  '1D': { timeframe: 'minute', aggregate: 15, limit: 96 },
  '1W': { timeframe: 'hour', aggregate: 1, limit: 168 },
  '1M': { timeframe: 'hour', aggregate: 4, limit: 180 },
  '1Y': { timeframe: 'day', aggregate: 1, limit: 365 },
}

function numeric(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function matchingDexPair(pairs, chain, address) {
  const normalizedAddress = address.toLowerCase()
  return (Array.isArray(pairs) ? pairs : [])
    .filter((pair) => String(pair?.chainId || '').toLowerCase() === chain.dex)
    .filter((pair) => {
      const base = String(pair?.baseToken?.address || '').toLowerCase()
      const quote = String(pair?.quoteToken?.address || '').toLowerCase()
      return base === normalizedAddress || quote === normalizedAddress
    })
    .sort((left, right) => numeric(right?.liquidity?.usd) - numeric(left?.liquidity?.usd))[0] || null
}

function normalizeDexMetrics(pair, address) {
  if (!pair) return null
  const isBase = String(pair.baseToken?.address || '').toLowerCase() === address.toLowerCase()
  const basePrice = numeric(pair.priceUsd)
  const nativePrice = numeric(pair.priceNative)
  const price = isBase ? basePrice : (basePrice != null && nativePrice > 0 ? basePrice / nativePrice : null)
  return {
    priceUsd: price,
    change24h: isBase ? numeric(pair.priceChange?.h24) : null,
    volume24hUsd: numeric(pair.volume?.h24),
    marketCapUsd: isBase ? numeric(pair.marketCap) : null,
    liquidityUsd: numeric(pair.liquidity?.usd),
    marketUrl: pair.url || null,
    marketSource: 'DexScreener',
  }
}

function matchingGeckoPools(pools, address) {
  const tokenKey = `_${address.toLowerCase()}`
  const poolList = Array.isArray(pools) ? pools : pools ? [pools] : []
  return poolList
    .filter((pool) => {
      const base = String(pool?.relationships?.base_token?.data?.id || '').toLowerCase()
      const quote = String(pool?.relationships?.quote_token?.data?.id || '').toLowerCase()
      return base.endsWith(tokenKey) || quote.endsWith(tokenKey)
    })
    .filter((pool) => Number(numeric(pool?.attributes?.reserve_in_usd) || 0) > 0)
    .sort((left, right) => Number(numeric(right?.attributes?.reserve_in_usd) || 0) - Number(numeric(left?.attributes?.reserve_in_usd) || 0))
}

function selectGeckoPool(pools, address) {
  return matchingGeckoPools(pools, address)[0] || null
}

function normalizeGeckoMetrics(pool, address) {
  const attributes = pool?.attributes
  if (!attributes) return null
  const isBase = String(pool.relationships?.base_token?.data?.id || '')
    .toLowerCase()
    .endsWith(`_${address.toLowerCase()}`)
  return {
    priceUsd: numeric(isBase ? attributes.base_token_price_usd : attributes.quote_token_price_usd),
    change24h: isBase ? numeric(attributes.price_change_percentage?.h24) : null,
    volume24hUsd: numeric(attributes.volume_usd?.h24),
    marketCapUsd: isBase ? numeric(attributes.market_cap_usd) : null,
    liquidityUsd: numeric(attributes.reserve_in_usd),
    marketUrl: null,
    marketSource: 'GeckoTerminal',
  }
}

function normalizeSolanaHolderCount(body) {
  if (Array.isArray(body)) return body.length
  if (Array.isArray(body?.holders)) return numeric(body.total) ?? body.holders.length
  return numeric(body?.total)
}

function normalizeCandles(payload, range) {
  const rows = payload?.data?.attributes?.ohlcv_list
  if (!Array.isArray(rows)) return []
  const rangeMs = { '1H': 60, '1D': 1440, '1W': 10080, '1M': 43200, '1Y': 525600 }[range] * 60_000
  const cutoff = Date.now() - rangeMs
  return rows
    .filter((row) => Array.isArray(row) && row.length >= 5)
    .map((row) => {
      const open = numeric(row[1])
      const high = numeric(row[2])
      const low = numeric(row[3])
      const close = numeric(row[4])
      return {
        time: Number(row[0]) * 1000,
        open,
        high,
        low,
        close,
        price: close,
        volume: numeric(row[5]),
      }
    })
    .filter((point) => Number.isFinite(point.time)
      && point.time >= cutoff
      && point.open > 0
      && point.high > 0
      && point.low > 0
      && point.close > 0)
    .sort((left, right) => left.time - right.time)
}

async function fetchGeckoPoolChart(chain, pool, address, range) {
  const poolAddress = pool?.attributes?.address
  if (!poolAddress || !chain.gecko) return []
  const baseTokenId = String(pool.relationships?.base_token?.data?.id || '').toLowerCase()
  const chartToken = baseTokenId.endsWith(`_${address.toLowerCase()}`) ? 'base' : 'quote'
  const rangeConfig = ranges[range]
  if (!rangeConfig) return []
  const query = new URLSearchParams({
    aggregate: String(rangeConfig.aggregate),
    limit: String(rangeConfig.limit),
    currency: 'usd',
    token: chartToken,
  })
  const candleData = await fetchJson(
    `${GECKOTERMINAL_BASE_URL}/networks/${chain.gecko}/pools/${encodeURIComponent(poolAddress)}/ohlcv/${rangeConfig.timeframe}?${query}`,
  )
  return normalizeCandles(candleData, range)
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8_000) })
  if (!response.ok) throw new Error(`Market data provider returned HTTP ${response.status}.`)
  return response.json()
}

async function fetchSolanaHolderCount(mint) {
  const query = new URLSearchParams({
    resource: 'holders',
    owner: mint,
    mint,
  })
  const body = await fetchJson(`/api/solana/enhanced?${query}`)
  return normalizeSolanaHolderCount(body)
}

async function loadAnalytics(chainName, address, range) {
  const chain = chains[chainName]
  const dexPromise = fetchJson(`${DEXSCREENER_BASE_URL}/${encodeURIComponent(address)}`)
  const holdersPromise = chainName === 'solana'
    ? fetchSolanaHolderCount(address).catch(() => null)
    : Promise.resolve(null)
  let geckoPoolsPromise = null
  if (chain.gecko) {
    geckoPoolsPromise = fetchJson(`${GECKOTERMINAL_BASE_URL}/networks/${chain.gecko}/tokens/${encodeURIComponent(address)}/pools?page=1`)
      .catch(() => null)
  }

  const [dexData, geckoPoolsData, holders] = await Promise.all([
    dexPromise.catch(() => null),
    geckoPoolsPromise || Promise.resolve(null),
    holdersPromise,
  ])
  const dexPair = matchingDexPair(dexData?.pairs, chain, address)
  const geckoPools = matchingGeckoPools(geckoPoolsData?.data, address)
  let geckoPool = geckoPools[0] || null
  const metrics = (chainName === 'robinhood' ? null : normalizeGeckoMetrics(geckoPool, address))
    || normalizeDexMetrics(dexPair, address)
  if (metrics) {
    metrics.holders = holders
    metrics.holdersSource = holders == null ? null : 'Helius'
  }

  let chart = []
  let chartSource = null
  if (chain.gecko) {
    const chartPools = geckoPools.slice(0, 3)
    for (const pool of chartPools) {
      try {
        chart = await fetchGeckoPoolChart(chain, pool, address, range)
      } catch {
        chart = []
      }
      if (chart.length) {
        chartSource = 'GeckoTerminal'
        break
      }
    }

    const directPoolAddress = String(dexPair?.pairAddress || '').toLowerCase()
    const triedDirectPool = chartPools.some((pool) =>
      String(pool?.attributes?.address || '').toLowerCase() === directPoolAddress)
    if (!chart.length && directPoolAddress && !triedDirectPool) {
      try {
        const poolData = await fetchJson(
          `${GECKOTERMINAL_BASE_URL}/networks/${chain.gecko}/pools/${encodeURIComponent(dexPair.pairAddress)}`,
        )
        const directPool = selectGeckoPool(poolData?.data, address)
        chart = directPool ? await fetchGeckoPoolChart(chain, directPool, address, range) : []
        if (chart.length) chartSource = 'GeckoTerminal'
      } catch {
        chart = []
      }
    }
  }

  return {
    available: Boolean(metrics),
    metrics: metrics || null,
    chart,
    chartSource,
    chartAvailable: chart.length > 1,
    chartUnavailableReason: 'Historical price data is unavailable for this token.',
  }
}

export function getTokenAnalytics({ chain, address, range = '1D' }) {
  const chainName = String(chain || '').toLowerCase()
  const normalizedAddress = String(address || '').trim()
  if (!chains[chainName] || !normalizedAddress || !ranges[range]) {
    return Promise.resolve({
      available: false,
      metrics: null,
      chart: [],
      chartSource: null,
      chartAvailable: false,
      chartUnavailableReason: 'Analytics unavailable for this token.',
    })
  }

  const key = `${chainName}:${normalizedAddress.toLowerCase()}:${range}`
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
  if (inflight.has(key)) return inflight.get(key)

  const request = loadAnalytics(chainName, normalizedAddress, range)
    .catch(() => ({
      available: false,
      metrics: null,
      chart: [],
      chartSource: null,
      chartAvailable: false,
      chartUnavailableReason: 'Analytics unavailable right now.',
    }))
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

export const TOKEN_ANALYTICS_RANGES = Object.freeze(Object.keys(ranges))
