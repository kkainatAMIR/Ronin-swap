// =====================================================================
// GET /api/token-info/evm?chain=<ethereum|robinhood>&address=<0x...>
// =====================================================================
// Read-only lookup of ERC-20 token metadata by contract address on
// Ethereum Mainnet (chainId=1) or Robinhood Chain (chainId=4663).
// Used by the swap page's "Import this token" row when the user
// pastes a contract address that isn't in the curated catalog AND
// isn't held by their wallet.
//
// Strategy:
//   Use raw eth_call RPC requests (no ethers.js dependency at runtime)
//   to invoke the standard ERC-20 view functions:
//     name()      → selector 0x06fdde03 → returns string OR bytes32
//     symbol()    → selector 0x95d89b41 → returns string OR bytes32
//     decimals()  → selector 0x313ce567 → returns uint8
//
//   The name()/symbol() return value is ABI-decoded in two passes:
//     1. Try string decoding (offset+length+padded UTF-8 bytes)
//     2. Fall back to bytes32 decoding (32 bytes of right-padded ASCII)
//        for older non-compliant tokens (MKR, older USDT, etc.).
//
// RPC endpoint resolution:
//   * Ethereum mainnet: prefer runtimeEnv.ETHEREUM_RPC_URL, fall back
//     to a free public RPC.
//   * Robinhood Chain: prefer runtimeEnv.ROBINHOOD_RPC_URL (or
//     VITE_ROBINHOOD_RPC_URL), fall back to the public Robinhood RPC.
//
// SECURITY:
//   * Validates chain key (only 'ethereum' | 'robinhood' allowed).
//   * Validates EVM address format (0x + 40 hex chars).
//   * Read-only. Does NOT write to the database.
//   * Rate-limited per IP at 30 req/min.
//   * 3 parallel eth_calls (name+symbol+decimals) with 8s total timeout.
//   * In-memory cache (TTL 5 min) so toggling the selector doesn't
//     refetch the same address repeatedly.
//   * Never returns private keys, seeds, or wallet secrets (none are
//     ever requested — this endpoint only fetches PUBLIC on-chain
//     metadata).
//
// Response (200):
//   {
//     address, symbol, name, decimals, logoURI,
//     verified: false,           // always false for eth_call lookup
//     source: 'evm-rpc',
//     chainKey: 'ethereum' | 'robinhood',
//     chainId: 1 | 4663,
//     cached: bool
//   }
//
// Response (400/404/429/502): standard { error, code } shape.
// =====================================================================

import { apiError, json, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'

const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

const ETHEREUM_CHAIN_ID = 1
const ROBINHOOD_CHAIN_ID = 4663
const LOOKUP_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 5 * 60_000

const DEFAULT_ETHEREUM_RPC = 'https://eth.llamarpc.com'
const DEFAULT_ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com/'

const ALLOWED_CHAINS = new Set(['ethereum', 'robinhood'])

// ERC-20 view function selectors (first 4 bytes of keccak256(signature))
const SELECTOR_NAME = '0x06fdde03'
const SELECTOR_SYMBOL = '0x95d89b41'
const SELECTOR_DECIMALS = '0x313ce567'

// In-memory cache. Keyed by `${chainKey}:${addressLower}`. Per-process.
const cache = new Map()

function isValidEvmAddress(value) {
  if (typeof value !== 'string') return false
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim())
}

function resolveRpcUrl(chainKey) {
  if (chainKey === 'ethereum') {
    return runtimeEnv.ETHEREUM_RPC_URL || runtimeEnv.VITE_ETHEREUM_RPC_URL || DEFAULT_ETHEREUM_RPC
  }
  if (chainKey === 'robinhood') {
    return runtimeEnv.ROBINHOOD_RPC_URL || runtimeEnv.VITE_ROBINHOOD_RPC_URL || DEFAULT_ROBINHOOD_RPC
  }
  return null
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

// Send a single eth_call to the ERC-20 contract.
// `data` is the selector (and any encoded args). Returns the raw hex
// result string (e.g. "0x0000...0006") or null on failure.
async function ethCall(rpcUrl, address, selector) {
  const requestBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: address, data: selector }, 'latest'],
  }
  try {
    const response = await fetchWithTimeout(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
    if (!response.ok) return null
    const payload = await response.json().catch(() => null)
    if (!payload || payload.error) return null
    const result = payload.result
    // eth_call on a non-contract address or a contract that doesn't
    // implement the selector returns '0x' or empty.
    if (!result || result === '0x' || result.length < 4) return null
    return result
  } catch {
    return null
  }
}

// Decode a hex string returned by name()/symbol(). The result can be
// either an ABI-encoded string (offset+length+data) or bytes32
// (32 bytes of right-padded ASCII). We try string decoding first,
// fall back to bytes32 if it doesn't look like a valid string.
function decodeStringOrBytes32(hexResult) {
  if (!hexResult || typeof hexResult !== 'string' || !hexResult.startsWith('0x')) {
    return null
  }
  const hex = hexResult.slice(2)
  if (hex.length === 0) return null

  // 32-byte-aligned hex string. Each "word" is 64 hex chars.
  // ABI string encoding:
  //   word 0: offset (always 0x20 for a single string)
  //   word 1: length (hex number)
  //   word 2..: data padded to 32-byte boundary
  if (hex.length >= 128) {
    const offsetHex = hex.slice(0, 64)
    const offset = Number.parseInt(offsetHex, 16)
    if (offset === 32) {
      // Looks like a string. Decode length + data.
      const lengthHex = hex.slice(64, 128)
      const length = Number.parseInt(lengthHex, 16)
      if (length > 0 && length <= hex.length - 128) {
        const dataHex = hex.slice(128, 128 + length * 2)
        try {
          const bytes = Buffer.from(dataHex, 'hex')
          // Reject control chars (other than common whitespace) to filter
          // out garbage from non-compliant contracts.
          const text = bytes.toString('utf8')
          // Trim trailing nulls / whitespace.
          return text.replace(/\u0000+$/, '').trim() || null
        } catch {
          // fall through to bytes32 decoding
        }
      }
    }
  }

  // bytes32 decoding: 32 bytes of right-padded ASCII.
  if (hex.length === 64) {
    try {
      const bytes = Buffer.from(hex, 'hex')
      const text = bytes.toString('utf8').replace(/\u0000+$/, '').trim()
      // Reject if it has any replacement chars (U+FFFD indicates
      // invalid UTF-8 — likely binary garbage from a non-compliant
      // contract) or too many control chars (other than whitespace).
      const hasReplacement = text.includes('\uFFFD')
      const printable = text.split('').filter((c) => c.charCodeAt(0) >= 32 && c !== '\uFFFD').length
      if (text && !hasReplacement && printable === text.length) {
        return text
      }
    } catch {
      // ignore
    }
  }
  return null
}

function decodeUint8(hexResult) {
  if (!hexResult || !hexResult.startsWith('0x')) return null
  const hex = hexResult.slice(2)
  if (hex.length === 0) return null
  const value = Number.parseInt(hex, 16)
  return Number.isFinite(value) && value >= 0 && value <= 255 ? value : null
}

function buildLogoUri(chainKey, address) {
  if (chainKey === 'ethereum') {
    // TrustWallet assets only indexes Ethereum mainnet. Robinhood
    // Chain isn't in their database, so we return null there.
    return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${address}/logo.png`
  }
  return null
}

export async function lookupEvmTokenInfo(chainKey, address) {
  if (!ALLOWED_CHAINS.has(chainKey)) return null
  if (!isValidEvmAddress(address)) return null

  const addressLower = address.toLowerCase()
  const cacheKey = `${chainKey}:${addressLower}`
  const cachedEntry = cache.get(cacheKey)
  if (cachedEntry && Date.now() - cachedEntry.cachedAt < CACHE_TTL_MS) {
    return { ...cachedEntry.payload, cached: true }
  }

  const rpcUrl = resolveRpcUrl(chainKey)
  if (!rpcUrl) return null

  // Fire all 3 eth_calls in parallel.
  const [nameResult, symbolResult, decimalsResult] = await Promise.all([
    ethCall(rpcUrl, addressLower, SELECTOR_NAME),
    ethCall(rpcUrl, addressLower, SELECTOR_SYMBOL),
    ethCall(rpcUrl, addressLower, SELECTOR_DECIMALS),
  ])

  const name = decodeStringOrBytes32(nameResult) || 'Unknown Token'
  const symbol = decodeStringOrBytes32(symbolResult) || 'UNKNOWN'
  const decimals = decodeUint8(decimalsResult)
  if (decimals == null) {
    // If decimals() failed, the address is either not a contract or
    // not an ERC-20. Treat as "not found" so the UI shows an error.
    return null
  }

  const payload = {
    address: addressLower,
    symbol,
    name,
    decimals,
    logoURI: buildLogoUri(chainKey, addressLower),
    verified: false,
    source: 'evm-rpc',
    chainKey,
    chainId: chainKey === 'ethereum' ? ETHEREUM_CHAIN_ID : ROBINHOOD_CHAIN_ID,
    cached: false,
  }
  cache.set(cacheKey, { payload, cachedAt: Date.now() })
  return payload
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!(await rateLimitPersistent(req, 'token_info_evm', 30, 60_000))) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many token lookups. Try again shortly.')
  }

  const chain = String(req.query?.chain || '').trim().toLowerCase()
  if (!ALLOWED_CHAINS.has(chain)) {
    return apiError(res, 400, 'INVALID_CHAIN', 'chain must be either "ethereum" or "robinhood".')
  }

  const address = String(req.query?.address || '').trim()
  if (!isValidEvmAddress(address)) {
    return apiError(res, 400, 'INVALID_ADDRESS', 'A valid EVM address (0x + 40 hex chars) is required.')
  }

  try {
    const result = await lookupEvmTokenInfo(chain, address)
    if (!result) {
      return apiError(res, 404, 'TOKEN_NOT_FOUND', 'No ERC-20 token metadata found at this address. Verify the contract address and try again.')
    }
    return json(res, 200, { success: true, ...result })
  } catch (error) {
    console.error('token-info/evm failed:', error?.message || error)
    return apiError(res, 502, 'TOKEN_LOOKUP_FAILED', 'Could not fetch EVM token metadata. Try again shortly.')
  }
}
