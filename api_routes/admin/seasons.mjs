import { apiError, json, parseBody } from '../../api/_lib/roninBackend.mjs'
import { requireAdmin } from '../../api/_lib/adminAuth.mjs'
import { adminSeasonAction, createSeason, getSeason, getSeasonRewardClaimReport, getSeasons, isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'

function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) }

function parseRewardPool(body) {
  const amount = String(body.rewardPoolAmount ?? body.poolAmount ?? '').trim()
  const claimWindowStart = body.claimWindowStart
  const claimWindowEnd = body.claimWindowEnd
  if (!/^(?:0|[1-9]\d{0,28})(?:\.\d{1,9})?$/.test(amount)
    || !claimWindowStart || !claimWindowEnd
    || !Number.isFinite(Date.parse(claimWindowStart))
    || !Number.isFinite(Date.parse(claimWindowEnd))
    || Date.parse(claimWindowEnd) <= Date.parse(claimWindowStart)) {
    throw new Error('INVALID_REWARD_POOL')
  }
  const [whole, fraction = ''] = amount.split('.')
  if (BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0') || '0') <= 0n) {
    throw new Error('INVALID_REWARD_POOL')
  }
  return {
    amount,
    claimWindowStart: new Date(claimWindowStart).toISOString(),
    claimWindowEnd: new Date(claimWindowEnd).toISOString(),
  }
}

function parseClaimWindowEnd(value) {
  const timestamp = Date.parse(value)
  if (!value || !Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error('INVALID_CLAIM_WINDOW_END')
  }
  return new Date(timestamp).toISOString()
}

export function parseSeasonRestart(body) {
  const endAt = Date.parse(body.endAt)
  const claimWindowStart = Date.parse(body.claimWindowStart)
  const claimWindowEnd = Date.parse(body.claimWindowEnd)
  if (!Number.isFinite(endAt) || endAt <= Date.now()
    || !Number.isFinite(claimWindowStart) || claimWindowStart < endAt
    || !Number.isFinite(claimWindowEnd) || claimWindowEnd <= claimWindowStart) {
    throw new Error('INVALID_SEASON_RESTART_DATES')
  }
  return {
    endAt: new Date(endAt).toISOString(),
    claimWindowStart: new Date(claimWindowStart).toISOString(),
    claimWindowEnd: new Date(claimWindowEnd).toISOString(),
  }
}

export function parseSeasonMinimum(value) {
  const minimum = Number(value)
  if (value == null || value === '' || !Number.isFinite(minimum) || minimum < 0) {
    throw new Error('INVALID_SEASON_MINIMUM')
  }
  return minimum
}

export default async function handler(req, res) {
  if (!await requireAdmin(req, res)) return
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Season data is not configured.')
  try {
    if (req.method === 'GET') {
      const id = req.query?.id ? String(req.query.id) : ''
      if (id && req.query?.report === 'claims') {
        return json(res, 200, { claimReport: await getSeasonRewardClaimReport(id) })
      }
      return json(res, 200, { seasons: id ? [await getSeason(id)].filter(Boolean) : await getSeasons() })
    }
    const body = parseBody(req) || {}
    const id = String(body.id || req.query?.id || '')
    if (!validId(id)) return apiError(res, 400, 'INVALID_SEASON_ID', 'A valid season id is required.')
    if (req.method === 'POST' && !body.action) {
      const minimum = body.minimumQualifyingVolume == null
        ? 10
        : parseSeasonMinimum(body.minimumQualifyingVolume)
      const rate = Number(body.basePointsPerUsd ?? 1)
      if (!body.name || !body.startAt || !body.endAt || !Number.isFinite(Date.parse(body.startAt)) || !Number.isFinite(Date.parse(body.endAt)) || Date.parse(body.endAt) <= Date.parse(body.startAt) || !Number.isFinite(minimum) || minimum < 0 || !Number.isFinite(rate) || rate < 0) return apiError(res, 400, 'INVALID_SEASON', 'Name, valid dates, and non-negative points configuration are required.')
      const rewardPool = body.rewardPoolAmount == null || body.rewardPoolAmount === ''
        ? null
        : parseRewardPool(body)
      return json(res, 201, await createSeason({ id, name: String(body.name).trim(), description: String(body.description || ''), startAt: body.startAt, endAt: body.endAt, pointsEnabled: body.pointsEnabled !== false, minimum, rate, multiplierRules: Array.isArray(body.multiplierRules) ? body.multiplierRules : [], ...(rewardPool ? { rewardPoolAmount: rewardPool.amount, claimWindowStart: rewardPool.claimWindowStart, claimWindowEnd: rewardPool.claimWindowEnd } : {}) }))
    }
    const action = String(body.action || '')
    if (!['activate', 'end', 'freeze', 'archive', 'unarchive', 'configure_rewards', 'finalize_rewards', 'extend_claim_window', 'restart_finalized', 'update_minimum'].includes(action)) return apiError(res, 400, 'INVALID_SEASON_ACTION', 'Unsupported season action.')
    const rewardPool = action === 'configure_rewards'
      ? parseRewardPool(body)
      : action === 'extend_claim_window'
        ? { claimWindowEnd: parseClaimWindowEnd(body.claimWindowEnd) }
        : action === 'restart_finalized'
          ? parseSeasonRestart(body)
          : action === 'update_minimum'
            ? { minimumQualifyingVolume: parseSeasonMinimum(body.minimumQualifyingVolume) }
          : null
    return json(res, 200, await adminSeasonAction(id, action, String(req.headers['x-admin-id'] || 'admin'), rewardPool))
  } catch (error) {
    console.error('admin seasons API failed:', {
      message: error?.message || error,
      status: error?.status || null,
      databaseCode: error?.body?.code || null,
      databaseDetails: error?.body?.details || null,
      databaseHint: error?.body?.hint || null,
    })
    const knownErrors = [
      'ACTIVE_SEASON_EXISTS',
      'INVALID_SEASON',
      'INVALID_SEASON_TRANSITION',
      'INVALID_POINTS_CONFIGURATION',
      'INVALID_REWARD_POOL',
      'REWARD_POOL_NOT_CONFIGURABLE',
      'REWARD_POOL_NOT_CONFIGURED',
      'SEASON_NOT_ENDED',
      'SEASON_NOT_FROZEN',
      'SEASON_NOT_FOUND',
      'CLAIM_WINDOW_NOT_EXTENDABLE',
      'INVALID_CLAIM_WINDOW_END',
      'INVALID_SEASON_RESTART_DATES',
      'INVALID_SEASON_MINIMUM',
      'SEASON_NOT_RESTARTABLE',
      'SEASON_RESTART_CLAIMS_EXIST',
    ]
    const databaseMessage = String(error?.body?.message || error?.message || '')
    const raisedCode = knownErrors.find((known) => databaseMessage.includes(known))
    const sqlState = /^[0-9A-Z]{5}$/.test(String(error?.body?.code || '')) ? `DATABASE_${error.body.code}` : null
    const code = raisedCode || sqlState || 'SEASON_API_ERROR'
    const safeDatabaseMessage = sqlState
      ? String(error?.body?.message || error?.body?.details || '')
        .replace(/\s+/g, ' ')
        .slice(0, 240)
      : ''
    const knownMessages = {
      ACTIVE_SEASON_EXISTS: 'Another season is already active.',
      INVALID_SEASON_TRANSITION: 'That season lifecycle transition is not allowed.',
      INVALID_REWARD_POOL: 'Enter a positive SOL pool and a valid claim window.',
      REWARD_POOL_NOT_CONFIGURABLE: 'A reward pool can only be configured once while the season is a draft.',
      REWARD_POOL_NOT_CONFIGURED: 'Configure a SOL reward pool before finalizing.',
      SEASON_NOT_ENDED: 'End the season before finalizing its reward allocation.',
      SEASON_NOT_FROZEN: 'Freeze the season snapshot before finalizing its reward allocation.',
      SEASON_NOT_FOUND: 'The requested season no longer exists.',
      INVALID_CLAIM_WINDOW_END: 'Choose a future claim deadline.',
      CLAIM_WINDOW_NOT_EXTENDABLE: 'The claim window can only be extended for a finalized season, and the new deadline must be later than the current one.',
      INVALID_SEASON_RESTART_DATES: 'Choose a future season end, then a claim window starting on or after that end.',
      SEASON_NOT_RESTARTABLE: 'Only an ended, frozen, or archived finalized season can be restarted.',
      SEASON_RESTART_CLAIMS_EXIST: 'This season has a paid or in-progress reward claim and cannot be restarted.',
    }
    const message = knownMessages[raisedCode]
      || (sqlState
        ? `The database rejected the season operation (${sqlState})${safeDatabaseMessage ? `: ${safeDatabaseMessage}` : ''}.`
        : 'Season operation failed.')
    return apiError(res, knownErrors.includes(code) ? 400 : 500, code, message)
  }
}