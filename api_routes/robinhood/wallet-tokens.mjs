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
// wallets with extensive transfer history. This was the original
// implementation and it silently returned no tokens.
//
// Instead, we use the LI.FI token catalog (https://li.quest/v1/tokens?chains=4663)
// as the candidate list — ~316 known Robinhood Chain tokens — and
// `balanceOf()` each one against the wallet in parallel batches. Any
// token with balance > 0 is included. This works for arbitrary wallet-
// held tokens, not just our curated registry, because LI.FI's catalog
// is comprehensive (it includes tokens we don't have in our registry).
//
// No third-party API key required. Uses the existing LI.FI base URL
// already configured in api/_lib/lifi.mjs, and the existing Robinhood
// RPC via lifiRpc(4663, ...).
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
// Cap the number of tokens we resolve metadata for, to keep response
// time bounded even for wallets holding many tokens.
const MAX_TOKENS_TO_RESOLVE = 80
// Batch size for parallel eth_call — keeps the RPC happy without
// overwhelming it.
const BATCH_SIZE = 16

// 5-minute cache of the LI.FI token catalog for chain 4663.
let catalogCache = { at: 0, tokens: [] }
const CATALOG_TTL_MS = 5 * 60_000

// Verified tokens from robinhoodRegistry.js — used to skip expensive
// metadata eth_call round-trips for tokens we already know.
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

// -------- LI.FI token catalog (cached) -------------------------------
// Fetches all known Robinhood Chain tokens from LI.FI. This is the
// candidate list we balanceOf() against. LI.FI's catalog includes
// tokens NOT in our curated registry, so wallet-held tokens we don't
// track will still be discovered.
//
// LI.FI catalog entries look like:
//   { address, symbol, name, decimals, chainId, logoURI? }
async function getRobinhoodCatalog() {
  if (Date.now() - catalogCache.at < CATALOG_TTL_MS && catalogCache.tokens.length > 0) {
    return catalogCache.tokens
  }
  try {
    const response = await fetch(`${LIFI_BASE_URL}/tokens?chains=${ROBINHOOD_CHAIN_ID}`, {
      headers: lifiHeaders({ Accept: 'application/json' }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return catalogCache.tokens
    const body = await response.json().catch(() => null)
    const tokens = Array.isArray(body?.tokens?.[String(ROBINHOOD_CHAIN_ID)])
      ? body.tokens[String(ROBINHOOD_CHAIN_ID)]
      : Array.isArray(body?.tokens?.[ROBINHOOD_CHAIN_ID])
        ? body.tokens[ROBINHOOD_CHAIN_ID]
        : []
    const cleaned = tokens.filter((token) => ADDRESS_PATTERN.test(String(token?.address || '')))
    catalogCache = { at: Date.now(), tokens: cleaned }
    return cleaned
  } catch {
    // On failure (LI.FI down, timeout, etc.) return the cached list if
    // we have one, otherwise fall back to just the verified registry.
    if (catalogCache.tokens.length > 0) return catalogCache.tokens
    return ROBINHOOD_VERIFIED_TOKENS.map((t) => ({ address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, chainId: ROBINHOOD_CHAIN_ID }))
  }
}

// -------- Batched balanceOf via JSON-RPC -----------------------------
// Solana's RPC supports batched JSON-RPC (multiple methods in one
// HTTP request). Robinhood RPC also supports this — we use it to
// fetch 16 balances in one round-trip instead of 16 sequential calls.
//
// Falls back to sequential eth_call if the batch endpoint isn't supported.
async function batchBalanceOf(chainId, tokenAddresses, owner) {
  const ownerPadded = owner.slice(2).padStart(64, '0')

  // Try batched JSON-RPC first (single HTTP request, multiple methods)
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
      // Batch succeeded — sort results by id to maintain order
      const resultsById = new Map(body.map((r) => [r.id, r]))
      return tokenAddresses.map((_, index) => {
        const result = resultsById.get(index)
        if (result?.error) return 0n
        return hexToBigInt(result?.result)
      })
    }
    // Some RPCs return a single object instead of an array when batching
    // is unsupported. Fall back to sequential.
  } catch {
    // Network error — fall back to sequential.
  }

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

// -------- Fetch metadata for tokens with balance > 0 ----------------
// For tokens in our verified registry, use cached metadata.
// For unknown tokens, fetch symbol/name/decimals via eth_call.
async function fetchTokenMetadata(chainId, address) {
  const verified = VERIFIED_BY_ADDRESS.get(address)
  if (verified) {
    return {
      symbol: verified.symbol,
      name: verified.name,
      decimals: Number(verified.decimals || 18),
      logoURI: verified.logoURI || null,
    }
  }
  const [symbolHex, nameHex, decimalsHex] = await Promise.all([
    lifiRpc(chainId, 'eth_call', [{ to: address, data: SYMBOL_SELECTOR }, 'latest']).catch(() => '0x'),
    lifiRpc(chainId, 'eth_call', [{ to: address, data: NAME_SELECTOR }, 'latest']).catch(() => '0x'),
    lifiRpc(chainId, 'eth_call', [{ to: address, data: DECIMALS_SELECTOR }, 'latest']).catch(() => '0x'),
  ])
  const decimals = Number.parseInt(decimalsHex || '0x0', 16)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null
  const symbol = decodeString(symbolHex) || shortAddress(address)
  const name = decodeString(nameHex) || symbol
  return { symbol, name, decimals, logoURI: null }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'robinhood-wallet-tokens', 30, 60_000)) return apiError(res, 429, 'RATE_LIMITED', 'Too many wallet-token requests. Try again shortly.')

  const address = String(req.query?.address || '').trim()
  if (!ADDRESS_PATTERN.test(address)) return apiError(res, 400, 'INVALID_ADDRESS', 'A valid Robinhood Chain wallet address is required.')

  const rpcUrl = lifiRpcUrl(ROBINHOOD_CHAIN_ID)
  if (!rpcUrl) return apiError(res, 503, 'RPC_NOT_CONFIGURED', 'Robinhood Chain RPC is not configured.')

  try {
    // 1. Fetch LI.FI token catalog (cached for 5 min) — this is the
    //    candidate list of ~316 known Robinhood Chain tokens.
    const catalog = await getRobinhoodCatalog()

    // Always include verified registry tokens too (in case LI.FI catalog
    // is missing any). Dedupe by lowercase address.
    const candidateMap = new Map()
    for (const t of catalog) candidateMap.set(String(t.address).toLowerCase(), t)
    for (const t of ROBINHOOD_VERIFIED_TOKENS) {
      const key = String(t.address).toLowerCase()
      if (!candidateMap.has(key)) candidateMap.set(key, { address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, chainId: ROBINHOOD_CHAIN_ID })
    }
    const candidates = Array.from(candidateMap.values())

    // 2. Native ETH balance + batched balanceOf for all candidates, in parallel.
    const [nativeHex, ...balanceBatches] = await Promise.all([
      lifiRpc(ROBINHOOD_CHAIN_ID, 'eth_getBalance', [address, 'latest']),
      // Run balanceOf in batches of BATCH_SIZE to keep the RPC happy.
      ...chunkBatch(candidates, BATCH_SIZE).map((batch) =>
        batchBalanceOf(ROBINHOOD_CHAIN_ID, batch.map((t) => t.address), address),
      ),
    ])

    // Flatten the balance batches back into a single array aligned with candidates
    const allBalances = balanceBatches.flat()

    // 3. Filter to tokens with balance > 0
    const heldTokens = []
    for (let i = 0; i < candidates.length; i++) {
      const balance = allBalances[i] ?? 0n
      if (balance > 0n) {
        heldTokens.push({ candidate: candidates[i], balance })
      }
    }

    // Cap the number we resolve metadata for (defensive — wallets
    // rarely hold more than 80 distinct tokens)
    const resolved = heldTokens.slice(0, MAX_TOKENS_TO_RESOLVE)

    // 4. Fetch metadata for each held token in parallel
    const tokens = await Promise.all(resolved.map(async ({ candidate, balance }) => {
      const addressLower = String(candidate.address).toLowerCase()
      try {
        const meta = await fetchTokenMetadata(ROBINHOOD_CHAIN_ID, addressLower)
        if (!meta) return null
        return {
          chainId: ROBINHOOD_CHAIN_ID,
          chainKey: 'robinhood',
          type: 'erc20',
          address: addressLower,
          symbol: meta.symbol || candidate.symbol || 'UNKNOWN',
          name: meta.name || candidate.name || meta.symbol || 'Wallet Token',
          decimals: meta.decimals || Number(candidate.decimals) || 18,
          logoURI: meta.logoURI || candidate.logoURI || null,
          balance: balance.toString(),
          source: VERIFIED_BY_ADDRESS.has(addressLower) ? 'verified-registry' : 'lifi-catalog',
        }
      } catch {
        return null
      }
    }))

    return json(res, 200, {
      success: true,
      chainId: ROBINHOOD_CHAIN_ID,
      chainKey: 'robinhood',
      source: 'lifi-catalog-balance-of',
      note: 'Robinhood Chain RPC does not index ERC-20 Transfer events under eth_getLogs; wallet token discovery uses the LI.FI token catalog (~316 known Robinhood tokens) + balanceOf() instead.',
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

// Helper: split an array into chunks of the given size
function chunkBatch(arr, size) {
  if (size <= 0) return [arr]
  const chunks = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}
