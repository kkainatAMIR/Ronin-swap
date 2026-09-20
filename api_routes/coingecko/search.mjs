import { apiError, json, rateLimit } from '../../api/_lib/roninBackend.mjs'

// Use globalThis.__RONIN_LOCAL_ENV__ (set by Vite's localApiPlugin) with
// process.env fallback — same pattern as supabaseBackend.mjs.
const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3'
const COINGECKO_API_KEY = runtimeEnv.VITE_COINGECKO_API_KEY || runtimeEnv.COINGECKO_API_KEY || ''

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'coingecko-search', 30, 60_000)) return apiError(res, 429, 'RATE_LIMITED', 'CoinGecko metadata lookup is temporarily rate limited.')

  const query = String(req.query?.query || '').trim()
  if (!query) return json(res, 400, { error: 'Missing query.' })

  try {
    const headers = { accept: 'application/json' }
    if (COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = COINGECKO_API_KEY

    const response = await fetch(`${COINGECKO_BASE_URL}/search?query=${encodeURIComponent(query)}`, {
      headers,
      signal: AbortSignal.timeout(6_000),
    })

    if (!response.ok) {
      return json(res, response.status, { error: 'CoinGecko search failed.', coins: [] })
    }

    const body = await response.json().catch(() => ({ coins: [] }))
    return json(res, 200, { coins: Array.isArray(body?.coins) ? body.coins : [] })
  } catch (error) {
    console.error('CoinGecko metadata lookup failed:', error?.message || error)
    return json(res, 200, { coins: [] })
  }
}
