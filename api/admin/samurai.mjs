import { apiError, json } from '../../api/_lib/roninBackend.mjs'
import { isSupabaseConfigured, getAdminFlags, getAdminTransactions, getAdminWallet, adminAction, recalculateSamurai } from '../../api/_lib/supabaseBackend.mjs'
import { requireAdmin } from '../../api/_lib/adminAuth.mjs'

function validBase58(value, min, max) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value) && value.length >= min && value.length <= max
}

function pageValue(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : fallback
}

export default async function handler(req, res) {
  if (!await requireAdmin(req, res)) return
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Admin review is not configured.')
  const parts = String(req.url || '').split('?')[0].split('/').filter(Boolean)
  const resource = parts[parts.length - 1]
  try {
    if (req.method === 'GET' && resource === 'flags') {
      const page = pageValue(req.query?.page, 1)
      const limit = pageValue(req.query?.limit, 25)
      if (page < 1 || limit < 1 || limit > 100) return apiError(res, 400, 'INVALID_PAGINATION', 'Invalid pagination.')
      return json(res, 200, { flags: await getAdminFlags(page, limit) })
    }
    if (req.method === 'GET' && resource === 'transactions') {
      const signature = req.query?.signature ? String(req.query.signature).trim() : ''
      const wallet = req.query?.wallet ? String(req.query.wallet).trim() : ''
      if (signature && !validBase58(signature, 32, 88)) return apiError(res, 400, 'INVALID_SIGNATURE', 'Invalid signature.')
      if (wallet && !validBase58(wallet, 32, 44)) return apiError(res, 400, 'INVALID_WALLET', 'Invalid wallet.')
      const page = pageValue(req.query?.page, 1)
      const limit = pageValue(req.query?.limit, 25)
      if (page < 1 || limit < 1 || limit > 100) return apiError(res, 400, 'INVALID_PAGINATION', 'Invalid pagination.')
      return json(res, 200, { transactions: await getAdminTransactions({ signature, wallet, page, limit }) })
    }
    if (req.method === 'GET' && resource === 'wallet') {
      const wallet = String(req.query?.wallet || '').trim()
      if (!validBase58(wallet, 32, 44)) return apiError(res, 400, 'INVALID_WALLET', 'Invalid wallet.')
      return json(res, 200, await getAdminWallet(wallet))
    }
    if (req.method === 'POST' && resource === 'recalculate') {
      const body = req.body || {}
      const wallet = body.wallet ? String(body.wallet).trim() : null
      if (wallet && !validBase58(wallet, 32, 44)) return apiError(res, 400, 'INVALID_WALLET', 'Invalid wallet.')
      return json(res, 200, { recalculated: await recalculateSamurai(wallet), action: 'ADMIN_RECALCULATED_POINTS' })
    }
    if (req.method === 'POST' && ['flag', 'exclude', 'restore'].includes(resource)) {
      const body = req.body || {}
      const signature = body.signature ? String(body.signature).trim() : null
      const wallet = body.wallet ? String(body.wallet).trim() : null
      if (!signature && !wallet) return apiError(res, 400, 'MISSING_TARGET', 'A transaction signature or wallet is required.')
      if (signature && !validBase58(signature, 32, 88)) return apiError(res, 400, 'INVALID_SIGNATURE', 'Invalid signature.')
      if (wallet && !validBase58(wallet, 32, 44)) return apiError(res, 400, 'INVALID_WALLET', 'Invalid wallet.')
      const status = resource === 'flag' ? 'FLAGGED' : resource === 'exclude' ? 'EXCLUDED' : 'NORMAL'
      const result = await adminAction({ action: `ADMIN_${resource.toUpperCase()}_${signature ? 'TRANSACTION' : 'WALLET'}`, signature, wallet, status, reason: String(body.reason || 'Admin review'), severity: String(body.severity || 'medium'), adminId: String(req.headers['x-admin-id'] || 'admin') })
      return json(res, 200, result)
    }
    return apiError(res, 404, 'ADMIN_ROUTE_NOT_FOUND', 'Admin route not found.')
  } catch (error) {
    console.error('admin samurai API failed:', error?.message || error)
    return apiError(res, 500, 'ADMIN_API_ERROR', 'Admin operation failed.')
  }
}