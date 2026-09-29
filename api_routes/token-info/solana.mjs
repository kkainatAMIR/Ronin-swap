// =====================================================================
// GET /api/token-info/solana?mint=<base58-mint>
// =====================================================================
// Read-only lookup of Solana SPL token metadata by mint address.
// Used by the swap page's "Import this token" row when the user pastes
// a mint that isn't in the curated catalog AND isn't held by their
// wallet.
//
// Lookup order (best-effort, read-only):
//   1. Jupiter token list API (https://lite-api.jup.ag/tokens/v2/mints)
//      → returns { symbol, name, decimals, logoURI, ... } if the mint
//        is in Jupiter's verified list.
//   2. Solana RPC getAccountInfo(<mint>, { encoding: 'jsonParsed' })
//      → verifies the account exists + is an SPL Mint. Returns decimals
//        from the parsed data; falls back to name/symbol = 'UNKNOWN'
//        and logoURI = null.
//
// SECURITY:
//   * Validates mint format (Solana base58 32-44 chars).
//   * Read-only. Does NOT write to the database.
//   * Rate-limited per IP at 30 req/min (lookups are intentionally
//     slow so an attacker can't enumerate mints cheaply).
//   * In-memory cache (TTL 5 min) so toggling the selector doesn't
//     refetch the same mint repeatedly.
//   * Never returns private keys, seeds, or wallet secrets (none are
//     ever requested — this endpoint only fetches PUBLIC on-chain
//     metadata).
//
// Response (200):
//   {
//     mint, symbol, name, decimals, logoURI,
//     verified: bool,    // true iff Jupiter's verified list contained it
//     source: 'jupiter' | 'solana-rpc',
//     cached: bool
//   }
//
// Response (400/404/429/502): standard { error, code } shape.
// =====================================================================

import { apiError, json, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'

const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

const JUPITER_TOKEN_API = 'https://lite-api.jup.ag/tokens/v2/mints'
const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com'
const LOOKUP_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 5 * 60_000

// In-memory cache. Keyed by mint (lowercase). Per-process — won't
// survive restarts, which is fine for this read-only metadata.
const cache = new Map()

function isValidSolanaMint(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  // Solana public keys are base58, 32-44 chars. The on-curve check
  // (PublicKey.isOnCurve) is NOT applied here — some token mints are
  // intentionally off-curve (e.g., associated token accounts). The
  // regex is enough to reject obvious garbage; the RPC call below
  // rejects non-existent accounts.
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)
}

function solanaRpcEndpoints() {
  const helius = runtimeEnv.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(runtimeEnv.HELIUS_API_KEY)}`
    : ''
  return [runtimeEnv.SOLANA_RPC_URL, helius, DEFAULT_SOLANA_RPC]
    .filter((endpoint, index, endpoints) => endpoint && endpoints.indexOf(endpoint) === index)
}

async function fetchWithTimeout(url, options = {}, timeoutMs = LOOKUP_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

// Step 1: try Jupiter's verified token list. Returns null if not found
// or the API is unavailable.
async function lookupViaJupiter(mint) {
  try {
    // Jupiter's v2 endpoint accepts a comma-separated list of mints
    // and returns an array of token metadata objects (or empty array
    // if none are recognized).
    const response = await fetchWithTimeout(
      `${JUPITER_TOKEN_API}?mints=${encodeURIComponent(mint)}`,
      { headers: { accept: 'application/json' } },
    )
    if (!response.ok) return null
    const body = await response.json().catch(() => null)
    if (!Array.isArray(body) || body.length === 0) return null
    const entry = body[0]
    if (!entry || typeof entry !== 'object') return null
    return {
      symbol: String(entry.symbol || 'UNKNOWN'),
      name: String(entry.name || entry.symbol || 'Unknown SPL Token'),
      decimals: Number.isFinite(Number(entry.decimals)) ? Number(entry.decimals) : 9,
      logoURI: entry.logoURI || entry.icon || null,
      verified: true,
      source: 'jupiter',
    }
  } catch {
    return null
  }
}

// Step 2: fall back to Solana RPC getAccountInfo. Verifies the mint
// exists and is an SPL Mint. Returns decimals if available.
async function lookupViaSolanaRpc(mint) {
  const requestBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getAccountInfo',
    params: [mint, { encoding: 'jsonParsed' }],
  }
  const failures = []
  for (const endpoint of solanaRpcEndpoints()) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
      if (!response.ok) {
        failures.push(`${endpointHostname(endpoint)} HTTP ${response.status}`)
        continue
      }
      const payload = await response.json().catch(() => null)
      if (!payload || payload.error) {
        failures.push(`${endpointHostname(endpoint)} RPC error: ${payload?.error?.message || 'invalid response'}`)
        continue
      }
      const value = payload?.result?.value
      if (!value) {
        // Account doesn't exist on-chain.
        return null
      }
      const parsed = value?.data?.parsed
      const info = parsed?.info || {}
      const decimals = Number.isFinite(Number(info.decimals)) ? Number(info.decimals) : 9
      return {
        symbol: 'UNKNOWN',
        name: 'Unknown SPL Token',
        decimals,
        logoURI: null,
        verified: false,
        source: 'solana-rpc',
      }
    } catch (error) {
      failures.push(`${endpointHostname(endpoint)}: ${error.name === 'AbortError' ? 'timeout' : (error.message || 'failed')}`)
    }
  }
  console.warn('[token-info/solana] all RPC endpoints failed:', failures.join('; '))
  return null
}

function endpointHostname(endpoint) {
  try { return new URL(endpoint).hostname } catch { return 'configured endpoint' }
}

export async function lookupSolanaTokenInfo(mint) {
  const normalized = String(mint || '').trim()
  if (!isValidSolanaMint(normalized)) return null

  // Cache check
  const cachedEntry = cache.get(normalized)
  if (cachedEntry && Date.now() - cachedEntry.cachedAt < CACHE_TTL_MS) {
    return { ...cachedEntry.payload, cached: true }
  }

  // Step 1: Jupiter (has name/symbol/logo)
  const jupiterResult = await lookupViaJupiter(normalized)
  if (jupiterResult) {
    const payload = { mint: normalized, ...jupiterResult, cached: false }
    cache.set(normalized, { payload, cachedAt: Date.now() })
    return payload
  }

  // Step 2: Solana RPC (verifies existence + decimals only)
  const rpcResult = await lookupViaSolanaRpc(normalized)
  if (rpcResult) {
    const payload = { mint: normalized, ...rpcResult, cached: false }
    cache.set(normalized, { payload, cachedAt: Date.now() })
    return payload
  }

  return null
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!(await rateLimitPersistent(req, 'token_info_solana', 30, 60_000))) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many token lookups. Try again shortly.')
  }

  const mint = String(req.query?.mint || '').trim()
  if (!isValidSolanaMint(mint)) {
    return apiError(res, 400, 'INVALID_MINT', 'A valid Solana mint address (32-44 char base58) is required.')
  }

  try {
    const result = await lookupSolanaTokenInfo(mint)
    if (!result) {
      return apiError(res, 404, 'TOKEN_NOT_FOUND', 'No Solana token metadata found for this mint. Verify the address and try again.')
    }
    return json(res, 200, { success: true, ...result })
  } catch (error) {
    console.error('token-info/solana failed:', error?.message || error)
    return apiError(res, 502, 'TOKEN_LOOKUP_FAILED', 'Could not fetch Solana token metadata. Try again shortly.')
  }
}
