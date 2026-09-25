// =====================================================================
// GET /api/ethereum/wallet-tokens?address=0x...
// =====================================================================
// Returns every ERC-20 token the connected MetaMask wallet actually holds
// on Ethereum Mainnet (balance > 0), enriched with symbol/name/decimals/logo,
// plus the wallet's native ETH balance.
//
// This is the Ethereum equivalent of the Solana wallet-token discovery
// pipeline in src/services/shieldService.js → getAllTokenAccounts().
//
// WITHOUT ALCHEMY: returns native ETH balance + on-chain balance checks
//   against the curated 22-token featured catalog only (graceful fallback).
// WITH ALCHEMY_API_KEY set: uses alchemy_getTokenBalances + metadata,
//   which returns every ERC-20 the wallet holds in ~2 round-trips.
//
// The key is read server-side from process.env so it is never exposed
// to the browser.
// =====================================================================

import { apiError, json, rateLimit } from '../../api/_lib/roninBackend.mjs'
import { lifiRpc, lifiRpcUrl } from '../../api/_lib/lifi.mjs'
import { ETHEREUM_FEATURED_TOKENS, ETHEREUM_TOKEN_BY_ADDRESS } from '../../src/config/ethereumRegistry.js'

const ETHEREUM_CHAIN_ID = 1
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const SYMBOL_SELECTOR = '0x95d89b41'
const NAME_SELECTOR = '0x06fdde03'
const DECIMALS_SELECTOR = '0x313ce567'
const BALANCE_OF_SELECTOR = '0x70a08231'

function runtimeEnv() {
  return globalThis.__RONIN_LOCAL_ENV__ || process.env
}

function alchemyApiKey() {
  return String(runtimeEnv().ALCHEMY_API_KEY || '').trim()
}

function alchemyBaseUrl() {
  return `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey()}`
}

async function alchemyRequest(method, params) {
  const response = await fetch(alchemyBaseUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json())
  if (response.error) throw new Error(response.error.message || 'Alchemy RPC error')
  return response.result
}

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

function featuredMeta(address) {
  const normalized = String(address || '').toLowerCase()
  return ETHEREUM_TOKEN_BY_ADDRESS[normalized] || null
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'UNKNOWN'
}

// -------- Fallback (no Alchemy key) ---------------------------------
// We cannot enumerate arbitrary ERC-20 holdings without a token-list API,
// but we CAN balance-check the curated featured list on-chain so the
// "YOUR WALLET" section in the picker still shows real balances for
// any of those 22 tokens the user holds. This keeps the UI honest even
// before the project owner adds an Alchemy key.

async function scanFeaturedBalances(rpcUrl, owner) {
  const catalog = ETHEREUM_FEATURED_TOKENS.filter((token) => token.type === 'erc20' && token.address)
  const body = JSON.stringify(catalog.map((token) => ({
    jsonrpc: '2.0',
    id: token.address,
    method: 'eth_call',
    params: [{ to: token.address, data: `${BALANCE_OF_SELECTOR}${owner.slice(2).padStart(64, '0')}` }, 'latest'],
  })))
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  })
  const results = await response.json()
  const tokens = []
  for (const item of results) {
    if (!item?.result) continue
    const balance = hexToBigInt(item.result)
    if (balance <= 0n) continue
    const meta = featuredMeta(item.id)
    if (!meta) continue
    tokens.push({
      chainId: ETHEREUM_CHAIN_ID,
      chainKey: 'ethereum',
      type: 'erc20',
      address: meta.address,
      symbol: meta.symbol,
      name: meta.name,
      decimals: meta.decimals || 18,
      logoURI: meta.logoURI || meta.fallbackLogoURI || null,
      balance: balance.toString(),
      source: 'featured-catalog',
    })
  }
  return tokens
}

// -------- Primary (Alchemy) -----------------------------------------

async function fetchAlchemyWalletTokens(owner) {
  // 1. Native ETH balance
  const nativeHex = await alchemyRequest('eth_getBalance', [owner, 'latest'])
  const nativeBalance = hexToBigInt(nativeHex)

  // 2. All ERC-20 balances for the wallet
  const balancesResponse = await alchemyRequest('alchemy_getTokenBalances', [owner])
  const tokenBalances = Array.isArray(balancesResponse?.tokenBalances)
    ? balancesResponse.tokenBalances.filter((entry) => entry?.tokenBalance && hexToBigInt(entry.tokenBalance) > 0n && entry.error == null)
    : []

  // 3. Fetch metadata for each non-catalog token (catalog hits skip the round-trip)
  const tokens = await Promise.all(tokenBalances.map(async (entry) => {
    const address = String(entry.contractAddress || '').toLowerCase()
    if (!ADDRESS_PATTERN.test(address)) return null
    const cached = featuredMeta(address)
    if (cached) {
      return {
        chainId: ETHEREUM_CHAIN_ID,
        chainKey: 'ethereum',
        type: 'erc20',
        address,
        symbol: cached.symbol,
        name: cached.name,
        decimals: cached.decimals || 18,
        logoURI: cached.logoURI || cached.fallbackLogoURI || null,
        balance: hexToBigInt(entry.tokenBalance).toString(),
        source: 'alchemy+catalog',
      }
    }
    try {
      const [symbolHex, nameHex, decimalsHex] = await Promise.all([
        alchemyRequest('eth_call', [{ to: address, data: SYMBOL_SELECTOR }, 'latest']),
        alchemyRequest('eth_call', [{ to: address, data: NAME_SELECTOR }, 'latest']),
        alchemyRequest('eth_call', [{ to: address, data: DECIMALS_SELECTOR }, 'latest']),
      ])
      const decimals = Number.parseInt(decimalsHex || '0x0', 16)
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null
      const symbol = decodeString(symbolHex) || shortAddress(address)
      const name = decodeString(nameHex) || symbol
      return {
        chainId: ETHEREUM_CHAIN_ID,
        chainKey: 'ethereum',
        type: 'erc20',
        address,
        symbol,
        name,
        decimals,
        logoURI: `https://tokens.1inch.io/${address}.png`,
        balance: hexToBigInt(entry.tokenBalance).toString(),
        source: 'alchemy',
      }
    } catch {
      return null
    }
  }))

  return {
    native: { balance: nativeBalance.toString(), decimals: 18, symbol: 'ETH', name: 'Ether' },
    tokens: tokens.filter(Boolean),
  }
}

// -------- Handler ----------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'eth-wallet-tokens', 30, 60_000)) return apiError(res, 429, 'RATE_LIMITED', 'Too many wallet-token requests. Try again shortly.')

  const address = String(req.query?.address || '').trim()
  if (!ADDRESS_PATTERN.test(address)) return apiError(res, 400, 'INVALID_ADDRESS', 'A valid Ethereum wallet address is required.')

  const key = alchemyApiKey()
  const useAlchemy = Boolean(key)

  try {
    if (useAlchemy) {
      const { native, tokens } = await fetchAlchemyWalletTokens(address)
      return json(res, 200, {
        success: true,
        chainId: ETHEREUM_CHAIN_ID,
        chainKey: 'ethereum',
        source: 'alchemy',
        native,
        tokens,
        dataAvailable: true,
        generatedAt: new Date().toISOString(),
      })
    }

    // Fallback: balance-check the curated catalog on-chain. This is the
    // same set the picker already shows, but enriched with live balances
    // so the "YOUR WALLET" section still functions.
    const rpcUrl = lifiRpcUrl(ETHEREUM_CHAIN_ID)
    if (!rpcUrl) return apiError(res, 503, 'RPC_NOT_CONFIGURED', 'Ethereum RPC is not configured.')

    const [nativeHex, tokens] = await Promise.all([
      lifiRpc(ETHEREUM_CHAIN_ID, 'eth_getBalance', [address, 'latest']),
      scanFeaturedBalances(rpcUrl, address),
    ])

    return json(res, 200, {
      success: true,
      chainId: ETHEREUM_CHAIN_ID,
      chainKey: 'ethereum',
      source: 'on-chain-catalog-fallback',
      warning: 'ALCHEMY_API_KEY is not set. Wallet discovery is limited to the 22-token featured catalog. Add an Alchemy key to discover every ERC-20 the wallet holds.',
      native: { balance: hexToBigInt(nativeHex).toString(), decimals: 18, symbol: 'ETH', name: 'Ether' },
      tokens,
      dataAvailable: true,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('ethereum wallet-tokens failed:', error?.message || error)
    return apiError(res, 502, 'WALLET_TOKENS_UNAVAILABLE', error?.message || 'Ethereum wallet tokens are unavailable right now.')
  }
}
