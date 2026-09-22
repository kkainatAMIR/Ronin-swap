import { apiError, json, rateLimit } from '../api/_lib/roninBackend.mjs'

const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com'
const CACHE_TTL_MS = 45_000
const MAX_RESULTS = 15
const cache = new Map()
const chainSlugs = { solana: 'solana', ethereum: 'ethereum', robinhood: 'robinhood' }
const timeframes = new Set(['1h', '6h', '24h'])

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function timeframeValues(pair, timeframe) {
  const period = timeframe === '1h' ? 'h1' : timeframe === '6h' ? 'h6' : 'h24'
  const priceChange = number(pair?.priceChange?.[period])
  const txns = pair?.txns?.[period] || {}
  return { period, priceChange, buys: number(txns.buys), sells: number(txns.sells), transactions: number(txns.buys) + number(txns.sells) }
}

function scorePair(pair, timeframe) {
  const selected = timeframeValues(pair, timeframe)
  const volume = number(pair?.volume?.h24)
  const liquidity = number(pair?.liquidity?.usd)
  const boost = number(pair?.boosts?.active)
  const momentum = Math.max(-50, Math.min(100, selected.priceChange))
  return Math.log10(volume + 1) * 4.5
    + Math.log10(liquidity + 1) * 3
    + Math.log10(selected.transactions + 1) * 2.5
    + Math.max(0, momentum) / 12
    + Math.log10(boost + 1) * 0.5
}

async function getJson(path) {
  const response = await fetch(`${DEXSCREENER_BASE_URL}${path}`, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`DEXSCREENER_${response.status}`)
  return response.json()
}

async function discoverAddresses(chainSlug) {
  const [boosts, profiles] = await Promise.all([
    getJson('/token-boosts/top/v1').catch(() => []),
    getJson('/token-profiles/latest/v1').catch(() => []),
  ])
  const candidates = [...(Array.isArray(boosts) ? boosts : []), ...(Array.isArray(profiles) ? profiles : [])]
    .filter((item) => String(item?.chainId || '').toLowerCase() === chainSlug)
    .map((item) => String(item?.tokenAddress || '').trim())
    .filter(Boolean)
  if (chainSlug === 'ethereum' && candidates.length < 10) {
    const searchTerms = [
      'ETH', 'USDC', 'USDT', 'WETH', 'WBTC', 'DAI', 'PEPE', 'UNI', 'AAVE', 'LINK',
      'SHIB', 'MKR', 'CRV', 'LDO', 'APE', 'ARB', 'OP', 'stETH', 'rETH', 'cbETH',
      'PENDLE', 'ONDO', 'MATIC', 'TUSD', 'COMP', 'SNX', 'GRT', 'SUSHI', 'MKR', 'XRP',
    ]
    const searchResults = await Promise.all(searchTerms.map((term) => getJson(`/latest/dex/search?q=${encodeURIComponent(term)}`).catch(() => ({ pairs: [] }))))
    for (const result of searchResults) {
      for (const pair of Array.isArray(result?.pairs) ? result.pairs : []) {
        if (String(pair?.chainId || '').toLowerCase() === chainSlug && pair?.baseToken?.address) candidates.push(pair.baseToken.address)
      }
    }
  }
  return [...new Set(candidates)].slice(0, 100)
}

async function fetchPairs(chainSlug, addresses) {
  const pairs = []
  for (let index = 0; index < addresses.length; index += 25) {
    const chunk = addresses.slice(index, index + 25).join(',')
    const body = await getJson(`/tokens/v1/${chainSlug}/${chunk}`).catch(() => [])
    if (Array.isArray(body)) pairs.push(...body)
  }
  return pairs
}

function selectBestPairs(pairs, chainSlug, timeframe, minimumLiquidity, minimumVolume) {
  const bestByToken = new Map()
  for (const pair of pairs) {
    if (String(pair?.chainId || '').toLowerCase() !== chainSlug) continue
    const address = String(pair?.baseToken?.address || '').trim()
    const symbol = String(pair?.baseToken?.symbol || '').trim()
    const price = number(pair?.priceUsd)
    const liquidity = number(pair?.liquidity?.usd)
    const volume = number(pair?.volume?.h24)
    const selected = timeframeValues(pair, timeframe)
    if (!address || !symbol || price <= 0 || liquidity < minimumLiquidity || volume < minimumVolume || selected.transactions <= 0 || !pair?.pairAddress) continue
    const candidate = { pair, score: scorePair(pair, timeframe) }
    const key = address.toLowerCase()
    if (!bestByToken.has(key) || candidate.score > bestByToken.get(key).score) bestByToken.set(key, candidate)
  }
  return [...bestByToken.values()].sort((left, right) => right.score - left.score)
}

function normalize(candidate, chainSlug, timeframe, rank) {
  const pair = candidate.pair
  const selected = timeframeValues(pair, timeframe)
  return {
    rank,
    chain: chainSlug,
    chainId: chainSlug === 'solana' ? 'solana' : chainSlug === 'ethereum' ? 1 : 4663,
    address: pair.baseToken.address,
    mint: pair.baseToken.address,
    name: pair.baseToken.name || pair.baseToken.symbol,
    symbol: pair.baseToken.symbol,
    logoURI: pair.baseToken.icon || pair.info?.imageUrl || null,
    priceUsd: String(pair.priceUsd),
    priceChange: selected.priceChange,
    volume24h: number(pair.volume?.h24),
    liquidityUsd: number(pair.liquidity?.usd),
    transactions: selected.transactions,
    buys: selected.buys,
    sells: selected.sells,
    timeframe,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId || null,
    marketUrl: pair.url || null,
    activity: { priceChange: selected.priceChange, volumeUsd: number(pair.volume?.h24), liquidityUsd: number(pair.liquidity?.usd), transactions: selected.transactions, buys: selected.buys, sells: selected.sells },
  }
}

async function loadTrending(chainSlug, timeframe) {
  const addresses = await discoverAddresses(chainSlug)
  const pairs = await fetchPairs(chainSlug, addresses)
  let selected = selectBestPairs(pairs, chainSlug, timeframe, 5_000, 1_000)
  if (selected.length < 5) selected = selectBestPairs(pairs, chainSlug, timeframe, 500, 1)
  const tokens = selected.slice(0, MAX_RESULTS).map((item, index) => normalize(item, chainSlug, timeframe, index + 1))
  console.info('[trending]', { chain: chainSlug, timeframe, rawCandidates: addresses.length, rawPairs: pairs.length, finalTokens: tokens.length })
  return tokens
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'trending', 30, 60_000)) return apiError(res, 429, 'RATE_LIMITED', 'Trending data is temporarily rate limited.')
  const chain = String(req.query?.chain || 'solana').toLowerCase()
  const timeframe = String(req.query?.timeframe || '24h').toLowerCase()
  if (!chainSlugs[chain]) return apiError(res, 400, 'INVALID_CHAIN', 'chain must be solana, ethereum, or robinhood.')
  if (!timeframes.has(timeframe)) return apiError(res, 400, 'INVALID_TIMEFRAME', 'timeframe must be 1h, 6h, or 24h.')

  const key = `${chain}:${timeframe}`
  const cached = cache.get(key)
  const forceRefresh = String(req.query?.refresh || '') === '1'
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return json(res, 200, { ...cached.body, cached: true })

  try {
    const tokens = await loadTrending(chainSlugs[chain], timeframe)
    const body = { success: true, dataAvailable: tokens.length > 0, chain, timeframe, updatedAt: new Date().toISOString(), refreshAfterSeconds: CACHE_TTL_MS / 1000, tokens }
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, body })
    return json(res, 200, body)
  } catch (error) {
    console.error('[trending] unavailable', { chain, timeframe, message: error?.message || String(error) })
    return json(res, 200, { success: false, dataAvailable: false, chain, timeframe, updatedAt: new Date().toISOString(), refreshAfterSeconds: CACHE_TTL_MS / 1000, tokens: [], error: 'Trending data temporarily unavailable.' })
  }
}
