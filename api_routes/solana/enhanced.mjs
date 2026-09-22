import { apiError, json, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'

const HELIUS_BASE_URL = 'https://api.helius.xyz'
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const MAX_LIMIT = 100

function runtimeEnv() {
  return globalThis.__RONIN_LOCAL_ENV__ || process.env
}

function heliusApiKey() {
  return String(runtimeEnv().HELIUS_API_KEY || '').trim()
}

function validOwner(value) {
  return ADDRESS_PATTERN.test(String(value || ''))
}

async function heliusFetch(path, query = {}) {
  const apiKey = heliusApiKey()
  if (!apiKey) throw new Error('HELIUS_NOT_CONFIGURED')
  const params = new URLSearchParams({ ...query, 'api-key': apiKey })
  const response = await fetch(`${HELIUS_BASE_URL}${path}?${params}`, { signal: AbortSignal.timeout(12_000) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`HELIUS_${response.status}`)
  return body
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!(await rateLimitPersistent(req, 'solana-enhanced', 30))) return apiError(res, 429, 'RATE_LIMITED', 'Enhanced Solana data is temporarily rate limited.')

  const owner = String(req.query?.owner || '')
  const resource = String(req.query?.resource || 'balances')
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query?.limit || 20)))
  if (!validOwner(owner)) return apiError(res, 400, 'INVALID_OWNER', 'A valid Solana wallet address is required.')

  try {
    if (resource === 'balances') {
      return json(res, 200, await heliusFetch(`/v1/wallet/${owner}/balances`, { page: '1', limit: String(limit) }))
    }
    if (resource === 'transactions') {
      return json(res, 200, await heliusFetch(`/v0/addresses/${owner}/transactions`, { limit: String(limit) }))
    }
    if (resource === 'holders') {
      const mint = String(req.query?.mint || '')
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return apiError(res, 400, 'INVALID_MINT', 'A valid Solana mint is required.')
      return json(res, 200, await heliusFetch(`/v0/tokens/${encodeURIComponent(mint)}/holders`))
    }
    return apiError(res, 400, 'INVALID_RESOURCE', 'Unsupported enhanced Solana resource.')
  } catch (error) {
    console.error('Enhanced Solana request failed:', error?.message || 'unknown error')
    return apiError(res, 502, 'ENHANCED_SOLANA_UNAVAILABLE', 'Enhanced Solana data is temporarily unavailable.')
  }
}
