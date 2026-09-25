// =====================================================================
// GET /api/robinhood/wallet-tokens?address=0x...
// =====================================================================
// Returns every ERC-20 token the connected MetaMask wallet actually holds
// on Robinhood Chain (chainId 4663) with balance > 0, enriched with
// symbol/name/decimals/logo, plus the wallet's native ETH balance.
//
// This is the Robinhood Chain equivalent of the Solana wallet-token
// discovery pipeline in src/services/shieldService.js → getAllTokenAccounts().
//
// IMPORTANT — why we don't use eth_getLogs:
// The Robinhood Chain public RPC (https://rpc.mainnet.chain.robinhood.com/)
// does NOT index ERC-20 Transfer events under the standard topic
// 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df9089b1c.
// `eth_getLogs` for that topic returns 0 results for any wallet, even
// wallets with extensive transfer history. (Verified live.)
//
// IMPORTANT — why we don't scan LI.FI/Blockscout catalogs via balanceOf:
// Scanning ~1500 candidates against the Robinhood RPC triggers rate
// limits (rate-limit reset window is 60s) and takes 50+ seconds — too
// slow for the 45s polling the frontend uses.
//
// Strategy:
//   PRIMARY: Blockscout /api/v2/addresses/<wallet>/tokens — returns the
//            wallet's actual token holdings in ONE HTTP call (~200ms).
//            This is the same explorer that powers the official Robinhood
//            Chain blockscout UI, and it indexes ALL token balances.
//
//   FALLBACK: If Blockscout is unavailable (5xx / timeout / Cloudflare
//             challenge), use the merged LI.FI + Blockscout token catalogs
//             (~1500+ unique candidates) + batched balanceOf() via the
//             Robinhood RPC. This is slower (50s+) and rate-limited, but
//             works without the explorer.
//
//   NATIVE ETH: Always fetched via lifiRpc(4663, 'eth_getBalance') —
//               works regardless of which path discovered the ERC-20s.
//
// No third-party API key required. Uses the existing Robinhood RPC
// via lifiRpc(4663, ...) for native balance and the on-chain fallback.
// =====================================================================

import { apiError, json, rateLimit } from '../../api/_lib/roninBackend.mjs'
import { lifiRpc, lifiRpcUrl, lifiHeaders, LIFI_BASE_URL } from '../../api/_lib/lifi.mjs'
import { ROBINHOOD_VERIFIED_TOKENS } from '../../src/config/robinhoodRegistry.js'

const ROBINHOOD_CHAIN_ID = 4663
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const BALANCE_OF_SELECTOR = '0x70a08231'
const SYMBOL_SELECTOR = '0x95d89b41'
const NAME_SELECTOR = '0x06fdde03'
const DECIMALS_SELECTOR = '0x313ce567'
const BLOCKSCOUT_BASE = 'https://robinhoodchain.blockscout.com/api/v2'
const BLOCKSCOUT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  Accept: 'application/json',
}

// -------- Catalog fallback constants (only used if Blockscout is down) ---
const MAX_TOKENS_TO_RESOLVE = 100
const BATCH_SIZE = 32
const BLOCKSCOUT_MAX_PAGES = 20
let catalogCache = { at: 0, tokens: [] }
const CATALOG_TTL_MS = 5 * 60_000

// Verified tokens from robinhoodRegistry.js
const VERIFIED_BY_ADDRESS = new Map(
  ROBINHOOD_VERIFIED_TOKENS.map((token) => [String(token.address).toLowerCase(), token]),
)

function decodeString(hex) {
  if (!hex || hex === '0x') return ''
  try {
    const bytes = Uint8Array.from(hex.slice(2).match(/.{1,2}/g).map((byte) => parseInt(byte, 16)))
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\u0000/g, '').trim()
  } catch {
    return ''
  }
}

function hexToBigInt(hex) {
  if (!hex || hex === '0x') return 0n
  try { return BigInt(hex) } catch { return 0n }
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'UNKNOWN'
}

// =====================================================================
// PRIMARY PATH: Blockscout /api/v2/addresses/<wallet>/tokens
// =====================================================================
// Returns all ERC-20 token balances for the wallet in ONE HTTP call.
// The Blockscout explorer indexes all token balances on Robinhood Chain.
// Pagination is via next_page_params (returns null when no more pages).
//
// Response shape (Blockscout v2):
//   {
//     items: [
//       {
//         value: "1234567890",           // raw balance as decimal string
//         token: {
//           address_hash: "0x...",
//           symbol: "USDG",
//           name: "USDG",
//           decimals: "6",
//           ...
//         }
//       },
//       ...
//     ],
//     next_page_params: { ... } | null
//   }
async function fetchWalletTokensViaBlockscout(wallet) {
  const allItems = []
  let url = `${BLOCKSCOUT_BASE}/addresses/${wallet}/tokens`

  // Cap at 10 pages (50 tokens each) = 500 holdings max. No wallet will
  // hold more than this in practice.
  for (let page = 0; page < 10; page++) {
    try {
      const response = await fetch(url, {
        headers: BLOCKSCOUT_HEADERS,
        signal: AbortSignal.timeout(10_000),
      })
      // Cloudflare sometimes returns 403 with a JS challenge page.
      // In that case, fall through to the balanceOf fallback.
      if (response.status === 403) {
        return { ok: false, reason: 'CLOUDFLARE_BLOCKED', items: [] }
      }
      if (!response.ok) {
        return { ok: false, reason: `HTTP_${response.status}`, items: [] }
      }
      const body = await response.json().catch(() => null)
      if (!body || !Array.isArray(body.items)) {
        return { ok: false, reason: 'MALFORMED_RESPONSE', items: [] }
      }
      allItems.push(...body.items)
      if (!body.next_page_params) break
      // Rebuild URL with next_page_params
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(body.next_page_params)) params.set(k, String(v))
      url = `${BLOCKSCOUT_BASE}/addresses/${wallet}/tokens?${params}`
    } catch (error) {
      // Network error / timeout — fall through to the balanceOf fallback.
      return { ok: false, reason: error?.name === 'TimeoutError' ? 'TIMEOUT' : (error?.message || 'NETWORK_ERROR'), items: [] }
    }
  }

  return { ok: true, items: allItems }
}

// Convert Blockscout wallet-tokens response to the normalized shape
// the frontend expects.
function normalizeBlockscoutWalletTokens(items) {
  const tokens = []
  for (const item of items) {
    const tokenAddr = String(item?.token?.address_hash || '').toLowerCase()
    if (!ADDRESS_PATTERN.test(tokenAddr)) continue
    const decimals = Number(item?.token?.decimals) || 18
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) continue
    const balanceRaw = String(item?.value || '0')
    if (!/^\d+$/.test(balanceRaw) || BigInt(balanceRaw) <= 0n) continue
    const symbol = item?.token?.symbol || shortAddress(tokenAddr)
    const name = item?.token?.name || symbol
    const verified = VERIFIED_BY_ADDRESS.get(tokenAddr)
    tokens.push({
      chainId: ROBINHOOD_CHAIN_ID,
      chainKey: 'robinhood',
      type: 'erc20',
      address: tokenAddr,
      symbol,
      name,
      decimals,
      logoURI: verified?.logoURI || item?.token?.icon_url || null,
      balance: balanceRaw,
      source: verified ? 'blockscout+verified-registry' : 'blockscout-explorer',
    })
  }
  return tokens
}

// =====================================================================
// FALLBACK PATH: LI.FI + Blockscout catalog + batched balanceOf
// =====================================================================
// Used only if the Blockscout /addresses/<wallet>/tokens endpoint fails
// (Cloudflare block, timeout, 5xx). Slower (~50s for 1500 candidates)
// and rate-limited by the Robinhood RPC.

async function fetchLifiCatalog() {
  try {
    const response = await fetch(`${LIFI_BASE_URL}/tokens?chains=${ROBINHOOD_CHAIN_ID}`, {
      headers: lifiHeaders({ Accept: 'application/json' }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return []
    const body = await response.json().catch(() => null)
    const tokens = Array.isArray(body?.tokens?.[String(ROBINHOOD_CHAIN_ID)])
      ? body.tokens[String(ROBINHOOD_CHAIN_ID)]
      : Array.isArray(body?.tokens?.[ROBINHOOD_CHAIN_ID])
        ? body.tokens[ROBINHOOD_CHAIN_ID]
        : []
    return tokens.filter((token) => ADDRESS_PATTERN.test(String(token?.address || '')))
  } catch {
    return []
  }
}

async function fetchBlockscoutCatalog() {
  const allTokens = []
  let url = `${BLOCKSCOUT_BASE}/tokens`
  let page = 0

  while (url && page < BLOCKSCOUT_MAX_PAGES) {
    try {
      const response = await fetch(url, { headers: BLOCKSCOUT_HEADERS, signal: AbortSignal.timeout(15_000) })
      if (!response.ok) break
      const body = await response.json().catch(() => null)
      const items = Array.isArray(body?.items) ? body.items : []
      if (items.length === 0) break
      allTokens.push(...items)
      page++
      if (body?.next_page_params) {
        const params = new URLSearchParams()
        for (const [k, v] of Object.entries(body.next_page_params)) params.set(k, String(v))
        url = `${BLOCKSCOUT_BASE}/tokens?${params}`
      } else {
        url = null
      }
    } catch {
      break
    }
  }

  return allTokens.filter((t) => {
    const addr = String(t?.address_hash || '')
    return ADDRESS_PATTERN.test(addr) && t?.decimals != null && Number(t.decimals) > 0
  })
}

async function getCandidateCatalog() {
  if (Date.now() - catalogCache.at < CATALOG_TTL_MS && catalogCache.tokens.length > 0) {
    return catalogCache.tokens
  }
  const [lifiTokens, blockscoutTokens] = await Promise.all([fetchLifiCatalog(), fetchBlockscoutCatalog()])
  const merged = new Map()
  for (const t of lifiTokens) {
    const addr = String(t.address).toLowerCase()
    if (!merged.has(addr)) merged.set(addr, { address: addr, symbol: t.symbol, name: t.name, decimals: Number(t.decimals) || 18, source: 'lifi' })
  }
  for (const t of blockscoutTokens) {
    const addr = String(t.address_hash).toLowerCase()
    if (!merged.has(addr)) merged.set(addr, { address: addr, symbol: t.symbol || null, name: t.name || null, decimals: Number(t.decimals) || 18, source: 'blockscout' })
  }
  for (const t of ROBINHOOD_VERIFIED_TOKENS) {
    const addr = String(t.address).toLowerCase()
    if (!merged.has(addr)) merged.set(addr, { address: addr, symbol: t.symbol, name: t.name, decimals: Number(t.decimals) || 18, source: 'verified-registry' })
  }
  const result = Array.from(merged.values())
  catalogCache = { at: Date.now(), tokens: result }
  return result
}

async function batchBalanceOf(chainId, tokenAddresses, owner) {
  const ownerPadded = owner.slice(2).padStart(64, '0')
  const batchPayload = tokenAddresses.map((addr, index) => ({
    jsonrpc: '2.0',
    id: index,
    method: 'eth_call',
    params: [{ to: addr, data: `${BALANCE_OF_SELECTOR}${ownerPadded}` }, 'latest'],
  }))
  const rpcUrl = lifiRpcUrl(chainId)
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchPayload),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.json()
    if (Array.isArray(body)) {
      const resultsById = new Map(body.map((r) => [r.id, r]))
      return tokenAddresses.map((_, index) => {
        const result = resultsById.get(index)
        if (result?.error) return 0n
        return hexToBigInt(result?.result)
      })
    }
  } catch {}
  // Sequential fallback
  const balances = []
  for (const addr of tokenAddresses) {
    try {
      const result = await lifiRpc(chainId, 'eth_call', [{ to: addr, data: `${BALANCE_OF_SELECTOR}${ownerPadded}` }, 'latest'])
      balances.push(hexToBigInt(result))
    } catch {
      balances.push(0n)
    }
  }
  return balances
}

function chunkBatch(arr, size) {
  if (size <= 0) return [arr]
  const chunks = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}

// =====================================================================
// Handler
// =====================================================================
export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'robinhood-wallet-tokens', 30, 60_000)) return apiError(res, 429, 'RATE_LIMITED', 'Too many wallet-token requests. Try again shortly.')

  const address = String(req.query?.address || '').trim()
  if (!ADDRESS_PATTERN.test(address)) return apiError(res, 400, 'INVALID_ADDRESS', 'A valid Robinhood Chain wallet address is required.')

  const rpcUrl = lifiRpcUrl(ROBINHOOD_CHAIN_ID)
  if (!rpcUrl) return apiError(res, 503, 'RPC_NOT_CONFIGURED', 'Robinhood Chain RPC is not configured.')

  try {
    // Always fetch native ETH balance via the Robinhood RPC (works on any path)
    const nativeHexPromise = lifiRpc(ROBINHOOD_CHAIN_ID, 'eth_getBalance', [address, 'latest'])

    // PRIMARY PATH: Blockscout /addresses/<wallet>/tokens
    // Returns ALL wallet holdings in 1-2 HTTP calls (~200ms typical).
    const blockscoutResult = await fetchWalletTokensViaBlockscout(address)
    const nativeHex = await nativeHexPromise

    if (blockscoutResult.ok) {
      const tokens = normalizeBlockscoutWalletTokens(blockscoutResult.items)
      return json(res, 200, {
        success: true,
        chainId: ROBINHOOD_CHAIN_ID,
        chainKey: 'robinhood',
        source: 'blockscout-explorer',
        note: 'Wallet token discovery via Blockscout /api/v2/addresses/<wallet>/tokens. Returns ALL ERC-20 holdings in 1-2 HTTP calls.',
        native: { balance: hexToBigInt(nativeHex).toString(), decimals: 18, symbol: 'ETH', name: 'Ether' },
        tokens,
        dataAvailable: true,
        generatedAt: new Date().toISOString(),
      })
    }

    // FALLBACK PATH: catalog + batched balanceOf via the Robinhood RPC
    // Slower (~50s for 1500 candidates) and rate-limited, but works
    // without the explorer.
    console.warn('Blockscout wallet-tokens endpoint failed:', blockscoutResult.reason, '— falling back to catalog + balanceOf scan')
    const candidates = await getCandidateCatalog()

    const balanceBatches = await Promise.all(
      chunkBatch(candidates, BATCH_SIZE).map((batch) =>
        batchBalanceOf(ROBINHOOD_CHAIN_ID, batch.map((t) => t.address), address),
      ),
    )
    const allBalances = balanceBatches.flat()

    const heldTokens = []
    for (let i = 0; i < candidates.length; i++) {
      const balance = allBalances[i] ?? 0n
      if (balance > 0n) heldTokens.push({ candidate: candidates[i], balance })
    }
    const resolved = heldTokens.slice(0, MAX_TOKENS_TO_RESOLVE)

    const tokens = await Promise.all(resolved.map(async ({ candidate, balance }) => {
      const addressLower = String(candidate.address).toLowerCase()
      const verified = VERIFIED_BY_ADDRESS.get(addressLower)
      const symbol = candidate.symbol || (verified?.symbol) || shortAddress(addressLower)
      return {
        chainId: ROBINHOOD_CHAIN_ID,
        chainKey: 'robinhood',
        type: 'erc20',
        address: addressLower,
        symbol,
        name: candidate.name || symbol,
        decimals: Number(candidate.decimals) || 18,
        logoURI: verified?.logoURI || candidate.logoURI || null,
        balance: balance.toString(),
        source: candidate.source || (verified ? 'verified-registry' : 'on-chain-fallback'),
      }
    }))

    return json(res, 200, {
      success: true,
      chainId: ROBINHOOD_CHAIN_ID,
      chainKey: 'robinhood',
      source: 'catalog-balance-of-fallback',
      note: `Blockscout explorer was unavailable (${blockscoutResult.reason}); fell back to merged LI.FI + Blockscout catalog (~${candidates.length} candidates) + batched balanceOf.`,
      catalogSize: candidates.length,
      native: { balance: hexToBigInt(nativeHex).toString(), decimals: 18, symbol: 'ETH', name: 'Ether' },
      tokens: tokens.filter(Boolean),
      dataAvailable: true,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('robinhood wallet-tokens failed:', error?.message || error)
    return apiError(res, 502, 'WALLET_TOKENS_UNAVAILABLE', error?.message || 'Robinhood wallet tokens are unavailable right now.')
  }
}
