import { apiError, json, parseBody } from '../../api/_lib/roninBackend.mjs'
import { requireAdmin } from '../../api/_lib/adminAuth.mjs'
import { getAdminLeaderboard, getAdminNotes, getAdminOverview, getAdminPointDetails, getAdminSettings, getAdminWallet, getSeasons, createAdminNote, updateAdminSettings, isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'

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
      const allowed = ['points_enabled', 'minimum_qualifying_swap_usd', 'points_per_usd', 'transaction_points_cap_enabled', 'transaction_points_cap', 'campaigns', 'swap_enabled', 'sol_rewards_enabled', 'platform_fee_enabled', 'platform_fee_bps', 'reward_asset', 'reward_points_per_unit']
      const values = Object.fromEntries(allowed.filter((key) => Object.prototype.hasOwnProperty.call(body, key)).map((key) => [key, body[key]]))
      const numeric = ['minimum_qualifying_swap_usd', 'points_per_usd', 'transaction_points_cap', 'platform_fee_bps', 'reward_points_per_unit']
      for (const key of numeric) if (values[key] != null && (!Number.isFinite(Number(values[key])) || Number(values[key]) < 0)) return apiError(res, 400, 'INVALID_SETTING', `${key} must be non-negative.`)
      if (values.campaigns != null && !Array.isArray(values.campaigns)) return apiError(res, 400, 'INVALID_CAMPAIGNS', 'campaigns must be an array.')
      if (values.platform_fee_bps != null && Number(values.platform_fee_bps) > 10_000) return apiError(res, 400, 'INVALID_SETTING', 'platform_fee_bps must not exceed 10000.')
      if (values.reward_points_per_unit != null && Number(values.reward_points_per_unit) <= 0) return apiError(res, 400, 'INVALID_SETTING', 'reward_points_per_unit must be greater than 0.')
      if (values.reward_asset != null && (typeof values.reward_asset !== 'string' || values.reward_asset.trim().length === 0 || values.reward_asset.length > 32)) return apiError(res, 400, 'INVALID_SETTING', 'reward_asset must be a non-empty string (max 32 chars).')
      // `sol_rewards_enabled` is the Rewards ON/OFF gate for the reward claim RPC.
      // Historical placeholder rejection has been removed: the reward accounting
      // layer is now implemented in migration 20260917000000_reward_claims.sql.
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
    // Log full error to server console for debugging
    console.error('admin dashboard API failed:', error?.message || error, error?.stack || '')
    // Return a more informative error to the frontend so the admin can
    // see what's actually wrong (the previous generic "Admin dashboard
    // operation failed." message hid the real cause).
    const code = error?.code || error?.body?.code || 'ADMIN_DASHBOARD_ERROR'
    const message = error?.body?.message || error?.message || 'Admin dashboard operation failed.'
    const status = error?.status || 400
    return apiError(res, status, code, message)
  }
}