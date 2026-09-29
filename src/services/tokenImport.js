// =====================================================================
// Token Import Service (frontend client)
// =====================================================================
// Frontend wrapper around the /api/token-info/* endpoints. Used by the
// swap page's "Import this token" row when the user pastes a token
// mint/contract address that isn't in the curated catalog AND isn't
// held by their wallet.
//
// The frontend NEVER invents token metadata — it always asks the
// backend to look it up via Solana RPC (getAccountInfo) or Jupiter's
// verified token list (for Solana) or raw eth_call (for ERC-20s on
// Ethereum / Robinhood Chain).
//
// In-memory cache (per-page-load, NOT persisted to localStorage) so
// toggling the token selector doesn't refetch the same address
// repeatedly.
//
// SECURITY:
//   * The frontend never trusts a user-supplied symbol/name/decimals —
//     those always come from the backend's RPC lookup.
//   * Imported tokens are tagged `trust: 'custom'` so the existing
//     isWalletImpersonation() check (extended to also check 'custom')
//     can flag a scam token that uses a curated symbol but a different
//     mint/address.
//   * Public addresses only — no private keys, seeds, or wallet
//     secrets are ever sent.
// =====================================================================

const CACHE_TTL_MS = 5 * 60_000  // mirror backend cache
const solanaCache = new Map()    // key: mint (lowercase)
const evmCache = new Map()       // key: `${chainKey}:${addressLower}`

const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

// Is this query string shaped like a Solana mint?
// Used by the UI to decide whether to show the "Import this token" row.
export function looksLikeSolanaMint(query) {
  if (typeof query !== 'string') return false
  const trimmed = query.trim()
  return SOLANA_MINT_RE.test(trimmed)
}

// Is this query string shaped like an EVM contract address?
export function looksLikeEvmAddress(query) {
  if (typeof query !== 'string') return false
  const trimmed = query.trim()
  return EVM_ADDRESS_RE.test(trimmed)
}

// Fetch Solana token metadata by mint.
// Returns a normalized token object the existing Solana TokenSelector
// can render (mint, symbol, name, decimals, logoURI, trust, source)
// or null if the backend couldn't find it.
export async function importSolanaTokenByMint(mint) {
  if (!looksLikeSolanaMint(mint)) return null
  const normalized = mint.trim()

  const cached = solanaCache.get(normalized)
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.payload
  }

  try {
    const response = await fetch(
      `/api/token-info/solana?mint=${encodeURIComponent(normalized)}`,
      { cache: 'no-store' },
    )
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const err = new Error(body?.error || 'Token not found at this address.')
      err.code = body?.code || 'TOKEN_LOOKUP_FAILED'
      err.status = response.status
      throw err
    }
    const payload = {
      // Map the backend response to the existing Solana token shape.
      // `mint` is the canonical key the Solana TokenSelector uses;
      // the existing render code reads `token.mint`, `token.symbol`,
      // `token.name`, `token.decimals`, `token.logoURI`, `token.trust`.
      mint: normalized,
      symbol: body.symbol || 'UNKNOWN',
      name: body.name || 'Unknown SPL Token',
      decimals: Number.isFinite(Number(body.decimals)) ? Number(body.decimals) : 9,
      logoURI: body.logoURI || null,
      trust: 'custom',
      // 'verified' (from Jupiter's list) controls whether we show a
      // green check mark; 'source' is just a diagnostic string.
      verified: Boolean(body.verified),
      source: body.source || 'solana-rpc',
      // Security flag set by the existing isWalletImpersonation() check
      // AFTER the token is added to the selector's token list. We do NOT
      // pre-set it here — the impersonation check runs against the
      // curated TRUSTED_TOKENS list and needs the token in the
      // selectorTokens list to be evaluated.
    }
    solanaCache.set(normalized, { payload, cachedAt: Date.now() })
    return payload
  } catch (error) {
    if (error?.code) throw error  // preserve our structured error
    const wrapped = new Error(error?.message || 'Could not fetch Solana token metadata.')
    wrapped.code = 'TOKEN_LOOKUP_FAILED'
    throw wrapped
  }
}

// Fetch ERC-20 metadata by contract address on Ethereum or Robinhood Chain.
// Returns a normalized token object the existing EthereumTokenSelector /
// RobinhoodTokenSelector can render (address, symbol, name, decimals,
// logoURI, type, chainId, trust, source) or null.
export async function importEvmTokenByAddress(chainKey, address) {
  if (chainKey !== 'ethereum' && chainKey !== 'robinhood') return null
  if (!looksLikeEvmAddress(address)) return null
  const addressLower = address.trim().toLowerCase()
  const cacheKey = `${chainKey}:${addressLower}`

  const cached = evmCache.get(cacheKey)
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.payload
  }

  try {
    const response = await fetch(
      `/api/token-info/evm?chain=${encodeURIComponent(chainKey)}&address=${encodeURIComponent(addressLower)}`,
      { cache: 'no-store' },
    )
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const err = new Error(body?.error || 'Token not found at this address.')
      err.code = body?.code || 'TOKEN_LOOKUP_FAILED'
      err.status = response.status
      throw err
    }
    const payload = {
      // Map the backend response to the existing EVM token shape.
      // EVM TokenSelector reads `token.address`, `token.symbol`,
      // `token.name`, `token.decimals`, `token.logoURI`,
      // `token.type` ('erc20' | 'native'), `token.chainId`, `token.trust`.
      address: addressLower,
      symbol: body.symbol || 'UNKNOWN',
      name: body.name || 'Unknown Token',
      decimals: Number.isFinite(Number(body.decimals)) ? Number(body.decimals) : 18,
      logoURI: body.logoURI || null,
      type: 'erc20',
      chainId: Number(body.chainId) || (chainKey === 'ethereum' ? 1 : 4663),
      trust: 'custom',
      verified: Boolean(body.verified),
      source: body.source || 'evm-rpc',
      // walletBalance defaults to 0 — the existing selector renders it
      // with the balance display logic; an imported token the user
      // doesn't hold will just show 0 (no "YOUR WALLET" section entry).
      walletBalance: 0,
      featured: false,
    }
    evmCache.set(cacheKey, { payload, cachedAt: Date.now() })
    return payload
  } catch (error) {
    if (error?.code) throw error
    const wrapped = new Error(error?.message || 'Could not fetch EVM token metadata.')
    wrapped.code = 'TOKEN_LOOKUP_FAILED'
    throw wrapped
  }
}

// Clear both caches. Useful when the user starts a new swap pair or
// navigates away from the swap page (saves memory).
export function clearTokenImportCache() {
  solanaCache.clear()
  evmCache.clear()
}
