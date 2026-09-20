import { apiError, json, parseBody, rateLimit } from '../../api/_lib/roninBackend.mjs'
import { getVerifiedSwapBySignature, awardSamuraiPoints, isSupabaseConfigured, createAbuseFlag, getSeasonForTimestamp, getAdminSettings } from '../../api/_lib/supabaseBackend.mjs'
import { calculateSamuraiPoints, getEffectivePointsConfiguration, getPointsConfiguration } from '../../api/_lib/samuraiPoints.mjs'

function isValidSignature(value) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(value)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'points', 30)) return apiError(res, 429, 'RATE_LIMITED', 'Too many points requests. Try again shortly.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Samurai Points are not configured on the server.')

  const body = parseBody(req)
  const signature = typeof body?.signature === 'string' ? body.signature.trim() : ''
  if (!isValidSignature(signature)) return apiError(res, 400, 'INVALID_SIGNATURE', 'A valid transaction signature is required.')

  try {
    const swap = await getVerifiedSwapBySignature(signature)
    if (!swap) return json(res, 409, { success: false, qualified: false, pointsAwarded: 0, reason: 'TRANSACTION_NOT_VERIFIED', signature })

    const season = await getSeasonForTimestamp(swap.timestamp)
    const savedSettings = await getAdminSettings().catch(() => null)
    const configuration = getEffectivePointsConfiguration(savedSettings)
    const calculation = await calculateSamuraiPoints(swap, configuration)
    const result = await awardSamuraiPoints({ signature, ...calculation, seasonId: season?.id || null })
    if (!result) return apiError(res, 502, 'POINTS_DATABASE_ERROR', 'The points result was not returned by the database.')

    // Lightweight, explainable post-processing. Flags never remove points.
    try {
      // Use the same runtimeEnv pattern as supabaseBackend.mjs — Vite dev SSR
      // does not reliably populate process.env, but globalThis.__RONIN_LOCAL_ENV__
      // is injected by vite.config.js's localApiPlugin.
      const pointsRuntimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env
      const recent = await fetch(`${pointsRuntimeEnv.SUPABASE_URL}/rest/v1/swap_transactions?wallet_address=eq.${encodeURIComponent(swap.wallet_address)}&verification_status=eq.verified&select=signature,input_mint,output_mint,input_amount_raw,timestamp&order=timestamp.desc&limit=8`, { headers: { apikey: pointsRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${pointsRuntimeEnv.SUPABASE_SERVICE_ROLE_KEY}` } }).then((response) => response.ok ? response.json() : [])
      const rapid = recent.filter((item) => Date.parse(swap.timestamp) - Date.parse(item.timestamp) >= 0 && Date.parse(swap.timestamp) - Date.parse(item.timestamp) <= 60_000).length >= 4
      const cycling = recent.slice(0, 4).length >= 4 && recent.slice(0, 4).every((item, index, items) => index === 0 || (item.input_mint === items[index - 1].output_mint && item.output_mint === items[index - 1].input_mint))
      const tiny = calculation.qualifyingVolumeUsd <= getPointsConfiguration().minimumQualifyingSwapUsd * 1.2 && recent.filter((item) => String(item.input_amount_raw) === String(swap.input_amount_raw)).length >= 3
      const flags = []
      if (rapid) flags.push(['ABNORMAL_TRANSACTION_FREQUENCY', 'medium'])
      if (cycling) flags.push(['TOKEN_CYCLING', 'medium'])
      if (tiny) flags.push(['MINIMUM_THRESHOLD_FARMING', 'low'])
      for (const [reason, severity] of flags) await createAbuseFlag({ wallet: swap.wallet_address, signature, reason, severity, details: { recentCount: recent.length } })
    } catch (antiAbuseError) {
      // Review telemetry must never block an already verified points result.
      console.warn('Samurai anti-abuse analysis unavailable:', antiAbuseError?.message || antiAbuseError)
    }

    return json(res, 200, {
      success: true,
      signature: result.signature,
      wallet: result.wallet_address,
      qualified: result.eligibility_status === 'qualified',
      qualifyingVolumeUsd: Number(result.qualifying_volume_usd || 0),
      pointsAwarded: Number(result.points_awarded || 0),
      basePoints: Number(result.base_points || 0),
      multiplier: Number(result.multiplier || 1),
      finalPoints: Number(result.final_points || result.points_awarded || 0),
      walletSeasonPoints: Number(result.season_points || 0),
      walletLifetimePoints: Number(result.lifetime_points || 0),
      seasonQualifyingVolumeUsd: Number(result.season_qualifying_volume_usd || 0),
      lifetimeQualifyingVolumeUsd: Number(result.lifetime_qualifying_volume_usd || 0),
      qualifyingSwapCount: Number(result.qualifying_swap_count || 0),
      reason: result.exclusion_reason || null,
      idempotent: result.inserted === false,
    })
  } catch (error) {
    console.error('Samurai Points processing failed:', error?.message || error)
    return apiError(res, error?.message === 'SUPABASE_NOT_CONFIGURED' ? 503 : 502, error?.message === 'TRANSACTION_NOT_VERIFIED' ? 'TRANSACTION_NOT_VERIFIED' : 'POINTS_DATABASE_ERROR', error?.message === 'TRANSACTION_NOT_VERIFIED' ? 'Only a verified transaction can receive Samurai Points.' : 'Samurai Points could not be processed.')
  }
}