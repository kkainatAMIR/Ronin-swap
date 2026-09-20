import { apiError, json } from '../../api/_lib/roninBackend.mjs'
import { getVerifiedSwapHistory, isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'

function isValidWallet(value) {
  return typeof value === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) || /^0x[0-9a-fA-F]{40}$/.test(value))
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Verified swap persistence is not configured on the server.')
  const wallet = String(req.query?.wallet || '').trim()
  const chain = String(req.query?.chain || 'all').toLowerCase()
  if (!['all', 'solana', 'ethereum', 'robinhood'].includes(chain)) return apiError(res, 400, 'INVALID_CHAIN_FILTER', 'chain must be all, solana, ethereum, or robinhood.')
  if (!isValidWallet(wallet)) return apiError(res, 400, 'INVALID_WALLET', 'A valid wallet query parameter is required.')
  try {
    const swaps = await getVerifiedSwapHistory(wallet, chain)
    return json(res, 200, { wallet, chain, swaps: Array.isArray(swaps) ? swaps : [] })
  } catch (error) {
    console.error('verified swap history failed:', error?.message || error)
    return apiError(res, 502, 'DATABASE_ERROR', 'Verified swap history is unavailable.')
  }
}