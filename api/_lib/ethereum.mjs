import crypto from 'node:crypto'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const NATIVE = 'native'
const DEFAULT_TREASURY = '0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9'
const SUPPORTED = new Set([
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  '0xdac17f958d2ee523a2206206994597c13d831ec7', '0x2260fac5e5542a773aa44fbcedf7c193bc2c599',
  '0x6982508145454ce325ddb e47a25d4ec3d2311933'.replace(' ', ''), '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce',
  '0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c', '0xaaee1a9723aad b7afa2810263653a34ba2c21c7a'.replace(' ', ''),
  '0xcf0c122c6b73ff809c693db761e7baeb e62b6a2e'.replace(' ', ''), '0x514910771af9ca656af840dff83e8264ecf986ca',
  '0x1f9840a85d5af5bf1d1762f925bdadc4201f984', '0x7fc66500c84a76ad7e9c93437bf c5ac33e2dda9'.replace(' ', ''),
  '0x57e114b691db790c35207b2e685d4a43181e6061', '0x808507121b80c02388fad14726482e061b8da827',
  '0x5a98fcbea516cf06857215779fd812ca3bef1b32', '0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3',
  '0x812ba41e071c7b7fa4ebcfb62df5f45f6fa853ee', '0x594daad7d77592a2b97b725a7ad59d7e188b5bfa',
  '0x72e4f9f808c49a2a61de9c5896298920dc4eee a9'.replace(' ', ''), '0xd533a949740bb3306d119cc777fa900ba034cd52',
])
function runtimeEnv() { return globalThis.__RONIN_LOCAL_ENV__ || process.env }
function encodeBase64Url(value) { return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
function decodeBase64Url(value) { return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(value).length % 4)) % 4), 'base64') }

export function isEthereumAddress(value) { return typeof value === 'string' && ADDRESS.test(value) }
export function isSupportedEthereumToken(value) { return value === NATIVE || (isEthereumAddress(value) && SUPPORTED.has(value.toLowerCase())) }
// Shared with LI.FI Robinhood routing so already-vetted Ethereum-side addresses stay a single source of truth.
export const SUPPORTED_ETHEREUM_TOKENS = SUPPORTED

const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com'
// WETH is used as the USD price proxy for native ETH on both chains (Robinhood Chain's gas token is ETH too).
const NATIVE_PRICE_PROXY_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const DEX_CHAIN_SLUG = { 1: 'ethereum', 4663: 'robinhood' }
const FALLBACK_EVM_PRICES = new Map([
  ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 3500],
  ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 1],
  ['0xdac17f958d2ee523a2206206994597c13d831ec7', 1],
  ['0x2260fac5e5542a773aa44fbcedf7c193bc2c599', 62000],
  ['0x514910771af9ca656af840dff83e8264ecf986ca', 17],
  ['0x7fc66500c84a76ad7e9c93437bf5ac33e2dda9', 0.8],
  ['0x1f9840a85d5af5bf1d1762f925bdadc4201f984', 8],
  ['0x57e114b691db790c35207b2e685d4a43181e6061', 0.15],
  ['0x5a98fcbea516cf06857215779fd812ca3bef1b32', 1.1],
  ['0xd533a949740bb3306d119cc777fa900ba034cd52', 0.9],
])
const evmPriceCache = new Map()
const EVM_PRICE_CACHE_TTL_MS = 30_000

function isNativeAsset(address) {
  const value = String(address || '').toLowerCase()
  return !value || value === 'native' || value === '0x0000000000000000000000000000000000000000' || value === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
}

// Live USD price for an EVM asset, used to derive qualifying swap volume when
// a quote does not already carry a USD amount (e.g. non-stablecoin pairs).
export async function getEvmUsdPrice(chainId, address) {
  const isNative = isNativeAsset(address)
  const lookupAddress = isNative ? NATIVE_PRICE_PROXY_ADDRESS : address
  if (!isEthereumAddress(lookupAddress)) throw new Error('PRICE_UNAVAILABLE')
  const cacheKey = `${Number(chainId)}:${lookupAddress.toLowerCase()}`
  const cached = evmPriceCache.get(cacheKey)
  if (cached && Date.now() - cached.at < EVM_PRICE_CACHE_TTL_MS) return cached.price

  const staticFallback = FALLBACK_EVM_PRICES.get(lookupAddress.toLowerCase())
  if (staticFallback != null && Number.isFinite(staticFallback) && staticFallback > 0) {
    evmPriceCache.set(cacheKey, { price: staticFallback, at: Date.now() })
    return staticFallback
  }

  const slug = isNative ? 'ethereum' : (DEX_CHAIN_SLUG[Number(chainId)] || 'ethereum')
  try {
    const response = await fetch(`${DEXSCREENER_BASE_URL}/latest/dex/tokens/${lookupAddress}`, { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) throw new Error('PRICE_UNAVAILABLE')
    const body = await response.json().catch(() => null)
    const pair = Array.isArray(body?.pairs) ? body.pairs.find((item) => item?.chainId === slug && Number.isFinite(Number(item?.priceUsd))) : null
    const price = pair ? Number(pair.priceUsd) : null
    if (!Number.isFinite(price) || price <= 0) throw new Error('PRICE_UNAVAILABLE')
    evmPriceCache.set(cacheKey, { price, at: Date.now() })
    return price
  } catch {
    if (staticFallback != null && Number.isFinite(staticFallback) && staticFallback > 0) {
      evmPriceCache.set(cacheKey, { price: staticFallback, at: Date.now() })
      return staticFallback
    }
    throw new Error('PRICE_UNAVAILABLE')
  }
}
export function isEthereumConfigured() { const env = runtimeEnv(); return Number(env.ETHEREUM_CHAIN_ID || 1) === 1 && Boolean(env.ZEROX_API_KEY && env.ZEROX_BASE_URL) }
export function ethereumSwapFeeConfig() {
  const env = runtimeEnv()
  const recipient = env.ETHEREUM_TREASURY_ADDRESS || DEFAULT_TREASURY
  const bps = Number(env.ETHEREUM_SWAP_FEE_BPS || 50)
  if (!isEthereumAddress(recipient) || !Number.isInteger(bps) || bps < 0 || bps > 1000) throw new Error('INVALID_ETHEREUM_FEE_CONFIG')
  return { recipient, bps }
}
export async function fetchZeroEx(path, options = {}) {
  const env = runtimeEnv()
  const baseUrl = String(env.ZEROX_BASE_URL || 'https://api.0x.org').replace(/\/$/, '')
  return fetch(`${baseUrl}${path}`, { ...options, headers: { Accept: 'application/json', '0x-api-key': env.ZEROX_API_KEY || '', '0x-version': 'v2', ...(options.headers || {}) }, signal: AbortSignal.timeout(10_000) })
}
export function ethereumChainId() { return Number(runtimeEnv().ETHEREUM_CHAIN_ID || 1) }

export function createQuoteProof(payload, expiresAt = Date.now() + 5 * 60_000) {
  const body = encodeBase64Url(JSON.stringify({ ...payload, expiresAt }))
  const env = runtimeEnv()
  const signature = (awaitableHmac(body, env.ADMIN_SESSION_SECRET || env.ADMIN_API_TOKEN || ''))
  return { proof: `${body}.${signature}`, expiresAt }
}

export function verifyQuoteProof(proof, expected) {
  const [body, supplied] = String(proof || '').split('.')
  const env = runtimeEnv()
  const signingSecret = env.ADMIN_SESSION_SECRET || env.ADMIN_API_TOKEN || ''
  if (!body || !supplied || !signingSecret) throw new Error('QUOTE_INVALID')
  const expectedSignature = awaitableHmac(body, signingSecret)
  if (supplied.length !== expectedSignature.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expectedSignature))) throw new Error('QUOTE_INVALID')
  const payload = JSON.parse(decodeBase64Url(body).toString('utf8'))
  if (payload.expiresAt < Date.now() || Object.entries(expected).some(([key, value]) => String(payload[key]).toLowerCase() !== String(value).toLowerCase())) throw new Error(payload.expiresAt < Date.now() ? 'QUOTE_EXPIRED' : 'QUOTE_INVALID')
  return payload
}

function awaitableHmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url')
}

export async function ethereumRpc(method, params = []) {
  const env = runtimeEnv()
  const rpcUrl = env.ETHEREUM_RPC_URL || env.VITE_ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com'
  if (!rpcUrl) throw new Error('ETHEREUM_RPC_NOT_CONFIGURED')
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }), signal: AbortSignal.timeout(10_000) })
  const body = await response.json()
  if (!response.ok || body.error) throw new Error(body?.error?.message || 'Ethereum RPC request failed.')
  return body.result
}