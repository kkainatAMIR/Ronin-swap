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
//   2. Metaplex on-chain metadata via Solana RPC getAccountInfo(<pda>)
//      → fetches the on-chain name/symbol/URI from the Metaplex Token
//        Metadata program, then follows the off-chain URI (typically
//        Arweave) to get the logo URL. Covers ANY SPL token that has
//        Metaplex metadata (essentially all legitimate tokens).
//   3. Solana RPC getAccountInfo(<mint>, { encoding: 'jsonParsed' })
//      → last-resort fallback: verifies the mint exists + returns
//        decimals only. name/symbol/logo are placeholders.
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
//     source: 'jupiter' | 'metaplex' | 'solana-rpc',
//     cached: bool
//   }
//
// Response (400/404/429/502): standard { error, code } shape.
// =====================================================================

import { apiError, json, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import { PublicKey } from '@solana/web3.js'

const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

const JUPITER_TOKEN_API = 'https://lite-api.jup.ag/tokens/v2/mints'
const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com'
const LOOKUP_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 5 * 60_000

// Metaplex Token Metadata program ID (canonical on Solana mainnet).
// Used to derive the deterministic PDA for a mint's metadata.
const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYFfMx6dGk5RnTbDqpfK')

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

// Step 2: fetch Metaplex on-chain metadata. Computes the deterministic
// PDA for the mint's Metaplex Token Metadata account, calls Solana RPC
// getAccountInfo with base64 encoding, and parses the Borsh-serialized
// layout (key + update_authority + mint + name + symbol + uri).
// Optionally follows the off-chain URI to fetch the logo URL.
async function lookupViaMetaplex(mint) {
  try {
    const mintPubkey = new PublicKey(mint)
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      METAPLEX_TOKEN_METADATA_PROGRAM_ID,
    )
    const requestBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [pda.toString(), { encoding: 'base64' }],
    }
    const endpoints = solanaRpcEndpoints()
    for (const endpoint of endpoints) {
      try {
        const response = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        })
        if (!response.ok) continue
        const payload = await response.json().catch(() => null)
        if (!payload || payload.error) continue
        const value = payload?.result?.value
        if (!value || !Array.isArray(value.data) || value.data.length < 1) continue
        const data = Buffer.from(value.data[0], 'base64')
        const parsed = parseMetaplexMetadataAccount(data)
        if (!parsed) continue
        // Optionally follow the off-chain URI to fetch the logo URL.
        // The URI is typically an Arweave URL pointing to a JSON file
        // with { name, symbol, image } fields.
        let logoURI = null
        if (parsed.uri) {
          const offChain = await fetchOffChainMetadata(parsed.uri)
          if (offChain) {
            logoURI = offChain.image || offChain.logoURI || offChain.logo || null
          }
        }
        return {
          symbol: parsed.symbol || 'UNKNOWN',
          name: parsed.name || (parsed.symbol ? `${parsed.symbol} Token` : 'Unknown SPL Token'),
          decimals: 9, // Metaplex metadata doesn't include decimals — fall back to 9 (SPL default)
          logoURI,
          verified: false,
          source: 'metaplex',
        }
      } catch {
        // try next endpoint
        continue
      }
    }
    return null
  } catch {
    return null
  }
}

// Parse the Borsh-serialized Metaplex Token Metadata V1 account data.
//
// Layout:
//   1 byte  : key (4 = MetadataV1)
//   32 bytes: update_authority (PublicKey)
//   32 bytes: mint (PublicKey)
//   4 bytes : name length (LE uint32)
//   N bytes : name (UTF-8, padded to 4-byte boundary)
//   4 bytes : symbol length (LE uint32)
//   N bytes : symbol (UTF-8, padded to 4-byte boundary)
//   4 bytes : uri length (LE uint32)
//   N bytes : uri (UTF-8, padded to 4-byte boundary)
//   ... (other fields we don't need)
function parseMetaplexMetadataAccount(data) {
  try {
    if (!Buffer.isBuffer(data) || data.length < 100) return null
    let offset = 1 + 32 + 32 // skip key + update_authority + mint
    const nameLen = data.readUInt32LE(offset)
    offset += 4
    if (offset + nameLen > data.length) return null
    const name = data.toString('utf8', offset, offset + nameLen).replace(/\u0000+$/, '').trim()
    offset += Math.ceil(nameLen / 4) * 4 // 4-byte boundary padding
    if (offset + 4 > data.length) return null
    const symbolLen = data.readUInt32LE(offset)
    offset += 4
    if (offset + symbolLen > data.length) return null
    const symbol = data.toString('utf8', offset, offset + symbolLen).replace(/\u0000+$/, '').trim()
    offset += Math.ceil(symbolLen / 4) * 4
    if (offset + 4 > data.length) return null
    const uriLen = data.readUInt32LE(offset)
    offset += 4
    if (offset + uriLen > data.length) return null
    const uri = data.toString('utf8', offset, offset + uriLen).replace(/\u0000+$/, '').trim()
    return { name, symbol, uri }
  } catch {
    return null
  }
}

// Follow the off-chain URI (typically Arweave) to fetch the JSON
// metadata that contains the logo/image URL.
async function fetchOffChainMetadata(uri) {
  if (!uri || typeof uri !== 'string') return null
  try {
    const response = await fetchWithTimeout(uri, { headers: { accept: 'application/json' } }, 5_000)
    if (!response.ok) return null
    const body = await response.json().catch(() => null)
    if (!body || typeof body !== 'object') return null
    return {
      name: typeof body.name === 'string' ? body.name : null,
      symbol: typeof body.symbol === 'string' ? body.symbol : null,
      image: typeof body.image === 'string' ? body.image : null,
      logoURI: typeof body.logoURI === 'string' ? body.logoURI : null,
      logo: typeof body.logo === 'string' ? body.logo : null,
    }
  } catch {
    return null
  }
}

// Step 3: fall back to Solana RPC getAccountInfo. Verifies the mint
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

  // Step 2: Metaplex on-chain metadata (has name/symbol; follows URI for logo)
  const metaplexResult = await lookupViaMetaplex(normalized)
  if (metaplexResult) {
    const payload = { mint: normalized, ...metaplexResult, cached: false }
    cache.set(normalized, { payload, cachedAt: Date.now() })
    return payload
  }

  // Step 3: Solana RPC (verifies existence + decimals only)
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
