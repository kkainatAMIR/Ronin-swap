import { apiError, json } from '../../api/_lib/roninBackend.mjs'
import { getPublicSeasons, isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Season data is not configured.')
  try {
    const seasons = await getPublicSeasons()
    return json(res, 200, { seasons: (Array.isArray(seasons) ? seasons : []).map((season) => ({
      id: season.id,
      name: season.name,
      description: season.description,
      startAt: season.start_at,
      endAt: season.end_at,
      status: season.status,
      leaderboardEnabled: season.leaderboard_enabled,
      finalWalletCount: season.final_wallet_count,
      finalTransactionCount: season.final_transaction_count,
      finalVolume: season.final_volume,
      finalPoints: season.final_points,
      frozenAt: season.frozen_at,
    })) })
  } catch (error) {
    console.error('historical seasons query failed:', error?.message || error)
    return apiError(res, 502, 'SEASON_ERROR', 'Unable to load seasons.')
  }
}