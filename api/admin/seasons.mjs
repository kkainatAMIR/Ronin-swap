import { apiError, json, parseBody } from '../_lib/roninBackend.mjs'
import { requireAdmin } from '../_lib/adminAuth.mjs'
import { adminSeasonAction, createSeason, getSeason, getSeasons, isSupabaseConfigured } from '../_lib/supabaseBackend.mjs'

function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) }

export default async function handler(req, res) {
  if (!await requireAdmin(req, res)) return
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Season data is not configured.')
  try {
    if (req.method === 'GET') {
      const id = req.query?.id ? String(req.query.id) : ''
      return json(res, 200, { seasons: id ? [await getSeason(id)].filter(Boolean) : await getSeasons() })
    }
    const body = parseBody(req) || {}
    const id = String(body.id || req.query?.id || '')
    if (!validId(id)) return apiError(res, 400, 'INVALID_SEASON_ID', 'A valid season id is required.')
    if (req.method === 'POST' && !body.action) {
      const minimum = Number(body.minimumQualifyingVolume ?? 10)
      const rate = Number(body.basePointsPerUsd ?? 1)
      if (!body.name || !body.startAt || !body.endAt || !Number.isFinite(Date.parse(body.startAt)) || !Number.isFinite(Date.parse(body.endAt)) || Date.parse(body.endAt) <= Date.parse(body.startAt) || !Number.isFinite(minimum) || minimum < 0 || !Number.isFinite(rate) || rate < 0) return apiError(res, 400, 'INVALID_SEASON', 'Name, valid dates, and non-negative points configuration are required.')
      return json(res, 201, await createSeason({ id, name: String(body.name).trim(), description: String(body.description || ''), startAt: body.startAt, endAt: body.endAt, pointsEnabled: body.pointsEnabled !== false, minimum, rate, multiplierRules: Array.isArray(body.multiplierRules) ? body.multiplierRules : [] }))
    }
    const action = String(body.action || '')
    if (!['activate', 'end', 'freeze', 'archive'].includes(action)) return apiError(res, 400, 'INVALID_SEASON_ACTION', 'Unsupported season action.')
    return json(res, 200, await adminSeasonAction(id, action, String(req.headers['x-admin-id'] || 'admin')))
  } catch (error) {
    console.error('admin seasons API failed:', error?.message || error)
    const code = ['ACTIVE_SEASON_EXISTS', 'INVALID_SEASON', 'INVALID_SEASON_TRANSITION', 'INVALID_POINTS_CONFIGURATION'].includes(error?.message) ? error.message : 'SEASON_API_ERROR'
    const message = error?.message === 'ACTIVE_SEASON_EXISTS' ? 'Another season is already active.' : error?.message === 'INVALID_SEASON_TRANSITION' ? 'That season lifecycle transition is not allowed.' : 'Season operation failed.'
    return apiError(res, 400, code, message)
  }
}