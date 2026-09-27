// RoninSamurai.com — Robinhood Chain token catalog (frontend side).
//
// Robinhood Chain has no manually curated, verified token registry yet, so
// the token list is sourced live from the backend, which in turn trusts
// LI.FI's own token catalog (see api/_lib/lifi.mjs / api/robinhood/tokens.mjs).

export async function getRobinhoodTokenSections() {
  const response = await fetch('/api/robinhood/tokens', { cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || 'Robinhood token list is unavailable.')
  return body
}

export async function getRobinhoodTrending() {
  const response = await fetch('/api/robinhood/trending', { cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || 'Robinhood trending is unavailable.')
  return body
}

// Fetch USD prices for Robinhood Chain tokens. Mirrors the pattern in
// ethereumService.getEthereumTokenPrices but targets DexScreener's
// 'robinhood' chainId instead of 'ethereum'.
//
// Native ETH on Robinhood Chain is the SAME asset as ETH on Ethereum
// mainnet — its USD price is identical. We fetch it from CoinGecko
// (same endpoint as Ethereum uses).
//
// For ERC-20 tokens on Robinhood Chain (chainId 4663), DexScreener
// returns pairs with chainId='robinhood'. We filter for those.
//
// Returns a Map keyed by:
//   'native' (for native ETH)
//   <lowercase-token-address> (for ERC-20 tokens)
//
// Reuses existing public APIs (CoinGecko + DexScreener). No new
// backend endpoint. Falls back to an empty Map on any error — the
// caller (RobinhoodSwapPanel) renders a muted '$0.00 USD' placeholder
// when the price is unavailable.
export async function getRobinhoodTokenPrices(tokens) {
  const prices = new Map()
  // Native ETH price (same asset as Ethereum mainnet ETH)
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
    const body = await response.json()
    const price = Number(body?.ethereum?.usd)
    if (Number.isFinite(price)) prices.set('native', price)
  } catch {}

  // Per-ERC-20 prices from DexScreener (chainId='robinhood')
  await Promise.all(tokens.filter((token) => token.type === 'erc20' && token.address).map(async (token) => {
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.address}`)
      const body = await response.json()
      const pair = body?.pairs?.find((item) => {
        const cid = String(item?.chainId || '').toLowerCase()
        return (cid === 'robinhood' || cid === '4663') && Number.isFinite(Number(item?.priceUsd))
      })
      if (pair) prices.set(String(token.address).toLowerCase(), Number(pair.priceUsd))
    } catch {}
  }))
  return prices
}

