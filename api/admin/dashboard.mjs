import { apiError, json, parseBody } from '../_lib/roninBackend.mjs'
import { requireAdmin } from '../_lib/adminAuth.mjs'
import { getAdminLeaderboard, getAdminNotes, getAdminOverview, getAdminPointDetails, getAdminSettings, getAdminWallet, getSeasons, createAdminNote, updateAdminSettings, isSupabaseConfigured } from '../_lib/supabaseBackend.mjs'

function validWallet(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) || /^0x[a-fA-F0-9]{40}$/.test(trimmed)
}

function validSignature(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(trimmed) || /^0x[a-fA-F0-9]{64}$/.test(trimmed)
}
function adminId(req) { return String(req.headers['x-admin-id'] || 'admin').slice(0, 120) }

export default async function handler(req, res) {
  if (!await requireAdmin(req, res)) return
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Admin dashboard is not configured.')
  try {
    const resource = String(req.query?.resource || 'overview')
    if (req.method === 'GET') {
      if (resource === 'overview') return json(res, 200, { overview: await getAdminOverview(), settings: await getAdminSettings(), seasons: await getSeasons() })
      if (resource === 'settings') return json(res, 200, { settings: await getAdminSettings() })
      if (resource === 'leaderboard') {
        const period = ['daily', 'weekly', 'monthly', 'season', 'all-time'].includes(req.query?.period) ? req.query.period : 'season'
        return json(res, 200, { rows: await getAdminLeaderboard({ period, seasonId: req.query?.seasonId || null, page: Math.max(1, Number(req.query?.page) || 1), limit: Math.min(100, Math.max(1, Number(req.query?.limit) || 100)) }) })
      }
      if (resource === 'wallet') {
        if (!validWallet(req.query?.address)) return apiError(res, 400, 'INVALID_WALLET', 'A valid wallet address is required.')
        return json(res, 200, await getAdminWallet(req.query.address))
      }
      if (resource === 'transaction') {
        if (!validSignature(req.query?.signature)) return apiError(res, 400, 'INVALID_SIGNATURE', 'A valid transaction signature is required.')
        return json(res, 200, { transaction: await getAdminTransactions({ signature: req.query.signature, page: 1, limit: 1 }), points: await getAdminPointDetails(req.query.signature), notes: await getAdminNotes({ signature: req.query.signature }) })
      }
      return apiError(res, 404, 'ADMIN_RESOURCE_NOT_FOUND', 'Admin resource not found.')
    }
    const body = parseBody(req) || {}
    if (req.method === 'PATCH' && resource === 'settings') {
      const allowed = ['points_enabled', 'minimum_qualifying_swap_usd', 'points_per_usd', 'transaction_points_cap_enabled', 'transaction_points_cap', 'campaigns', 'swap_enabled', 'sol_rewards_enabled', 'platform_fee_enabled', 'platform_fee_bps']
      const values = Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(body, key)).map((key) => [key, body[key]]))
      const numeric = ['minimum_qualifying_swap_usd', 'points_per_usd', 'transaction_points_cap', 'platform_fee_bps']
      for (const key of numeric) if (values[key] != null && (!Number.isFinite(Number(values[key])) || Number(values[key]) < 0)) return apiError(res, 400, 'INVALID_SETTING', `${key} must be non-negative.`)
      if (values.campaigns != null && !Array.isArray(values.campaigns)) return apiError(res, 400, 'INVALID_CAMPAIGNS', 'campaigns must be an array.')
      if (values.platform_fee_bps != null && Number(values.platform_fee_bps) > 10_000) return apiError(res, 400, 'INVALID_SETTING', 'platform_fee_bps must not exceed 10000.')
      if (values.sol_rewards_enabled === true) return apiError(res, 400, 'REWARDS_NOT_AVAILABLE', 'SOL rewards are not available in this release.')
      return json(res, 200, { settings: await updateAdminSettings(values, adminId(req)) })
    }
    if (req.method === 'POST' && resource === 'notes') {
      const wallet = body.wallet ? String(body.wallet).trim() : ''
      const signature = body.signature ? String(body.signature).trim() : ''
      if ((!wallet || !validWallet(wallet)) && (!signature || !validSignature(signature))) return apiError(res, 400, 'INVALID_NOTE_TARGET', 'A valid wallet or transaction signature is required.')
      const note = String(body.note || '').trim()
      if (!note || note.length > 2_000) return apiError(res, 400, 'INVALID_NOTE', 'A note between 1 and 2000 characters is required.')
      return json(res, 201, { note: await createAdminNote({ wallet: wallet || null, signature: signature || null, note, adminId: adminId(req) }) })
    }
    return apiError(res, 404, 'ADMIN_RESOURCE_NOT_FOUND', 'Admin resource not found.')
  } catch (error) {
    console.error('admin dashboard API failed:', error?.message || error)
    return apiError(res, 400, 'ADMIN_DASHBOARD_ERROR', 'Admin dashboard operation failed.')
  }
}