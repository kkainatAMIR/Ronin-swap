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
// =====================================================================

// Lazy-loaded handler cache. Each handler is imported on first use,
// then cached. This keeps cold-start fast (only loads what's needed)
// and avoids circular-import issues at module load time.
const _cache = new Map()

async function load(modulePath) {
  if (_cache.has(modulePath)) return _cache.get(modulePath)
  const mod = await import(modulePath)
  const handler = mod.default
  _cache.set(modulePath, handler)
  return handler
}

// Route table. Keys are exact URL paths (without query string).
// Values are async loader functions that return the handler.
//
// Note: /api/admin/samurai/* routes all go to the SAME handler file
// (api_routes/admin/samurai.mjs), which internally routes based on
// the last path segment. The gateway passes req.url unchanged, so
// the handler's `req.url.split('/').pop()` logic still works.
export const ROUTES = {
  // ─── Top-level ───
  'GET /api/health':            () => load('../api_routes/health.mjs'),
  'GET /api/leaderboard':       () => load('../api_routes/leaderboard.mjs'),
  'GET /api/settings':          () => load('../api_routes/settings.mjs'),
  'GET /api/trending':          () => load('../api_routes/trending.mjs'),

  // ─── Admin auth ───
  'POST /api/admin/auth':       () => load('../api_routes/admin/auth.mjs'),
  'GET /api/admin/auth':        () => load('../api_routes/admin/auth.mjs'),

  // ─── Admin dashboard (resource-routed via ?resource=) ───
  'GET /api/admin/dashboard':   () => load('../api_routes/admin/dashboard.mjs'),
  'PATCH /api/admin/dashboard': () => load('../api_routes/admin/dashboard.mjs'),
  'POST /api/admin/dashboard':  () => load('../api_routes/admin/dashboard.mjs'),

  // ─── Admin samurai review (resource-routed via last path segment) ───
  // All these URLs go to the same handler file, which parses req.url
  // internally to determine the resource (flags/transactions/wallet/etc).
  'GET /api/admin/samurai':              () => load('../api_routes/admin/samurai.mjs'),
  'POST /api/admin/samurai':             () => load('../api_routes/admin/samurai.mjs'),
  'GET /api/admin/samurai/flags':        () => load('../api_routes/admin/samurai.mjs'),
  'GET /api/admin/samurai/transactions': () => load('../api_routes/admin/samurai.mjs'),
  'GET /api/admin/samurai/wallet':       () => load('../api_routes/admin/samurai.mjs'),
  'POST /api/admin/samurai/flag':        () => load('../api_routes/admin/samurai.mjs'),
  'POST /api/admin/samurai/exclude':     () => load('../api_routes/admin/samurai.mjs'),
  'POST /api/admin/samurai/restore':     () => load('../api_routes/admin/samurai.mjs'),
  'POST /api/admin/samurai/recalculate': () => load('../api_routes/admin/samurai.mjs'),

  // ─── Admin seasons ───
  // /api/admin/seasons and /api/admin/samurai/seasons both go to the
  // same handler (backwards-compat URLs preserved from vite.config.js).
  'GET /api/admin/seasons':              () => load('../api_routes/admin/seasons.mjs'),
  'POST /api/admin/seasons':             () => load('../api_routes/admin/seasons.mjs'),
  'GET /api/admin/samurai/seasons':      () => load('../api_routes/admin/seasons.mjs'),
  'POST /api/admin/samurai/seasons':     () => load('../api_routes/admin/seasons.mjs'),
  'POST /api/admin/samurai/season-action': () => load('../api_routes/admin/seasons.mjs'),

  // ─── Admin rewards (on-chain Solana program management) ───
  'GET /api/admin/rewards/status':         () => load('../api_routes/admin/rewards/status.mjs'),
  'POST /api/admin/rewards/set-paused':    () => load('../api_routes/admin/rewards/set-paused.mjs'),
  'POST /api/admin/rewards/fund-vault':    () => load('../api_routes/admin/rewards/fund-vault.mjs'),
  'POST /api/admin/rewards/withdraw-vault': () => load('../api_routes/admin/rewards/withdraw-vault.mjs'),

  // ─── Burn (Sol Incinerator proxy) ───
  'POST /api/burn/build':   () => load('../api_routes/burn/build.mjs'),
  'POST /api/burn/preview': () => load('../api_routes/burn/preview.mjs'),

  // ─── CoinGecko ───
  'GET /api/coingecko/search': () => load('../api_routes/coingecko/search.mjs'),

  // ─── EVM (0x / Ethereum) ───
  'POST /api/evm/quote':    () => load('../api_routes/evm/quote.mjs'),
  'POST /api/evm/complete': () => load('../api_routes/evm/complete.mjs'),

  // ─── Jupiter (Solana swap) ───
  'GET /api/jupiter/quote':  () => load('../api_routes/jupiter/quote.mjs'),
  'GET /api/jupiter/order':  () => load('../api_routes/jupiter/order.mjs'),
  'POST /api/jupiter/swap':  () => load('../api_routes/jupiter/swap.mjs'),
  'POST /api/jupiter/execute': () => load('../api_routes/jupiter/execute.mjs'),

  // ─── LI.FI (cross-chain) ───
  'GET /api/lifi/config':   () => load('../api_routes/lifi/config.mjs'),
  'POST /api/lifi/quote':   () => load('../api_routes/lifi/quote.mjs'),
  'POST /api/lifi/status':  () => load('../api_routes/lifi/status.mjs'),
  'POST /api/lifi/complete': () => load('../api_routes/lifi/complete.mjs'),

  // ─── Rewards (claim flow) ───
  'GET /api/rewards/balance': () => load('../api_routes/rewards/balance.mjs'),
  'POST /api/rewards/claim':  () => load('../api_routes/rewards/claim.mjs'),

  // ─── Robinhood Chain ───
  'GET /api/robinhood/tokens':   () => load('../api_routes/robinhood/tokens.mjs'),
  'GET /api/robinhood/trending': () => load('../api_routes/robinhood/trending.mjs'),

  // ─── Ronin stats ───
  'GET /api/ronin/stats':               () => load('../api_routes/ronin/stats.mjs'),
  'GET /api/ronin/burn-history':        () => load('../api_routes/ronin/burn-history.mjs'),
  'GET /api/ronin/shield-stats':        () => load('../api_routes/ronin/shield-stats.mjs'),
  'POST /api/ronin/shield-contribution': () => load('../api_routes/ronin/shield-contribution.mjs'),

  // ─── Samurai seasons (public) ───
  // /api/samurai/season/current → season.mjs (note the URL has /current
  // but the file is season.mjs — this is preserved from the original
  // vite.config.js LOCAL_API_HANDLERS mapping)
  'GET /api/samurai/season/current': () => load('../api_routes/samurai/season.mjs'),
  'GET /api/samurai/seasons':        () => load('../api_routes/samurai/seasons.mjs'),

  // ─── Solana RPC proxy ───
  'POST /api/solana/rpc': () => load('../api_routes/solana/rpc.mjs'),

  // ─── Swap ───
  'GET /api/swap/history':  () => load('../api_routes/swap/history.mjs'),
  'POST /api/swap/verify':  () => load('../api_routes/swap/verify.mjs'),
  'POST /api/swap/record':  () => load('../api_routes/swap/record.mjs'),
  'POST /api/swap/points':  () => load('../api_routes/swap/points.mjs'),
}

// Look up a route by method + path. Returns the handler loader or null.
export function matchRoute(method, pathname) {
  const key = `${method} ${pathname}`
  return ROUTES[key] || null
}
