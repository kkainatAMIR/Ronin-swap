// Temporary debug endpoint to see what env values Vite passes to API handlers.
//
// Add this to vite.config.js LOCAL_API_HANDLERS:
//   '/api/debug-env': '/api/debug-env.mjs',
//
// Then visit: http://localhost:5173/api/debug-env
//
// It prints the env values that the balance handler sees, so we can compare
// them to what `node scripts/test-balance-handler.mjs` sees.

import { json } from '../_lib/roninBackend.mjs'

export default function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' })

  // These are the EXACT values api/rewards/balance.mjs reads via process.env
  const supabaseUrl = process.env.SUPABASE_URL || ''
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

  // Also check globalThis.__RONIN_LOCAL_ENV__ (set by Vite's localApiPlugin)
  const localEnv = globalThis.__RONIN_LOCAL_ENV__ || null

  return json(res, 200, {
    // What balance.mjs sees via process.env:
    processEnv: {
      SUPABASE_URL: supabaseUrl ? `${supabaseUrl.slice(0, 30)}... (length=${supabaseUrl.length})` : '(empty)',
      SUPABASE_URL_raw: supabaseUrl,
      SUPABASE_URL_hex_last10: Buffer.from(supabaseUrl.slice(-10)).toString('hex'),
      SUPABASE_SERVICE_ROLE_KEY: supabaseKey ? `${supabaseKey.slice(0, 20)}...${supabaseKey.slice(-10)} (length=${supabaseKey.length})` : '(empty)',
      SUPABASE_SERVICE_ROLE_KEY_hex_last10: Buffer.from(supabaseKey.slice(-10)).toString('hex'),
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || '(empty)',
      SOLANA_REWARDS_NETWORK: process.env.SOLANA_REWARDS_NETWORK || '(empty)',
      SOLANA_REWARDS_PROGRAM_ID: process.env.SOLANA_REWARDS_PROGRAM_ID || '(empty, will use default)',
      SOLANA_REWARDS_ADMIN_SECRET_KEY: process.env.SOLANA_REWARDS_ADMIN_SECRET_KEY ? `[SET, ${process.env.SOLANA_REWARDS_ADMIN_SECRET_KEY.length} chars]` : '(empty)',
      SOLANA_REWARDS_ADMIN_KEYPAIR: process.env.SOLANA_REWARDS_ADMIN_KEYPAIR ? '[SET - REMOVE THIS]' : '(not set)',
    },
    // What supabaseBackend.mjs sees via globalThis.__RONIN_LOCAL_ENV__:
    localEnv: localEnv ? {
      SUPABASE_URL: localEnv.SUPABASE_URL ? `${String(localEnv.SUPABASE_URL).slice(0, 30)}... (length=${String(localEnv.SUPABASE_URL).length})` : '(empty)',
      SUPABASE_SERVICE_ROLE_KEY: localEnv.SUPABASE_SERVICE_ROLE_KEY ? `[SET, ${String(localEnv.SUPABASE_SERVICE_ROLE_KEY).length} chars]` : '(empty)',
    } : '(not set - Vite did not inject __RONIN_LOCAL_ENV__)',
    // Whether isSupabaseConfigured() would return true:
    supabaseConfigured: Boolean(supabaseUrl && supabaseKey),
    // Node version + platform for debugging
    runtime: {
      node: process.version,
      platform: process.platform,
      cwd: process.cwd(),
    },
  })
}
