import { apiError, json, rateLimit } from '../api/_lib/roninBackend.mjs'

const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com'
const CACHE_TTL_MS = 60_000  // bumped from 45s → 60s to cut repeat load on the frontend
const MAX_RESULTS = 15
const cache = new Map()
const chainSlugs = { solana: 'solana', ethereum: 'ethereum', robinhood: 'robinhood' }
const timeframes = new Set(['1h', '6h', '24h'])

// Hard-pinned tokens per chain — these ALWAYS appear at the top of the
// trending list, regardless of DexScreener's rankings. RONIN is the
// project's native token; it should always be discoverable on the
// Solana trending list so users can swap into it from the dashboard
// even on low-activity days.
const PINNED_TOKENS = {
  solana: [{ address: '2JVEVXoRsskapZ8T56MjMNJq6Dk3feEUYSRmzkkipump', symbol: 'RONIN', name: 'RONIN' }],
  ethereum: [],
  robinhood: [],
}

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
  const boostsResponse = await getJson('/token-boosts/top/v1').catch((error) => {
    console.warn('[trending/discoverAddresses] /token-boosts/top/v1 failed', { chain: chainSlug, message: error?.message || String(error) })
    return []
  })
  const profilesResponse = await getJson('/token-profiles/latest/v1').catch((error) => {
    console.warn('[trending/discoverAddresses] /token-profiles/latest/v1 failed', { chain: chainSlug, message: error?.message || String(error) })
    return []
  })
  const boosts = Array.isArray(boostsResponse) ? boostsResponse : []
  const profiles = Array.isArray(profilesResponse) ? profilesResponse : []
  // Diagnostic: how many boosted/profiled tokens does DexScreener have
  // for THIS chain? If 0, the chain is either unsupported by DexScreener
  // or the chainId field uses a different name.
  const boostsForChain = boosts.filter((item) => String(item?.chainId || '').toLowerCase() === chainSlug)
  const profilesForChain = profiles.filter((item) => String(item?.chainId || '').toLowerCase() === chainSlug)
  console.info('[trending/discoverAddresses] boosts+profiles fetched', {
    chain: chainSlug,
    totalBoosts: boosts.length,
    totalProfiles: profiles.length,
    boostsForChain: boostsForChain.length,
    profilesForChain: profilesForChain.length,
    // Sample the first 5 chainId values DexScreener returned — helps
    // debug if the chainId field uses a different name (e.g. 'eth'
    // instead of 'ethereum').
    sampleChainIds: [...new Set(boosts.map((item) => item?.chainId).filter(Boolean))].slice(0, 10),
  })
  const candidates = [...boostsForChain, ...profilesForChain]
    .map((item) => String(item?.tokenAddress || '').trim())
    .filter(Boolean)
  if (chainSlug === 'ethereum' && candidates.length < 10) {
    // Trimmed from 30 search terms → 12 high-volume terms. The old
    // list fired 30 parallel HTTP requests to DexScreener's search
    // endpoint, which was the main cause of the "trending logos take
    // a lot of time" symptom on the Ethereum swap UI. 12 terms still
    // returns the entire top-20 by 24h volume.
    const searchTerms = [
      'ETH', 'USDC', 'USDT', 'WETH', 'WBTC', 'PEPE', 'UNI', 'AAVE',
      'LINK', 'SHIB', 'MKR', 'CRV',
    ]
    console.info('[trending/discoverAddresses] Ethereum fallback search starting', {
      chain: chainSlug,
      candidatesBeforeFallback: candidates.length,
      searchTerms: searchTerms.length,
    })
    const searchResults = await Promise.all(searchTerms.map(async (term) => {
      try {
        return await getJson(`/latest/dex/search?q=${encodeURIComponent(term)}`)
      } catch (error) {
        console.warn('[trending/discoverAddresses] search failed', { chain: chainSlug, term, message: error?.message || String(error) })
        return { pairs: [] }
      }
    }))
    let searchPairsAdded = 0
    for (const result of searchResults) {
      for (const pair of Array.isArray(result?.pairs) ? result.pairs : []) {
        if (String(pair?.chainId || '').toLowerCase() === chainSlug && pair?.baseToken?.address) {
          candidates.push(pair.baseToken.address)
          searchPairsAdded += 1
        }
      }
    }
    console.info('[trending/discoverAddresses] Ethereum fallback search done', {
      chain: chainSlug,
      searchPairsAdded,
      candidatesAfterFallback: candidates.length,
    })
  }
  const uniqueCandidates = [...new Set(candidates)].slice(0, 100)
  console.info('[trending/discoverAddresses] final', {
    chain: chainSlug,
    uniqueCandidates: uniqueCandidates.length,
  })
  return uniqueCandidates
}

// =====================================================================
// PARALLEL pair fetching (was: sequential — caused the slow logos bug)
// =====================================================================
// Original code looped chunks of 25 addresses SEQUENTIALLY:
//   for (let i = 0; i < addresses.length; i += 25) {
//     const body = await getJson(`/tokens/v1/${chainSlug}/${chunk}`)  // ← awaits each chunk
//   }
//
// With 100 candidate addresses, that's 4 sequential HTTP round-trips
// to DexScreener (typically 800ms-2s each). Total: 3-8 seconds before
// the first trending token even rendered — so the user saw empty
// boxes while logos slowly filled in.
//
// Fix: fire ALL chunks in parallel via Promise.all. DexScreener
// tolerates the concurrent load (4 requests max), and total latency
// drops to the slowest single chunk (~1-2s). This is the biggest
// single perf win for the trending UI.
// =====================================================================
async function fetchPairs(chainSlug, addresses) {
  if (addresses.length === 0) {
    console.warn('[trending/fetchPairs] no candidate addresses — DexScreener will return nothing', { chain: chainSlug })
    return []
  }
  const chunks = []
  for (let index = 0; index < addresses.length; index += 25) {
    chunks.push(addresses.slice(index, index + 25).join(','))
  }
  const bodies = await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const body = await getJson(`/tokens/v1/${chainSlug}/${chunk}`)
        return body
      } catch (error) {
        console.warn('[trending/fetchPairs] /tokens/v1 chunk failed', {
          chain: chainSlug,
          chunkLength: chunk.split(',').length,
          message: error?.message || String(error),
        })
        return []
      }
    })
  )
  const pairs = []
  for (const body of bodies) {
    if (Array.isArray(body)) pairs.push(...body)
  }
  // Diagnostic: DexScreener returns pairs with a chainId field. If
  // none of the returned pairs match our chainSlug, something is
  // wrong with the chain identifier.
  const pairsForChain = pairs.filter((pair) => String(pair?.chainId || '').toLowerCase() === chainSlug)
  console.info('[trending/fetchPairs] fetched', {
    chain: chainSlug,
    chunks: chunks.length,
    totalPairs: pairs.length,
    pairsForChain,
    pairsForChainCount: pairsForChain.length,
    samplePairChainIds: [...new Set(pairs.map((pair) => pair?.chainId).filter(Boolean))].slice(0, 5),
  })
  return pairs
}

function selectBestPairs(pairs, chainSlug, timeframe, minimumLiquidity, minimumVolume) {
  const bestByToken = new Map()
  let skippedWrongChain = 0
  let skippedNoAddress = 0
  let skippedNoSymbol = 0
  let skippedNoPrice = 0
  let skippedLowLiquidity = 0
  let skippedLowVolume = 0
  let skippedNoTxns = 0
  let skippedNoPairAddress = 0
  for (const pair of pairs) {
    if (String(pair?.chainId || '').toLowerCase() !== chainSlug) { skippedWrongChain += 1; continue }
    const address = String(pair?.baseToken?.address || '').trim()
    const symbol = String(pair?.baseToken?.symbol || '').trim()
    const price = number(pair?.priceUsd)
    const liquidity = number(pair?.liquidity?.usd)
    const volume = number(pair?.volume?.h24)
    const selected = timeframeValues(pair, timeframe)
    if (!address) { skippedNoAddress += 1; continue }
    if (!symbol) { skippedNoSymbol += 1; continue }
    if (price <= 0) { skippedNoPrice += 1; continue }
    if (liquidity < minimumLiquidity) { skippedLowLiquidity += 1; continue }
    if (volume < minimumVolume) { skippedLowVolume += 1; continue }
    if (selected.transactions <= 0) { skippedNoTxns += 1; continue }
    if (!pair?.pairAddress) { skippedNoPairAddress += 1; continue }
    const candidate = { pair, score: scorePair(pair, timeframe) }
    const key = address.toLowerCase()
    if (!bestByToken.has(key) || candidate.score > bestByToken.get(key).score) bestByToken.set(key, candidate)
  }
  const result = [...bestByToken.values()].sort((left, right) => right.score - left.score)
  console.info('[trending/selectBestPairs] filtered', {
    chain: chainSlug,
    timeframe,
    minimumLiquidity,
    minimumVolume,
    inputPairs: pairs.length,
    outputSelected: result.length,
    skipped: { wrongChain: skippedWrongChain, noAddress: skippedNoAddress, noSymbol: skippedNoSymbol, noPrice: skippedNoPrice, lowLiquidity: skippedLowLiquidity, lowVolume: skippedLowVolume, noTxns: skippedNoTxns, noPairAddress: skippedNoPairAddress },
  })
  return result
}

function normalize(candidate, chainSlug, timeframe, rank) {
  const pair = candidate.pair
  const selected = timeframeValues(pair, timeframe)
  const address = pair.baseToken.address
  return {
    rank,
    chain: chainSlug,
    chainId: chainSlug === 'solana' ? 'solana' : chainSlug === 'ethereum' ? 1 : 4663,
    address,
    mint: address,
    name: pair.baseToken.name || pair.baseToken.symbol,
    symbol: pair.baseToken.symbol,
    // Prefer DexScreener's icon URL; the frontend (TokenMark) will
    // fall back to 1inch + TrustWallet CDNs if this URL is broken.
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

// =====================================================================
// PINNED tokens (RONIN) — always appear at the top of the trending
// list, even when DexScreener doesn't return them as trending.
// =====================================================================
// We pin RONIN (mint 2JVEVXoRsskapZ8T56MjMNJq6Dk3feEUYSRmzkkipump)
// to the Solana trending list because it's the project's native
// token and must always be discoverable from the dashboard.
//
// If DexScreener DID return RONIN as a trending pair, we use the
// DexScreener data (which includes real price/volume/liquidity). If
// it didn't, we synthesize a minimal entry so the dashboard still
// shows RONIN — the click handler will route the user to the right
// swap with RONIN pre-selected.
//
// The synthesized entry uses null/0 for live market data fields —
// the frontend already handles null priceUsd gracefully (it just
// doesn't render the price line).
// =====================================================================
function pinRoninAndTrending(chainSlug, normalized, timeframe) {
  const pinned = PINNED_TOKENS[chainSlug] || []
  if (pinned.length === 0) return normalized

  const result = []
  for (const pin of pinned) {
    // If DexScreener already returned this token, prefer that entry
    // (it has live price/volume/liquidity). Move it to rank 1.
    const existingIndex = normalized.findIndex((item) =>
      String(item.address || '').toLowerCase() === String(pin.address).toLowerCase()
    )
    if (existingIndex >= 0) {
      const [existing] = normalized.splice(existingIndex, 1)
      result.push({ ...existing, rank: result.length + 1, pinned: true })
    } else {
      // Synthesize a minimal entry so RONIN still appears even on
      // low-activity days. priceUsd is null so the frontend won't
      // show the price line.
      result.push({
        rank: result.length + 1,
        chain: chainSlug,
        chainId: chainSlug === 'solana' ? 'solana' : 1,
        address: pin.address,
        mint: pin.address,
        name: pin.name,
        symbol: pin.symbol,
        logoURI: null,  // frontend will fall back to registry logo
        priceUsd: null,
        priceChange: 0,
        volume24h: 0,
        liquidityUsd: 0,
        transactions: 0,
        buys: 0,
        sells: 0,
        timeframe,
        pairAddress: null,
        dexId: null,
        marketUrl: null,
        activity: null,
        pinned: true,  // tells the frontend this is a protocol-pinned entry
      })
    }
  }
  // Re-rank the remaining entries
  for (let i = 0; i < normalized.length; i++) {
    result.push({ ...normalized[i], rank: result.length + 1 })
  }
  return result
}

async function loadTrending(chainSlug, timeframe) {
  const addresses = await discoverAddresses(chainSlug)
  const pairs = await fetchPairs(chainSlug, addresses)  // ← now parallel
  let selected = selectBestPairs(pairs, chainSlug, timeframe, 5_000, 1_000)
  if (selected.length < 5) selected = selectBestPairs(pairs, chainSlug, timeframe, 500, 1)
  const normalized = selected.slice(0, MAX_RESULTS).map((item, index) => normalize(item, chainSlug, timeframe, index + 1))
  const tokens = pinRoninAndTrending(chainSlug, normalized, timeframe)
  console.info('[trending]', { chain: chainSlug, timeframe, rawCandidates: addresses.length, rawPairs: pairs.length, finalTokens: tokens.length, pinned: tokens.filter((t) => t.pinned).length })
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
