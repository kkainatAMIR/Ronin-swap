import dotenv from 'dotenv'
import { SUPPORTED_ETHEREUM_TOKENS } from './ethereum.mjs'
import { ROBINHOOD_VERIFIED_TOKENS } from '../../src/config/robinhoodRegistry.js'

dotenv.config({ path: '.env.local', override: true })

const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

export const LIFI_BASE_URL = String(runtimeEnv.LIFI_BASE_URL || 'https://li.quest/v1').replace(/\/$/, '')
export const LIFI_INTEGRATOR = String(runtimeEnv.LIFI_INTEGRATOR || 'RoninSamurai')
export const LIFI_FEE_BPS = Number(runtimeEnv.LIFI_FEE_BPS || 50)
export const LIFI_FEE_ENABLED = String(runtimeEnv.LIFI_FEE_ENABLED || '').toLowerCase() === 'true'
const DEFAULT_FEE_RECEIVER_FALLBACK = '0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9'
export const LIFI_FEE_RECEIVER = String(runtimeEnv.LIFI_FEE_RECEIVER || runtimeEnv.ETHEREUM_TREASURY_ADDRESS || DEFAULT_FEE_RECEIVER_FALLBACK).trim()
export const LIFI_FEE_DECIMAL = (() => {
  const raw = Number.isFinite(LIFI_FEE_BPS) ? LIFI_FEE_BPS / 10_000 : 0
  return raw >= 0 && raw < 1 ? raw : 0
})()
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
export function lifiFeeConfigIsValid() {
  if (!LIFI_FEE_ENABLED) return { ok: false, reason: 'LIFI_FEE_ENABLED is not true', recoverable: false }
  if (!Number.isFinite(LIFI_FEE_BPS) || LIFI_FEE_BPS < 0 || LIFI_FEE_BPS > 9999) return { ok: false, reason: `LIFI_FEE_BPS out of range (0-9999): ${LIFI_FEE_BPS}`, recoverable: false }
  if (!ADDRESS.test(LIFI_FEE_RECEIVER)) return { ok: false, reason: `LIFI_FEE_RECEIVER is not a valid EVM address: ${LIFI_FEE_RECEIVER}`, recoverable: false }
  return { ok: true }
}
export function buildLifiFeeQueryParams() {
  const check = lifiFeeConfigIsValid()
  if (!check.ok) return {}
  const params = { integrator: LIFI_INTEGRATOR, fee: String(LIFI_FEE_DECIMAL) }
  if (ADDRESS.test(LIFI_FEE_RECEIVER)) params.feeRecipient = LIFI_FEE_RECEIVER
  return params
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000'
const ROBINHOOD_CHAIN_ID = 4663

export function normalizeNativeTokenAddress(value) {
  const normalized = String(value ?? '').trim()
  if (!normalized) return ''
  const lower = normalized.toLowerCase()
  if (lower === 'native' || lower === NATIVE_ADDRESS || lower === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return NATIVE_ADDRESS
  return normalized
}
const APPROVED_TOKENS = (() => {
  try {
    const parsed = JSON.parse(runtimeEnv.LIFI_APPROVED_TOKENS || '{}')
    return new Map(Object.entries(parsed).map(([key, value]) => [key.toLowerCase(), value]))
  } catch {
    return new Map()
  }
})()
const ROBINHOOD_APPROVED_ADDRESSES = new Set(ROBINHOOD_VERIFIED_TOKENS.map((token) => String(token.address || '').toLowerCase()))

// Robinhood Chain has no manually curated, verified token registry yet (see
// README). Instead of guessing contract addresses, the token list — and the
// approval gate below — is sourced live from LI.FI's own token catalog,
// which is the same trusted upstream already used for /api/robinhood/trending.
let robinhoodCatalogCache = { at: 0, tokens: [] }
const ROBINHOOD_CATALOG_TTL_MS = 60_000

export async function getRobinhoodTokenCatalog() {
  if (Date.now() - robinhoodCatalogCache.at < ROBINHOOD_CATALOG_TTL_MS && robinhoodCatalogCache.tokens.length) return robinhoodCatalogCache.tokens
  try {
    const response = await fetch(`${LIFI_BASE_URL}/tokens?chains=${ROBINHOOD_CHAIN_ID}`, { headers: lifiHeaders(), signal: AbortSignal.timeout(12_000) })
    if (!response.ok) return robinhoodCatalogCache.tokens
    const body = await response.json().catch(() => null)
    const tokens = Array.isArray(body?.tokens?.[String(ROBINHOOD_CHAIN_ID)]) ? body.tokens[String(ROBINHOOD_CHAIN_ID)] : []
    const cleaned = tokens.filter((token) => ADDRESS_PATTERN.test(String(token?.address || '')))
    robinhoodCatalogCache = { at: Date.now(), tokens: cleaned }
    return cleaned
  } catch {
    return robinhoodCatalogCache.tokens
  }
}

export function isKnownRobinhoodCatalogToken(address) {
  const normalized = String(address || '').toLowerCase()
  return robinhoodCatalogCache.tokens.some((token) => String(token.address).toLowerCase() === normalized)
}

// Async because a Robinhood Chain address can only be trusted after its live
// LI.FI catalog has been fetched at least once (no local address list exists).
export async function isApprovedLifiToken(chainId, address) {
  const numericChainId = Number(chainId)
  const normalized = normalizeNativeTokenAddress(address).toLowerCase()
  if (!normalized) return false
  if (APPROVED_TOKENS.has(`${numericChainId}:${normalized}`)) return true
  if (normalized === NATIVE_ADDRESS) return true
  if (!ADDRESS_PATTERN.test(normalized)) return false
  if (numericChainId === 1) return SUPPORTED_ETHEREUM_TOKENS.has(normalized)
  if (numericChainId === ROBINHOOD_CHAIN_ID) {
    if (ROBINHOOD_APPROVED_ADDRESSES.has(normalized)) return true
    await getRobinhoodTokenCatalog()
    return isKnownRobinhoodCatalogToken(normalized)
  }
  return false
}

export function getApprovedLifiToken(chainId, address) {
  const normalized = normalizeNativeTokenAddress(address).toLowerCase()
  return APPROVED_TOKENS.get(`${Number(chainId)}:${normalized}`) || null
}

export function lifiConfigSummary() {
  const feeCheck = lifiFeeConfigIsValid()
  return {
    baseUrl: LIFI_BASE_URL,
    integrator: LIFI_INTEGRATOR,
    apiKeyConfigured: Boolean(runtimeEnv.LIFI_API_KEY),
    approvedTokenCount: APPROVED_TOKENS.size,
    quoteExecutionEnabled: true,
    fee: {
      enabled: LIFI_FEE_ENABLED,
      bps: LIFI_FEE_BPS,
      decimal: LIFI_FEE_DECIMAL,
      receiver: LIFI_FEE_RECEIVER,
      receiverSetFromEnv: Boolean(runtimeEnv.LIFI_FEE_RECEIVER),
      valid: feeCheck.ok,
      invalidReason: feeCheck.ok ? null : feeCheck.reason,
    },
  }
}

export function lifiHeaders(extra = {}) {
  const headers = { Accept: 'application/json', ...extra }
  if (runtimeEnv.LIFI_API_KEY) headers['x-lifi-api-key'] = runtimeEnv.LIFI_API_KEY
  return headers
}

export async function lifiRequest(path, options = {}) {
  const response = await fetch(`${LIFI_BASE_URL}${path}`, { ...options, headers: lifiHeaders(options.headers), signal: AbortSignal.timeout(30_000) })
  const text = await response.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `LI.FI request failed (${response.status})`)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

export function lifiRpcUrl(chainId) {
  const env = globalThis.__RONIN_LOCAL_ENV__ || process.env
  if (Number(chainId) === 4663) return String(env.ROBINHOOD_RPC_URL || env.VITE_ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com/').trim()
  if (Number(chainId) === 1) return String(env.ETHEREUM_RPC_URL || env.VITE_ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com').trim()
  return ''
}

export async function lifiRpc(chainId, method, params = []) {
  const rpcUrl = lifiRpcUrl(chainId)
  if (!rpcUrl) throw new Error('LIFI_RPC_NOT_CONFIGURED')
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }), signal: AbortSignal.timeout(30_000) })
  const body = await response.json()
  if (!response.ok || body.error) throw new Error(body?.error?.message || 'LI.FI chain RPC request failed.')
  return body.result
}
