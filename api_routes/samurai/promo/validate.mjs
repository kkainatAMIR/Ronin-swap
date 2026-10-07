import { apiError, json, parseBody, rateLimit } from '../../../api/_lib/roninBackend.mjs'
import { getAdminSettings, isSupabaseConfigured } from '../../../api/_lib/supabaseBackend.mjs'
import { getEffectivePointsConfiguration, resolveSamuraiPointCampaign } from '../../../api/_lib/samuraiPoints.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'promo-validate', 30)) return apiError(res, 429, 'RATE_LIMITED', 'Too many promo validation requests.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Promo validation is not configured.')

  const body = parseBody(req) || {}
  const promoCode = typeof body.promoCode === 'string' ? body.promoCode.trim() : ''
  const chainId = Number(body.chainId)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(promoCode)) return apiError(res, 400, 'INVALID_PROMO_CODE', 'Enter a valid promo code.')
  if (!Number.isInteger(chainId) || chainId <= 0) return apiError(res, 400, 'INVALID_CHAIN', 'A valid chain ID is required.')
  if (typeof body.inputMint !== 'string' || !body.inputMint.trim() || typeof body.outputMint !== 'string' || !body.outputMint.trim()) {
    return apiError(res, 400, 'INVALID_PAIR', 'A valid input and output token pair is required.')
  }

  try {
    const savedSettings = await getAdminSettings()
    const configuration = getEffectivePointsConfiguration(savedSettings)
    const swap = {
      chain_id: chainId,
      input_mint: body.inputMint.trim(),
      output_mint: body.outputMint.trim(),
      timestamp: new Date().toISOString(),
    }
    const resolved = resolveSamuraiPointCampaign(swap, configuration, promoCode, swap.timestamp)
    if (!resolved.campaign) return json(res, 200, { valid: false, reason: resolved.reason || 'INVALID_PROMO_CODE' })

    return json(res, 200, {
      valid: true,
      campaign: {
        id: resolved.campaign.id || null,
        name: resolved.campaign.name || null,
        promoCode: resolved.campaign.promoCode || promoCode.toUpperCase(),
        multiplier: resolved.multiplier,
        startDate: resolved.campaign.startDate || resolved.campaign.start_at || null,
        endDate: resolved.campaign.endDate || resolved.campaign.end_at || null,
      },
      note: 'Eligibility is checked again against the verified transaction before Samurai Points are awarded.',
    })
  } catch (error) {
    console.error('Samurai promo validation failed:', error?.message || error)
    return apiError(res, 502, 'PROMO_VALIDATION_FAILED', 'Promo validation is temporarily unavailable.')
  }
}
