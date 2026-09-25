// =====================================================================
// EVM wallet-token discovery service
// =====================================================================
// Frontend wrapper around the /api/ethereum/wallet-tokens and
// /api/robinhood/wallet-tokens endpoints. Returns a normalized list of
// { address, symbol, name, decimals, logoURI, balance, type } objects
// representing every token the connected MetaMask wallet actually
// holds (balance > 0), plus the wallet's native ETH balance.
//
// This is the EVM counterpart to src/services/shieldService.js →
// getAllTokenAccounts() on Solana. Same shape, so the swap picker can
// render a "YOUR WALLET" section identically across all three networks.
// =====================================================================

const ETHEREUM_CHAIN_ID = 1
const ROBINHOOD_CHAIN_ID = 4663

function formatAmount(rawBalance, decimals, maxFraction = 6) {
  const amount = BigInt(rawBalance)
  const scale = 10n ** BigInt(decimals)
  const whole = amount / scale
  const fraction = amount % scale
  const fractionString = fraction.toString().padStart(Number(decimals), '0').slice(0, maxFraction)
  const trimmed = fractionString.replace(/0+$/, '')
  const value = trimmed ? Number(`${whole.toString()}.${trimmed}`) : Number(whole.toString())
  return Number.isFinite(value) ? value : 0
}

function normalizeResponse(body, chainKey, chainId) {
  if (!body || !body.success) return { tokens: [], native: null, warning: body?.warning || null, source: body?.source || null }
  const tokens = (body.tokens || []).map((token) => ({
    chainId,
    chainKey,
    type: 'erc20',
    address: String(token.address || '').toLowerCase(),
    symbol: token.symbol || 'UNKNOWN',
    name: token.name || token.symbol || 'Wallet Token',
    decimals: Number(token.decimals || 18),
    logoURI: token.logoURI || null,
    amount: formatAmount(token.balance, token.decimals || 18),
    rawBalance: token.balance,
    source: token.source || body.source || 'unknown',
  }))
  const native = body.native ? {
    chainId,
    chainKey,
    type: 'native',
    address: null,
    symbol: body.native.symbol || 'ETH',
    name: body.native.name || 'Ether',
    decimals: Number(body.native.decimals || 18),
    logoURI: null,
    amount: formatAmount(body.native.balance, body.native.decimals || 18),
    rawBalance: body.native.balance,
    source: body.source || 'unknown',
  } : null
  return { tokens, native, warning: body.warning || null, source: body.source || null }
}

export async function getEthereumWalletTokens(address) {
  if (!address) return { tokens: [], native: null }
  try {
    const response = await fetch(`/api/ethereum/wallet-tokens?address=${encodeURIComponent(address)}`, { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body?.error || 'Ethereum wallet tokens are unavailable.')
    return normalizeResponse(body, 'ethereum', ETHEREUM_CHAIN_ID)
  } catch (error) {
    console.warn('ethereum wallet-tokens fetch failed', error)
    return { tokens: [], native: null, error: error?.message || 'fetch failed' }
  }
}

export async function getRobinhoodWalletTokens(address) {
  if (!address) return { tokens: [], native: null }
  try {
    const response = await fetch(`/api/robinhood/wallet-tokens?address=${encodeURIComponent(address)}`, { cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body?.error || 'Robinhood wallet tokens are unavailable.')
    return normalizeResponse(body, 'robinhood', ROBINHOOD_CHAIN_ID)
  } catch (error) {
    console.warn('robinhood wallet-tokens fetch failed', error)
    return { tokens: [], native: null, error: error?.message || 'fetch failed' }
  }
}

// Convenience: returns native + all ERC-20 tokens merged into a single
// sorted list (largest balance first), matching the shape the existing
// Solana TokenSelector consumes (walletTokens prop).
export async function getEvmWalletTokensForSelector(chainKey, address) {
  if (!address) return []
  const result = chainKey === 'robinhood'
    ? await getRobinhoodWalletTokens(address)
    : await getEthereumWalletTokens(address)
  const merged = []
  if (result.native && result.native.amount > 0) merged.push(result.native)
  for (const token of result.tokens) {
    if (token.amount > 0) merged.push(token)
  }
  merged.sort((a, b) => (b.amount || 0) - (a.amount || 0))
  return merged
}
