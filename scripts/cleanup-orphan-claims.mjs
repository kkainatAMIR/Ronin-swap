// =====================================================================
// scripts/cleanup-orphan-claims.mjs
// =====================================================================
// Reverts reward_claims rows stuck in ENTITLED state for longer than
// the configured TTL (default 5 minutes).
//
// An ENTITLED claim is "orphaned" when:
//   - The user called /api/rewards/claim-prepare (created the ENTITLED row)
//   - But never completed the flow (Phantom popup rejected, browser closed,
//     network died, user navigated away, etc.)
//   - And never called /api/rewards/claim-cancel to revert it
//
// Without this cleanup, orphaned claims would permanently lock the user's
// claimed_points (since claimed_points was incremented at ENTITLED time).
//
// Run as a cron job (recommended: every 5 minutes):
//   */5 * * * * cd /path/to/repo && node scripts/cleanup-orphan-claims.mjs
//
// Or via Vercel Cron by adding a /api/admin/rewards/cleanup orphan
// endpoint that calls this logic.
//
// Safe to run multiple times — revert_failed_reward_claim is idempotent
// on already-FAILED rows.
// =====================================================================

import dotenv from 'dotenv'
dotenv.config({ path: '.env.local', override: true })

const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env
const SUPABASE_URL = String(runtimeEnv.SUPABASE_URL || '').replace(/\/$/, '')
const SUPABASE_SERVICE_ROLE_KEY = String(runtimeEnv.SUPABASE_SERVICE_ROLE_KEY || '')
const ORPHAN_TTL_MINUTES = Number(runtimeEnv.ORPHAN_CLAIM_TTL_MINUTES || 5)

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.')
  process.exit(1)
}

async function callSupabaseRpc(name, params) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!response.ok) {
    const err = new Error(body?.message || body?.error || `RPC ${name} failed`)
    err.code = body?.message ? String(body.message).split('\n')[0] : 'RPC_FAILED'
    err.body = body
    err.status = response.status
    throw err
  }
  return Array.isArray(body) ? body[0] : body
}

async function fetchOrphanedClaims(ttlMinutes) {
  // Query reward_claims for ENTITLED rows older than ttlMinutes.
  const cutoffIso = new Date(Date.now() - ttlMinutes * 60_000).toISOString()
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/reward_claims?status=eq.ENTITLED&created_at=lt.${encodeURIComponent(cutoffIso)}&select=claim_id,points_claimed,wallet_address,created_at`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to fetch orphaned claims: ${response.status} ${text}`)
  }
  return await response.json()
}

async function main() {
  console.log(`[cleanup-orphan-claims] starting — TTL=${ORPHAN_TTL_MINUTES} minutes`)

  const orphans = await fetchOrphanedClaims(ORPHAN_TTL_MINUTES)
  if (!Array.isArray(orphans) || orphans.length === 0) {
    console.log('[cleanup-orphan-claims] no orphaned ENTITLED claims found.')
    return
  }

  console.log(`[cleanup-orphan-claims] found ${orphans.length} orphaned claim(s):`)
  let reverted = 0
  let failed = 0
  for (const claim of orphans) {
    const ageSec = Math.round((Date.now() - Date.parse(claim.created_at)) / 1000)
    try {
      const result = await callSupabaseRpc('revert_failed_reward_claim', {
        p_claim_id: claim.claim_id,
        p_failure_reason: `ORPHAN_CLEANUP: claim stuck in ENTITLED for ${ageSec}s`,
      })
      if (result?.reverted) {
        console.log(`  ✓ reverted ${claim.claim_id} (age ${ageSec}s, points restored: ${claim.points_claimed})`)
        reverted++
      } else if (result?.reason === 'ALREADY_FAILED') {
        // Idempotent — already reverted by something else.
        console.log(`  • ${claim.claim_id} already reverted (idempotent skip)`)
      } else {
        console.log(`  ? ${claim.claim_id} returned unexpected state: ${result?.reason || JSON.stringify(result)}`)
      }
    } catch (error) {
      // CANNOT_REVERT_COMPLETED means the user actually completed the
      // claim after we fetched the list — not an error, just a race.
      if (String(error?.code || error?.message || '').includes('CANNOT_REVERT_COMPLETED')) {
        console.log(`  • ${claim.claim_id} completed during cleanup (race) — skipping`)
        continue
      }
      console.error(`  ✗ failed to revert ${claim.claim_id}: ${error?.message || error}`)
      failed++
    }
  }

  console.log(`[cleanup-orphan-claims] done — reverted ${reverted}, failed ${failed}, total processed ${orphans.length}`)
  if (failed > 0) process.exit(2)
}

main().catch((error) => {
  console.error('[cleanup-orphan-claims] fatal error:', error?.message || error)
  process.exit(1)
})
