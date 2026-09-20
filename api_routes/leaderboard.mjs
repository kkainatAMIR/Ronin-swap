import { apiError, json, rateLimit } from '../api/_lib/roninBackend.mjs'
import { getLeaderboard, getLeaderboardWalletStats, isSupabaseConfigured } from '../api/_lib/supabaseBackend.mjs'

const PERIODS = new Set(['daily', 'weekly', 'monthly', 'season', 'all-time'])

function isValidWallet(value) {
  return typeof value === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) || /^0x[0-9a-fA-F]{40}$/.test(value))
}

function integer(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : fallback
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'leaderboard', 60)) return apiError(res, 429, 'RATE_LIMITED', 'Too many leaderboard requests. Try again shortly.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Leaderboard is not configured on the server.')

  const period = String(req.query?.period || 'season')
  if (!PERIODS.has(period)) return apiError(res, 400, 'INVALID_PERIOD', 'period must be daily, weekly, monthly, season, or all-time.')
  const page = integer(req.query?.page, 1)
  const limit = integer(req.query?.limit, 25)
  if (page < 1 || limit < 1 || limit > 100) return apiError(res, 400, 'INVALID_PAGINATION', 'page must be at least 1 and limit must be between 1 and 100.')
  const seasonId = String(req.query?.seasonId || process.env.SAMURAI_CURRENT_SEASON_ID || '').trim() || null
  const wallet = req.query?.wallet ? String(req.query.wallet).trim() : null
  if (wallet && !isValidWallet(wallet)) return apiError(res, 400, 'INVALID_WALLET', 'wallet must be a valid Solana or Ethereum address.')

  try {
    const [rows, walletStats] = await Promise.all([
      getLeaderboard({ period, seasonId, page, limit }),
      wallet ? getLeaderboardWalletStats(wallet, seasonId) : Promise.resolve(null),
    ])
    const entries = (Array.isArray(rows) ? rows : []).map((row) => ({
      rank: Number(row.rank),
      wallet: row.wallet,
      verifiedVolume: Number(row.verified_volume || 0),
      samuraiPoints: Number(row.samurai_points || 0),
      qualifyingSwaps: Number(row.qualifying_swaps || 0),
    }))
    return json(res, 200, {
      period,
      seasonId,
      entries,
      pagination: { page, limit, total: Number(rows?.[0]?.total_count || 0) },
      wallet: walletStats ? {
        wallet: walletStats.wallet,
        lifetimePoints: Number(walletStats.lifetime_points || 0),
        lifetimeVolume: Number(walletStats.lifetime_volume || 0),
        lifetimeSwaps: Number(walletStats.lifetime_swaps || 0),
        seasonPoints: Number(walletStats.season_points || 0),
        seasonVolume: Number(walletStats.season_volume || 0),
        seasonSwaps: Number(walletStats.season_swaps || 0),
        currentRank: walletStats.current_rank == null ? null : Number(walletStats.current_rank),
      } : null,
    })
  } catch (error) {
    console.error('leaderboard query failed:', error?.message || error)
    return apiError(res, 502, 'LEADERBOARD_ERROR', 'Unable to load leaderboard.')
  }
}