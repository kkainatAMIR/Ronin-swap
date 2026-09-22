import { apiError, json, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import { isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'
import { getRewardsNetwork } from '../../api/_lib/solanaRewardsAdmin.mjs'

// In Vite dev SSR, process.env is not reliably populated — the env values
// are injected via globalThis.__RONIN_LOCAL_ENV__ by vite.config.js's
// localApiPlugin. Use the same runtimeEnv pattern as supabaseBackend.mjs
// and roninBackend.mjs so the handler reads the correct values regardless
// of whether it runs under Vite dev, Vercel, or plain Node (server.mjs).
const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

// Validates Solana base58 (32-44), EVM 0x... (40 hex).
function isValidWallet(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed) || /^0x[a-fA-F0-9]{40}$/.test(trimmed)
}

// GET /api/rewards/balance?wallet=<address>
// Returns: { earned_points, claimed_points, claimable_points, rewards_enabled,
//            has_active_season, active_season_id, reward_asset,
//            reward_points_per_unit, recent_claims[] }
//
// Thin service-role wrapper around the public.get_wallet_reward_balance()
// Postgres RPC. The RPC derives earned_points from samurai_points (the
// trusted source) — the frontend never sends earned points.
export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!(await rateLimitPersistent(req, 'rewards_balance', 60))) return apiError(res, 429, 'RATE_LIMITED', 'Too many requests. Try again shortly.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Rewards are not configured on the server.')

  const wallet = String(req.query?.wallet || '').trim()
  if (!isValidWallet(wallet)) return apiError(res, 400, 'INVALID_WALLET', 'A valid wallet address is required.')

  try {
    const response = await fetch(`${runtimeEnv.SUPABASE_URL}/rest/v1/rpc/get_wallet_reward_balance`, {
      method: 'POST',
      headers: {
        apikey: runtimeEnv.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${runtimeEnv.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ p_wallet_address: wallet }),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await response.text()
    let rpcBody
    try { rpcBody = text ? JSON.parse(text) : null } catch { rpcBody = null }

    if (!response.ok) {
      console.warn('rewards/balance RPC failed:', response.status, text?.slice(0, 200))
      return apiError(res, 502, 'REWARDS_BALANCE_ERROR', 'Unable to load reward balance.')
    }

    const result = Array.isArray(rpcBody) ? rpcBody[0] : rpcBody
    if (!result) {
      return json(res, 200, {
        wallet_address: wallet,
        earned_points: 0,
        claimed_points: 0,
        claimable_points: 0,
        rewards_enabled: false,
        has_active_season: false,
        active_season_id: null,
        reward_asset: 'SOL',
        reward_points_per_unit: 1000,
        recent_claims: [],
      })
    }

    // Numeric normalization so the frontend never has to deal with strings.
    return json(res, 200, {
      wallet_address: result.wallet_address,
      earned_points: Number(result.earned_points || 0),
      claimed_points: Number(result.claimed_points || 0),
      claimable_points: Number(result.claimable_points || 0),
      rewards_enabled: Boolean(result.rewards_enabled),
      has_active_season: Boolean(result.has_active_season),
      active_season_id: result.active_season_id || null,
      reward_asset: result.reward_asset || 'SOL',
      reward_points_per_unit: Number(result.reward_points_per_unit || 1000),
      // The Solana network the rewards program is deployed on
      // ('devnet' or 'mainnet-beta'). Used by the frontend to build
      // correct Solana explorer URLs (with ?cluster=devnet on Devnet).
      network: getRewardsNetwork(),
      recent_claims: Array.isArray(result.recent_claims) ? result.recent_claims.map((c) => ({
        ...c,
        points_claimed: Number(c.points_claimed || 0),
        reward_amount: Number(c.reward_amount || 0),
        conversion_rate: Number(c.conversion_rate || 0),
      })) : [],
    })
  } catch (error) {
    console.error('rewards/balance API failed:', error?.message || error)
    return apiError(res, 502, 'REWARDS_BALANCE_ERROR', 'Unable to load reward balance.')
  }
}
