import { RONIN_MINT } from '../data'

export { RONIN_MINT }
const SOLANA_RPC_PROXY_URL = '/api/solana/rpc'
const CONFIGURED_SOLANA_RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || ''
// Keep provider credentials and retry policy on the server. Public browser
// RPC endpoints frequently reject POST requests with 403 responses.
export const SOLANA_RPC_URL = CONFIGURED_SOLANA_RPC_URL || SOLANA_RPC_PROXY_URL
const SOLANA_RPC_ENDPOINTS = [SOLANA_RPC_PROXY_URL]
// 15s matches shieldService.js and gives the server-side proxy enough
// headroom to ride out Vercel cold-start latency (1-3s) plus a slow
// upstream Solana RPC response without the browser aborting prematurely.
// The previous 5s timeout was too tight and caused spurious
// "All Solana RPC endpoints failed ... timed out after 5s" errors on
// the first request after the function went idle.
const RPC_TIMEOUT_MS = 15_000
// Vercel serverless functions can take 1-3s to cold-start on the first
// request after idle. If the very first request to the proxy times out
// or fails, retry once before giving up — by then the function is warm.
const RPC_RETRY_ONCE_ON_TIMEOUT = true
export const RONIN_TOKEN_URL = `https://solscan.io/token/${RONIN_MINT}#holders`

function extractHeliusKey(rpcUrl) {
  try {
    const u = new URL(rpcUrl)
    return u.searchParams.get('api-key') || u.searchParams.get('api_key') || ''
  } catch {
    return ''
  }
}

function rpcEndpointLabel(endpoint) {
  try { return new URL(endpoint, window.location.origin).hostname } catch { return 'configured endpoint' }
}

async function callRpcEndpoint(endpoint, method, params, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const label = rpcEndpointLabel(endpoint)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null)
      const detail = errorBody?.error ? `: ${errorBody.error}` : ''
      return { ok: false, label, error: `${label} returned HTTP ${response.status}${detail}` }
    }
    const payload = await response.json()
    if (payload.error) {
      return { ok: false, label, error: `${label} returned RPC ${payload.error.code || 'error'}` }
    }
    return { ok: true, result: payload.result }
  } catch (error) {
    return {
      ok: false,
      label,
      error: `${label}: ${error.name === 'AbortError' ? `timed out after ${timeoutMs / 1000}s` : error.message || 'request failed'}`,
      timedOut: error.name === 'AbortError',
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function rpcRequest(method, params) {
  const failures = []
  for (const endpoint of SOLANA_RPC_ENDPOINTS) {
    let attempt = await callRpcEndpoint(endpoint, method, params, RPC_TIMEOUT_MS)
    if (attempt.ok) return attempt.result

    // Retry once on timeout — Vercel cold-start can cause the first request
    // to hit the 15s ceiling even when the proxy itself is healthy. By the
    // time we retry, the function is warm and the second call usually
    // returns in well under a second.
    if (RPC_RETRY_ONCE_ON_TIMEOUT && attempt.timedOut) {
      attempt = await callRpcEndpoint(endpoint, method, params, RPC_TIMEOUT_MS)
      if (attempt.ok) return attempt.result
    }
    if (attempt.error) failures.push(attempt.error)
  }

  throw new Error(`All Solana RPC endpoints failed for ${method}: ${failures.join('; ')}. Set VITE_SOLANA_RPC_URL to a working HTTPS RPC endpoint.`)
}

function bytesToBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export async function sendSignedSolanaTransaction(serializedTransaction) {
  const signature = await rpcRequest('sendTransaction', [
    bytesToBase64(serializedTransaction),
    { encoding: 'base64', skipPreflight: false, maxRetries: 3 },
  ])
  if (!signature || typeof signature !== 'string') throw new Error('Solana RPC did not return a transaction signature.')
  return signature
}

export async function getLatestBlockhash() {
  const result = await rpcRequest('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const value = result?.value || result
  if (!value?.blockhash) throw new Error('Solana RPC did not return a recent blockhash.')
  return value
}

export async function confirmSolanaTransaction(signature, timeoutMs = 60_000) {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await rpcRequest('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])
      const status = result?.value?.[0]
      if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`)
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return { value: { err: null } }
      }
      lastError = null
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  if (lastError) throw lastError
  throw new Error('Transaction confirmation timed out. It may still land — check Solscan.')
}

export async function getRoninBalance(ownerAddress) {
  if (!ownerAddress) throw new Error('A wallet address is required to read $RONIN.')
  const result = await rpcRequest('getTokenAccountsByOwner', [ownerAddress, { mint: RONIN_MINT }, { encoding: 'jsonParsed' }])
  let rawAmount = 0n
  let decimals = 0
  for (const account of result?.value || []) {
    const tokenAmount = account?.account?.data?.parsed?.info?.tokenAmount
    if (!tokenAmount) continue
    rawAmount += BigInt(tokenAmount.amount || '0')
    decimals = Number(tokenAmount.decimals || 0)
  }
  const divisor = 10 ** decimals
  const amount = Number(rawAmount) / divisor
  return {
    amount: Number.isFinite(amount) ? amount : 0,
    rawAmount: rawAmount.toString(),
    decimals,
    accounts: result?.value?.length || 0,
    updatedAt: Date.now(),
    source: 'Solana mainnet RPC',
  }
}

export async function getSolBalance(ownerAddress) {
  if (!ownerAddress) throw new Error('A wallet address is required to read the SOL balance.')
  const result = await rpcRequest('getBalance', [ownerAddress, { commitment: 'confirmed' }])
  const lamports = typeof result === 'object' ? result?.value : result
  return {
    lamports: Number(lamports) || 0,
    sol: (Number(lamports) || 0) / 1_000_000_000,
    updatedAt: Date.now(),
    source: 'Solana mainnet RPC',
  }
}

export async function getRoninSupply() {
  const result = await rpcRequest('getTokenSupply', [RONIN_MINT, { commitment: 'confirmed' }])
  const tokenAmount = result?.value
  if (!tokenAmount) throw new Error('Token supply was not returned by the RPC.')
  const decimals = Number(tokenAmount.decimals || 0)
  return {
    amount: Number(tokenAmount.uiAmountString || tokenAmount.uiAmount || 0),
    rawAmount: tokenAmount.amount,
    decimals,
    updatedAt: Date.now(),
    source: 'Solana mainnet RPC',
  }
}

export async function getTokenLargestAccounts() {
  try {
    const result = await rpcRequest('getTokenLargestAccounts', [RONIN_MINT])
    return result?.value || []
  } catch {
    return []
  }
}

export async function getHeliusHolders() {
  const apiKey = extractHeliusKey(SOLANA_RPC_URL)
  if (!apiKey) return { count: null, holders: [], source: null }
  try {
    const url = `https://api.helius.xyz/v0/tokens/${RONIN_MINT}/holders?api-key=${apiKey}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Helius holders ${res.status}`)
    const data = await res.json()
    if (Array.isArray(data)) return { count: data.length, holders: data, source: 'Helius holders API' }
    if (data?.holders && Array.isArray(data.holders)) return { count: data.total || data.holders.length, holders: data.holders, source: 'Helius holders API' }
    if (typeof data?.total === 'number') return { count: data.total, holders: data.holders || [], source: 'Helius holders API' }
    return { count: null, holders: [], source: null }
  } catch (e) {
    console.warn('Helius holders fetch failed', e)
    return { count: null, holders: [], source: null }
  }
}

export async function getDexScreenerStats() {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${RONIN_MINT}`)
    if (!res.ok) throw new Error(`DexScreener ${res.status}`)
    const data = await res.json()
    const pairs = data?.pairs || []
    if (!pairs.length) return null
    const sorted = [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
    const best = sorted[0]
    return {
      priceUsd: best.priceUsd ? Number(best.priceUsd) : null,
      priceNative: best.priceNative ? Number(best.priceNative) : null,
      volume24h: best.volume?.h24 ? Number(best.volume.h24) : null,
      volume6h: best.volume?.h6 ? Number(best.volume.h6) : null,
      liquidityUsd: best.liquidity?.usd ? Number(best.liquidity.usd) : null,
      marketCap: best.marketCap ? Number(best.marketCap) : best.fdv ? Number(best.fdv) : null,
      fdv: best.fdv ? Number(best.fdv) : null,
      pairAddress: best.pairAddress,
      dexId: best.dexId,
      url: best.url,
      updatedAt: Date.now(),
      source: 'DexScreener',
      raw: best,
      allPairs: pairs,
    }
  } catch (e) {
    console.warn('DexScreener fetch failed', e)
    return null
  }
}

async function getVerifiedBurnHistory() {
  try {
    const response = await fetch('/api/ronin/burn-history', { cache: 'no-store' })
    if (!response.ok) throw new Error(`Burn history API returned ${response.status}.`)
    const data = await response.json()
    if (!data || data.error) throw new Error(data?.error || 'Verified burn history was not returned.')
    return Array.isArray(data.events) ? data.events : []
  } catch (error) {
    console.warn('Verified RONIN burn history fetch failed:', error)
    return null
  }
}

export async function getLiveRoninStats() {
  try {
    // Fetch the global stats and the lightweight verified-burn ledger in
    // parallel. The burn ledger no longer makes the whole dashboard wait for
    // the old global-history scan.
    const [statsResponse, verifiedBurnHistory] = await Promise.all([
      fetch('/api/ronin/stats', { cache: 'no-store' }),
      getVerifiedBurnHistory(),
    ])
    if (!statsResponse.ok) throw new Error(`Live RONIN stats API returned ${statsResponse.status}.`)
    const data = await statsResponse.json()
    if (!data || data.error) throw new Error(data?.error || 'Live RONIN stats were not returned.')
    return {
      supply: data.supply || null,
      // The stats endpoint is the single source for global dashboard data.
      // Wallet-specific reads stay in getRoninBalance() and never contribute
      // to this object.
      largestAccounts: [],
      holdersCount: data.holdersCount ?? null,
      holders: null,
      burned: data.burnsComplete === false ? null : data.burned,
      burnedRaw: data.burnedRaw || null,
      burnHistoryBurned: data.burnsComplete === false ? null : (data.burnHistoryBurned ?? null),
      burnWalletBalance: data.burnWalletBalance ?? null,
      burnWalletAddress: data.burnWalletAddress || null,
      burnsComplete: data.burnsComplete !== false,
      // Prefer the dedicated verified ledger. If it is temporarily unavailable,
      // preserve the existing backend history rather than breaking the page.
      burnHistory: verifiedBurnHistory ?? data.burnHistory ?? [],
      dex: data.dex || null,
      updatedAt: data.updatedAt || Date.now(),
      source: data.source || 'global on-chain RONIN burn data',
    }
  } catch (error) {
    // Do not fall back to a wallet balance or a partial burn total. The
    // backend response is the only authoritative global burn source.
    console.warn('Global RONIN stats fetch failed:', error)
    throw error
  }
}
