import dotenv from 'dotenv'

dotenv.config({ path: '.env.local', override: true })

const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env
const JUPITER_API_KEY = runtimeEnv.JUPITER_API_KEY || ''
const JUPITER_BASE_URL = runtimeEnv.JUPITER_BASE_URL || 'https://api.jup.ag'
const JUPITER_REFERRAL_ACCOUNT = runtimeEnv.JUPITER_REFERRAL_ACCOUNT || 'VF1nw8cRfFKJeqW7kCsthWy1NirCF4B31YocUKZrbB7'
const JUPITER_REFERRAL_FEE_BPS = Number(runtimeEnv.JUPITER_REFERRAL_FEE_BPS || 50)
const JUPITER_TIMEOUT_MS = 10_000
const SOL_INCINERATOR_BASE_URL = process.env.SOL_INCINERATOR_BASE_URL || 'https://v2.api.sol-incinerator.com'
const SOL_INCINERATOR_API_KEY = runtimeEnv.SOL_INCINERATOR_API_KEY || ''

// Official published $RONIN mint — the single server-side source of truth.
// The same address is defined once for the frontend in src/data.js.
const DEFAULT_RONIN_MINT = '2JVEVXoRsskapZ8T56MjMNJq6Dk3feEUYSRmzkkipump'
const RONIN_MINT = runtimeEnv.RONIN_MINT_ADDRESS || DEFAULT_RONIN_MINT

export function json(res, status, body) {
  return res.status(status).json(body)
}

export function apiError(res, status, code, message) {
  return json(res, status, { error: message, code })
}

export function jupiterHeaders(extra = {}) {
  const headers = { ...extra }
  if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY
  return headers
}

export function incineratorHeaders(extra = {}) {
  const headers = { ...extra, 'Content-Type': 'application/json' }
  if (SOL_INCINERATOR_API_KEY) headers['x-api-key'] = SOL_INCINERATOR_API_KEY
  return headers
}

export function parseBody(req) {
  if (!req.body) return {}
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return null }
  }
  return req.body
}

export async function readUpstream(response) {
  const text = await response.text()
  try { return text ? JSON.parse(text) : {} } catch { return { raw: text } }
}

export async function fetchJupiter(path, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), JUPITER_TIMEOUT_MS)
  try {
    return await fetch(`${JUPITER_BASE_URL}${path}`, {
      ...options,
      headers: jupiterHeaders(options.headers),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

export function isJupiterConfigured() {
  return Boolean(JUPITER_API_KEY && JUPITER_BASE_URL)
}

export function isValidAmount(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return true
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

export function isValidSlippageBps(value) {
  if (value === undefined || value === null || value === '') return true
  return /^\d{1,4}$/.test(String(value)) && Number(value) <= 5_000
}

export function configSummary() {
  return {
    ok: true,
    solanaRpcConfigured: Boolean(runtimeEnv.SOLANA_RPC_URL || runtimeEnv.HELIUS_API_KEY),
    jupiterBaseUrl: JUPITER_BASE_URL,
    hasApiKey: Boolean(JUPITER_API_KEY),
    referralAccount: JUPITER_REFERRAL_ACCOUNT,
    referralFeeBps: JUPITER_REFERRAL_FEE_BPS,
    solIncineratorBaseUrl: SOL_INCINERATOR_BASE_URL,
    hasSolIncineratorKey: Boolean(SOL_INCINERATOR_API_KEY),
  }
}

export {
  JUPITER_BASE_URL,
  JUPITER_REFERRAL_ACCOUNT,
  JUPITER_REFERRAL_FEE_BPS,
  JUPITER_TIMEOUT_MS,
  SOL_INCINERATOR_BASE_URL,
  SOL_INCINERATOR_API_KEY,
  RONIN_MINT,
}
