// Shared Robinhood Chain (4663) token-safety and market-activity helpers,
// used by both /api/robinhood/trending and /api/robinhood/tokens so the two
// endpoints agree on what counts as a real, eligible token instead of each
// re-implementing their own filtering rules.
const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com'
const ROBINHOOD_CHAIN_SLUG = 'robinhood'
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
export const MIN_LIQUIDITY_USD = 5_000

export const EQUITY_SYMBOLS = new Set(['AAPL', 'AMC', 'AMZN', 'DIS', 'DIA', 'GME', 'GOOG', 'GOOGL', 'HOOD', 'IWM', 'META', 'MSTR', 'MSFT', 'NFLX', 'NVDA', 'QQQ', 'SPCX', 'SPY', 'TSLA', 'COIN'])
export const EQUITY_PATTERN = /stock|equity|share|tokenized|synthetic|etf|nasdaq|s&p|dow\s*jones|tesla|apple|amazon|alphabet|google|nvidia|microsoft|meta platforms|netflix|spacex|coinbase|microstrategy|robinhood markets|gamestop|disney|amc entertainment/i
export const MEME_PATTERN = /doge|shib|pepe|inu\b|\bcat\b|moon|elon|meme|wojak|frog|chad|based|bonk|floki|trump|wif\b|bome|pump|rekt|ape\b|banana|degen|bobo|turbo|mog\b/i

export function isEquityLike(token) {
  const symbol = String(token?.symbol || '').toUpperCase()
  return EQUITY_SYMBOLS.has(symbol) || EQUITY_PATTERN.test(`${token?.symbol || ''} ${token?.name || ''}`)
}

export function isMemeToken(token) {
  return MEME_PATTERN.test(`${token?.symbol || ''} ${token?.name || ''}`)
}

export function filterCatalogTokens(tokens) {
  return (Array.isArray(tokens) ? tokens : []).filter((token) => {
    const address = String(token?.address || '').toLowerCase()
    // LI.FI's catalog includes a synthetic zero-address entry for native ETH;
    // callers already list native ETH separately, so drop it here to avoid a duplicate.
    if (address === '0x0000000000000000000000000000000000000000') return false
    return ADDRESS_PATTERN.test(address) && !isEquityLike(token)
  })
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error(`UPSTREAM_${response.status}`)
  return response.json().catch(() => ({}))
}

export function pairActivity(pair) {
  const txns = pair?.txns?.h24 || {}
  const buys = Number(txns.buys || 0)
  const sells = Number(txns.sells || 0)
  const volumeUsd = Number(pair?.volume?.h24 || 0)
  const liquidityUsd = Number(pair?.liquidity?.usd || 0)
  const priceChange24h = Number(pair?.priceChange?.h24 || 0)
  return { buys, sells, transactions: buys + sells, volumeUsd, liquidityUsd, priceChange24h }
}

export function tokenLogoUri(token, pair) {
  const pairLogo = String(pair?.baseToken?.icon || pair?.info?.imageUrl || pair?.baseToken?.logoURI || '').trim()
  const tokenLogo = String(token?.logoURI || token?.icon || token?.image || '').trim()
  return pairLogo || tokenLogo || null
}

// Batches candidate addresses through DexScreener and returns the best
// (highest-volume) pair per token address, keyed by lowercase address.
export async function getRobinhoodMarketPairs(candidates) {
  const addresses = candidates.map((token) => token.address).filter(Boolean)
  const chunks = []
  for (let index = 0; index < addresses.length; index += 25) chunks.push(addresses.slice(index, index + 25).join(','))
  const responses = await Promise.all(chunks.map((chunk) => getJson(`${DEXSCREENER_BASE_URL}/tokens/v1/${ROBINHOOD_CHAIN_SLUG}/${chunk}`).catch(() => [])))
  const pairs = responses.flatMap((response) => Array.isArray(response) ? response : [])
  const byAddress = new Map()
  for (const pair of pairs) {
    if (pair?.chainId !== ROBINHOOD_CHAIN_SLUG) continue
    const address = String(pair?.baseToken?.address || '').toLowerCase()
    if (!address) continue
    const current = byAddress.get(address)
    if (!current || pairActivity(pair).volumeUsd > pairActivity(current).volumeUsd) byAddress.set(address, pair)
  }
  return byAddress
}

export function safetyFor(token, pair) {
  const activity = pairActivity(pair)
  const warnings = []
  const checks = {
    address: ADDRESS_PATTERN.test(String(token.address || '')),
    liquidity: activity.liquidityUsd >= MIN_LIQUIDITY_USD,
    route: 'unavailable',
    quoteSimulation: 'unavailable',
    transferRestrictions: 'unavailable',
    honeypot: 'unavailable',
    verification: token.verificationStatus === 'verified' ? 'verified' : 'unverified',
  }
  if (checks.verification !== 'verified') warnings.push('Token verification is unavailable.')
  if (checks.transferRestrictions === 'unavailable') warnings.push('Transfer restriction screening is unavailable.')
  if (checks.honeypot === 'unavailable') warnings.push('Honeypot screening is unavailable.')
  if (checks.route === 'unavailable') warnings.push('Executable route has not been checked.')
  if (activity.priceChange24h && Math.abs(activity.priceChange24h) > 90) warnings.push('Abnormal 24h price movement.')
  return { checks, warnings }
}

export function isEligibleForRanking(token, pair) {
  const activity = pairActivity(pair)
  const safety = safetyFor(token, pair)
  return safety.checks.address && safety.checks.liquidity && activity.volumeUsd > 0 && activity.transactions > 0 && Math.abs(activity.priceChange24h) <= 90
}

export function rankingScore(activity) {
  return Math.log10(activity.volumeUsd + 1) * 5
    + Math.log10(activity.liquidityUsd + 1) * 3
    + Math.log10(activity.transactions + 1) * 2
    - Math.min(Math.abs(activity.priceChange24h) / 30, 3)
}
