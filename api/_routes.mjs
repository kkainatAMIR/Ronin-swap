// =====================================================================
// API Route Table
// =====================================================================
// Maps URL paths to handler modules. The gateway (api/index.mjs) uses
// this table to dispatch requests.
//
// IMPORTANT: This table must contain EVERY /api/* URL the frontend calls.
// If a URL is missing, the gateway returns 404.
//
// Routes are matched EXACTLY (path === key). Query strings are ignored
// during matching — they're passed through to the handler via req.query.
//
// The handler modules live under api_routes/ (outside api/ so Vercel
// doesn't count them as separate serverless functions).
//
// STATIC IMPORTS: We use static imports (not dynamic import()) because
// Vite's SSR module loader handles static imports more reliably. Dynamic
// import() can fail under Vite SSR due to path resolution differences.
// Static imports also guarantee all handlers are available immediately
// (no cold-start delay per route).
// =====================================================================

// ─── Static imports of all handler modules ───
import health from '../api_routes/health.mjs'
import leaderboard from '../api_routes/leaderboard.mjs'
import settings from '../api_routes/settings.mjs'
import trending from '../api_routes/trending.mjs'

import adminAuth from '../api_routes/admin/auth.mjs'
import adminDashboard from '../api_routes/admin/dashboard.mjs'
import adminSamurai from '../api_routes/admin/samurai.mjs'
import adminSeasons from '../api_routes/admin/seasons.mjs'
import adminRewardsStatus from '../api_routes/admin/rewards/status.mjs'
import adminRewardsSetPaused from '../api_routes/admin/rewards/set-paused.mjs'
import adminRewardsFundVault from '../api_routes/admin/rewards/fund-vault.mjs'
import adminRewardsWithdrawVault from '../api_routes/admin/rewards/withdraw-vault.mjs'

import burnBuild from '../api_routes/burn/build.mjs'
import burnPreview from '../api_routes/burn/preview.mjs'

import coingeckoSearch from '../api_routes/coingecko/search.mjs'

import evmQuote from '../api_routes/evm/quote.mjs'
import evmComplete from '../api_routes/evm/complete.mjs'

import jupiterQuote from '../api_routes/jupiter/quote.mjs'
import jupiterOrder from '../api_routes/jupiter/order.mjs'
import jupiterSwap from '../api_routes/jupiter/swap.mjs'
import jupiterExecute from '../api_routes/jupiter/execute.mjs'

import lifiConfig from '../api_routes/lifi/config.mjs'
import lifiQuote from '../api_routes/lifi/quote.mjs'
import lifiStatus from '../api_routes/lifi/status.mjs'
import lifiComplete from '../api_routes/lifi/complete.mjs'

import rewardsBalance from '../api_routes/rewards/balance.mjs'
import rewardsClaim from '../api_routes/rewards/claim.mjs'

import robinhoodTokens from '../api_routes/robinhood/tokens.mjs'
import robinhoodTrending from '../api_routes/robinhood/trending.mjs'

import roninStats from '../api_routes/ronin/stats.mjs'
import roninBurnHistory from '../api_routes/ronin/burn-history.mjs'
import roninShieldStats from '../api_routes/ronin/shield-stats.mjs'
import roninShieldContribution from '../api_routes/ronin/shield-contribution.mjs'

import samuraiSeason from '../api_routes/samurai/season.mjs'
import samuraiSeasons from '../api_routes/samurai/seasons.mjs'

import solanaRpc from '../api_routes/solana/rpc.mjs'
import solanaEnhanced from '../api_routes/solana/enhanced.mjs'

import swapHistory from '../api_routes/swap/history.mjs'
import swapVerify from '../api_routes/swap/verify.mjs'
import swapRecord from '../api_routes/swap/record.mjs'
import swapPoints from '../api_routes/swap/points.mjs'

// ─── Route table ───
// Keys are "METHOD /api/path". Values are the handler functions.
//
// Note: /api/admin/samurai/* routes all go to the SAME handler file
// (adminSamurai), which internally routes based on the last path segment.
// The gateway passes req.url unchanged, so the handler's
// `req.url.split('/').pop()` logic still works.
export const ROUTES = {
  // ─── Top-level ───
  'GET /api/health':            health,
  'GET /api/leaderboard':       leaderboard,
  'GET /api/settings':          settings,
  'GET /api/trending':          trending,

  // ─── Admin auth ───
  'POST /api/admin/auth':       adminAuth,
  'GET /api/admin/auth':        adminAuth,

  // ─── Admin dashboard (resource-routed via ?resource=) ───
  'GET /api/admin/dashboard':   adminDashboard,
  'PATCH /api/admin/dashboard': adminDashboard,
  'POST /api/admin/dashboard':  adminDashboard,

  // ─── Admin samurai review (resource-routed via last path segment) ───
  'GET /api/admin/samurai':              adminSamurai,
  'POST /api/admin/samurai':             adminSamurai,
  'GET /api/admin/samurai/flags':        adminSamurai,
  'GET /api/admin/samurai/transactions': adminSamurai,
  'GET /api/admin/samurai/wallet':       adminSamurai,
  'POST /api/admin/samurai/flag':        adminSamurai,
  'POST /api/admin/samurai/exclude':     adminSamurai,
  'POST /api/admin/samurai/restore':     adminSamurai,
  'POST /api/admin/samurai/recalculate': adminSamurai,

  // ─── Admin seasons ───
  'GET /api/admin/seasons':                adminSeasons,
  'POST /api/admin/seasons':               adminSeasons,
  'GET /api/admin/samurai/seasons':        adminSeasons,
  'POST /api/admin/samurai/seasons':       adminSeasons,
  'POST /api/admin/samurai/season-action': adminSeasons,

  // ─── Admin rewards (on-chain Solana program management) ───
  'GET /api/admin/rewards/status':          adminRewardsStatus,
  'POST /api/admin/rewards/set-paused':     adminRewardsSetPaused,
  'POST /api/admin/rewards/fund-vault':     adminRewardsFundVault,
  'POST /api/admin/rewards/withdraw-vault': adminRewardsWithdrawVault,

  // ─── Burn (Sol Incinerator proxy) ───
  'POST /api/burn/build':   burnBuild,
  'POST /api/burn/preview': burnPreview,

  // ─── CoinGecko ───
  'GET /api/coingecko/search': coingeckoSearch,

  // ─── EVM (0x / Ethereum) ───
  'POST /api/evm/quote':    evmQuote,
  'POST /api/evm/complete': evmComplete,

  // ─── Jupiter (Solana swap) ───
  'GET /api/jupiter/quote':    jupiterQuote,
  'GET /api/jupiter/order':    jupiterOrder,
  'POST /api/jupiter/swap':    jupiterSwap,
  'POST /api/jupiter/execute': jupiterExecute,

  // ─── LI.FI (cross-chain) ───
  'GET /api/lifi/config':    lifiConfig,
  'POST /api/lifi/quote':    lifiQuote,
  'POST /api/lifi/status':   lifiStatus,
  'POST /api/lifi/complete': lifiComplete,

  // ─── Rewards (claim flow) ───
  'GET /api/rewards/balance': rewardsBalance,
  'POST /api/rewards/claim':  rewardsClaim,

  // ─── Robinhood Chain ───
  'GET /api/robinhood/tokens':   robinhoodTokens,
  'GET /api/robinhood/trending': robinhoodTrending,

  // ─── Ronin stats ───
  'GET /api/ronin/stats':                roninStats,
  'GET /api/ronin/burn-history':         roninBurnHistory,
  'GET /api/ronin/shield-stats':         roninShieldStats,
  'POST /api/ronin/shield-contribution': roninShieldContribution,

  // ─── Samurai seasons (public) ───
  'GET /api/samurai/season/current': samuraiSeason,
  'GET /api/samurai/seasons':        samuraiSeasons,

  // ─── Solana RPC proxy ───
  'POST /api/solana/rpc': solanaRpc,
  'GET /api/solana/enhanced': solanaEnhanced,

  // ─── Swap ───
  'GET /api/swap/history':  swapHistory,
  'POST /api/swap/verify':  swapVerify,
  'POST /api/swap/record':  swapRecord,
  'POST /api/swap/points':  swapPoints,
}

// Look up a route by method + path. Returns the handler function or null.
export function matchRoute(method, pathname) {
  const key = `${method} ${pathname}`
  return ROUTES[key] || null
}
