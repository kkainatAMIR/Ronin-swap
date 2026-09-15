import { apiError, json, rateLimit } from '../_lib/roninBackend.mjs'
import { getRobinhoodTokenCatalog } from '../_lib/lifi.mjs'
import { filterCatalogTokens, getRobinhoodMarketPairs, isEligibleForRanking, pairActivity, rankingScore, safetyFor, tokenLogoUri } from '../_lib/robinhoodMarket.mjs'

const CHAIN_ID = 4663
const MAX_RESULTS = 10

function tokenKey(token) {
  return `${CHAIN_ID}:${String(token.address || '').toLowerCase()}`
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'robinhood-trending', 12, 60_000)) return apiError(res, 429, 'RATE_LIMITED', 'Trending data is temporarily rate limited.')

  try {
    const catalog = await getRobinhoodTokenCatalog()
    const candidates = filterCatalogTokens(catalog)
    const pairsByAddress = await getRobinhoodMarketPairs(candidates)
    const marketResults = candidates.map((token) => {
      const pair = pairsByAddress.get(String(token.address).toLowerCase())
      if (!pair || !isEligibleForRanking(token, pair)) return null
      const activity = pairActivity(pair)
      const safety = safetyFor(token, pair)
      return {
        id: tokenKey(token),
        chainId: CHAIN_ID,
        address: token.address,
        symbol: token.symbol || 'UNKNOWN',
        name: token.name || token.symbol || 'Unknown token',
        decimals: Number(token.decimals),
        logoURI: tokenLogoUri(token, pair),
        verification: safety.checks.verification,
        warning: safety.warnings.join(' '),
        warnings: safety.warnings,
        checks: safety.checks,
        activity,
        pairAddress: pair.pairAddress,
        marketUrl: pair.url || null,
        score: rankingScore(activity),
      }
    })
    const unavailable = candidates.length - marketResults.filter(Boolean).length
    const valid = marketResults.filter(Boolean)
    const duplicateSymbols = new Set(valid.map((item) => item.symbol.toUpperCase()).filter((symbol, index, list) => list.indexOf(symbol) !== index))
    const unique = new Map()
    for (const item of valid.sort((left, right) => right.score - left.score)) {
      const symbol = item.symbol.toUpperCase()
      if (!unique.has(symbol)) unique.set(symbol, { ...item, duplicateTicker: duplicateSymbols.has(symbol), warnings: duplicateSymbols.has(symbol) ? [...item.warnings, 'Duplicate ticker exists on this chain.'] : item.warnings })
    }
    const results = [...unique.values()].slice(0, MAX_RESULTS).map(({ score: _score, ...item }) => item)
    return json(res, 200, {
      success: true,
      chainId: CHAIN_ID,
      source: 'LI.FI token catalog + DexScreener Robinhood markets',
      generatedAt: new Date().toISOString(),
      refreshAfterSeconds: 60,
      results,
      warnings: unavailable ? [`${unavailable} market lookups were unavailable.`] : [],
      dataAvailable: results.length > 0,
    })
  } catch (error) {
    console.error('Robinhood trending unavailable:', error?.message || error)
    return json(res, 200, { success: false, chainId: CHAIN_ID, source: 'LI.FI token catalog + DexScreener Robinhood markets', generatedAt: new Date().toISOString(), refreshAfterSeconds: 60, results: [], warnings: ['Live trending data is currently unavailable.'], dataAvailable: false })
  }
}
