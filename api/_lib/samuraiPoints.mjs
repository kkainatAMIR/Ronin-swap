import { fetchJupiter, JUPITER_TIMEOUT_MS, RONIN_MINT } from './roninBackend.mjs'
import { getEvmUsdPrice } from './ethereum.mjs'

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

function normalizeMint(value) {
  return String(value || '').trim().toLowerCase()
}

function asFiniteNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback
  return String(value).toLowerCase() !== 'false'
}

function parseOptionalNumber(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function parseCampaigns(value) {
  if (!value) return []
  try {
    const campaigns = JSON.parse(value)
    return Array.isArray(campaigns) ? campaigns : []
  } catch {
    return []
  }
}

function hasExplicitEnvValue(name) {
  const value = runtimeEnv[name]
  return value !== undefined && value !== null && value !== ''
}

function envNumber(name, fallback) {
  const value = runtimeEnv[name]
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function getPointsConfiguration() {
  const configuredRate = envNumber('SAMURAI_POINTS_PER_DOLLAR', 1)
  const configuredMinimum = envNumber('SAMURAI_MINIMUM_QUALIFYING_SWAP_USD', envNumber('SAMURAI_MINIMUM_QUALIFYING_SWAP', 0))
  const roninBuyMultiplier = envNumber('SAMURAI_RONIN_BUY_MULTIPLIER', envNumber('RONIN_BUY_MULTIPLIER', 2))
  const roninSellMultiplier = envNumber('SAMURAI_RONIN_SELL_MULTIPLIER', envNumber('RONIN_SELL_MULTIPLIER', 0.25))
  return {
    pointsEnabled: parseBoolean(runtimeEnv.SAMURAI_POINTS_ENABLED, true),
    pointsPerUsd: configuredRate,
    minimumQualifyingSwapUsd: configuredMinimum,
    transactionPointsCapEnabled: parseBoolean(runtimeEnv.SAMURAI_TRANSACTION_POINTS_CAP_ENABLED, false),
    transactionPointsCap: parseOptionalNumber(runtimeEnv.SAMURAI_TRANSACTION_POINTS_CAP),
    multiplierCeiling: 3,
    roninBuyMultiplier,
    roninSellMultiplier,
    campaigns: parseCampaigns(runtimeEnv.SAMURAI_POINTS_CAMPAIGNS),
    startDate: runtimeEnv.SAMURAI_POINTS_START_DATE || null,
    endDate: runtimeEnv.SAMURAI_POINTS_END_DATE || null,
    ruleVersion: runtimeEnv.SAMURAI_POINTS_RULE_VERSION || 'v1',
  }
}

export function getEffectivePointsConfiguration(savedSettings = null, season = null) {
  const fallback = getPointsConfiguration()
  const saved = savedSettings || {}
  const hasSavedSettings = savedSettings != null

  const pointsEnabled = hasSavedSettings
    ? Boolean(saved.points_enabled ?? fallback.pointsEnabled)
    : hasExplicitEnvValue('SAMURAI_POINTS_ENABLED')
      ? parseBoolean(runtimeEnv.SAMURAI_POINTS_ENABLED, fallback.pointsEnabled)
      : Boolean(saved.points_enabled ?? fallback.pointsEnabled)
  if (season != null && typeof season.points_enabled !== 'boolean') {
    throw new Error('INVALID_SEASON_POINTS_ENABLED')
  }
  const effectivePointsEnabled = season == null ? pointsEnabled : season.points_enabled

  const configuredMinimumQualifyingSwapUsd = hasSavedSettings
    ? Number(saved.minimum_qualifying_swap_usd ?? saved.minimum_qualifying_volume_usd ?? fallback.minimumQualifyingSwapUsd)
    : hasExplicitEnvValue('SAMURAI_MINIMUM_QUALIFYING_SWAP_USD') || hasExplicitEnvValue('SAMURAI_MINIMUM_QUALIFYING_SWAP')
      ? envNumber('SAMURAI_MINIMUM_QUALIFYING_SWAP_USD', envNumber('SAMURAI_MINIMUM_QUALIFYING_SWAP', saved.minimum_qualifying_swap_usd ?? saved.minimum_qualifying_volume_usd ?? fallback.minimumQualifyingSwapUsd))
      : Number(saved.minimum_qualifying_swap_usd ?? saved.minimum_qualifying_volume_usd ?? fallback.minimumQualifyingSwapUsd)
  const seasonMinimum = Number(season?.minimum_qualifying_volume)
  const minimumQualifyingSwapUsd = Number.isFinite(seasonMinimum) && seasonMinimum >= 0
    ? seasonMinimum
    : configuredMinimumQualifyingSwapUsd

  const pointsPerUsd = hasSavedSettings
    ? Number(saved.points_per_usd ?? fallback.pointsPerUsd)
    : hasExplicitEnvValue('SAMURAI_POINTS_PER_DOLLAR')
      ? envNumber('SAMURAI_POINTS_PER_DOLLAR', saved.points_per_usd ?? fallback.pointsPerUsd)
      : Number(saved.points_per_usd ?? fallback.pointsPerUsd)
  const seasonPointsPerUsd = season == null ? pointsPerUsd : Number(season.base_points_per_usd)
  if (season != null
    && (season.base_points_per_usd == null || season.base_points_per_usd === ''
      || !Number.isFinite(seasonPointsPerUsd) || seasonPointsPerUsd < 0)) {
    throw new Error('INVALID_SEASON_POINTS_PER_USD')
  }

  const transactionPointsCapEnabled = hasSavedSettings
    ? Boolean(saved.transaction_points_cap_enabled ?? fallback.transactionPointsCapEnabled)
    : hasExplicitEnvValue('SAMURAI_TRANSACTION_POINTS_CAP_ENABLED')
      ? parseBoolean(runtimeEnv.SAMURAI_TRANSACTION_POINTS_CAP_ENABLED, fallback.transactionPointsCapEnabled)
      : Boolean(saved.transaction_points_cap_enabled ?? fallback.transactionPointsCapEnabled)

  const transactionPointsCap = hasSavedSettings
    ? (saved.transaction_points_cap == null ? fallback.transactionPointsCap : Number(saved.transaction_points_cap))
    : hasExplicitEnvValue('SAMURAI_TRANSACTION_POINTS_CAP')
      ? parseOptionalNumber(runtimeEnv.SAMURAI_TRANSACTION_POINTS_CAP)
      : (saved.transaction_points_cap == null ? fallback.transactionPointsCap : Number(saved.transaction_points_cap))

  const configuredMultiplierCeiling = saved.effective_multiplier_ceiling ?? fallback.multiplierCeiling
  const parsedMultiplierCeiling = Number(configuredMultiplierCeiling)
  const multiplierCeiling = Number.isFinite(parsedMultiplierCeiling) && parsedMultiplierCeiling > 0
    ? parsedMultiplierCeiling
    : fallback.multiplierCeiling

  const roninBuyMultiplier = hasSavedSettings
    ? asFiniteNumber(saved.ronin_buy_multiplier, fallback.roninBuyMultiplier)
    : hasExplicitEnvValue('SAMURAI_RONIN_BUY_MULTIPLIER') || hasExplicitEnvValue('RONIN_BUY_MULTIPLIER')
      ? envNumber('SAMURAI_RONIN_BUY_MULTIPLIER', envNumber('RONIN_BUY_MULTIPLIER', fallback.roninBuyMultiplier))
      : asFiniteNumber(saved.ronin_buy_multiplier, fallback.roninBuyMultiplier)

  const roninSellMultiplier = hasSavedSettings
    ? asFiniteNumber(saved.ronin_sell_multiplier, fallback.roninSellMultiplier)
    : hasExplicitEnvValue('SAMURAI_RONIN_SELL_MULTIPLIER') || hasExplicitEnvValue('RONIN_SELL_MULTIPLIER')
      ? envNumber('SAMURAI_RONIN_SELL_MULTIPLIER', envNumber('RONIN_SELL_MULTIPLIER', fallback.roninSellMultiplier))
      : asFiniteNumber(saved.ronin_sell_multiplier, fallback.roninSellMultiplier)

  return {
    ...fallback,
    pointsEnabled: effectivePointsEnabled,
    pointsPerUsd: seasonPointsPerUsd,
    minimumQualifyingSwapUsd,
    transactionPointsCapEnabled,
    transactionPointsCap,
    multiplierCeiling,
    roninBuyMultiplier,
    roninSellMultiplier,
    campaigns: Array.isArray(saved.campaigns) ? saved.campaigns : fallback.campaigns,
    startDate: saved.start_date || fallback.startDate,
    endDate: saved.end_date || fallback.endDate,
    ruleVersion: fallback.ruleVersion,
  }
}

export function mergePointsConfiguration(configuration) {
  const fallback = getPointsConfiguration()
  return { ...fallback, ...(configuration || {}), ruleVersion: fallback.ruleVersion }
}

export function classifySamuraiPointSource(swap) {
  const inputMint = normalizeMint(swap?.input_mint)
  const outputMint = normalizeMint(swap?.output_mint)
  const roninMint = normalizeMint(RONIN_MINT)

  if (!inputMint || !outputMint) {
    return { source: 'SWAP', multiplier: 1, invalid: false }
  }

  if (inputMint === roninMint && outputMint === roninMint) {
    return { source: 'SWAP', multiplier: 1, invalid: true, exclusionReason: 'INVALID_RONIN_DIRECTION' }
  }

  if (inputMint === roninMint && outputMint !== roninMint) {
    return { source: 'RONIN_SELL', multiplier: 0.25, invalid: false }
  }

  if (inputMint !== roninMint && outputMint === roninMint) {
    return { source: 'RONIN_BUY', multiplier: 2, invalid: false }
  }

  return { source: 'SWAP', multiplier: 1, invalid: false }
}

function getSourceMultiplier(source, configuration) {
  if (source.source !== 'RONIN_BUY' && source.source !== 'RONIN_SELL') return 1
  const configuredMultiplier = source.source === 'RONIN_BUY'
    ? configuration.roninBuyMultiplier
    : configuration.roninSellMultiplier
  const defaultMultiplier = source.source === 'RONIN_BUY' ? 2 : 0.25
  const multiplier = configuredMultiplier == null || configuredMultiplier === ''
    ? NaN
    : Number(configuredMultiplier)
  return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : defaultMultiplier
}

function normalizedCampaignCode(value) {
  return String(value || '').trim().toUpperCase()
}

function campaignSourceTarget(item) {
  const sources = Array.isArray(item?.sources) ? item.sources : item?.source ? [item.source] : []
  return sources.map((source) => String(source).trim().toUpperCase()).filter(Boolean)
}

function matchesCampaignTargets(campaign, swap, source) {
  const sourceTargets = campaignSourceTarget(campaign)
  if (sourceTargets.length && !sourceTargets.includes(source.source)) return false

  const direction = String(campaign.direction || 'any').trim().toLowerCase()
  if (direction === 'buy' && source.source !== 'RONIN_BUY' && !(source.source === 'SWAP' && campaign.outputMint && normalizeMint(campaign.outputMint) === normalizeMint(swap.output_mint))) return false
  if (direction === 'sell' && source.source !== 'RONIN_SELL' && !(source.source === 'SWAP' && campaign.inputMint && normalizeMint(campaign.inputMint) === normalizeMint(swap.input_mint))) return false
  if (!['any', 'buy', 'sell'].includes(direction)) return false

  const chainTargets = Array.isArray(campaign.chainIds)
    ? campaign.chainIds.map(Number)
    : campaign.chainId == null || campaign.chainId === ''
      ? []
      : [Number(campaign.chainId)]
  if (chainTargets.length && !chainTargets.includes(Number(swap.chain_id))) return false
  if (campaign.inputMint && normalizeMint(campaign.inputMint) !== normalizeMint(swap.input_mint)) return false
  if (campaign.outputMint && normalizeMint(campaign.outputMint) !== normalizeMint(swap.output_mint)) return false
  return true
}

export function resolveSamuraiPointCampaign(swap, configuration, requestedCode = swap?.requested_promo_code, validationTimestamp = swap?.timestamp) {
  const code = normalizedCampaignCode(requestedCode)
  const campaigns = Array.isArray(configuration?.campaigns) ? configuration.campaigns : []
  const campaign = campaigns.find((item) => {
    const itemCode = normalizedCampaignCode(item?.promoCode ?? item?.promo_code)
    return code ? itemCode === code : !itemCode
  })
  if (!campaign) return { campaign: null, reason: code ? 'INVALID_PROMO_CODE' : null }
  if (campaign.enabled === false) return { campaign: null, reason: 'CAMPAIGN_DISABLED' }

  const multiplier = Number(campaign.multiplier)
  if (!Number.isFinite(multiplier) || multiplier <= 0) return { campaign: null, reason: 'INVALID_CAMPAIGN_MULTIPLIER' }

  const timestamp = Date.parse(validationTimestamp)
  const starts = campaign.startDate || campaign.start_at ? Date.parse(campaign.startDate || campaign.start_at) : -Infinity
  const ends = campaign.endDate || campaign.end_at ? Date.parse(campaign.endDate || campaign.end_at) : Infinity
  if (!Number.isFinite(timestamp) || timestamp < starts || timestamp >= ends) {
    return { campaign: null, reason: Number.isFinite(starts) && timestamp < starts ? 'CAMPAIGN_NOT_STARTED' : 'CAMPAIGN_EXPIRED' }
  }

  const source = classifySamuraiPointSource(swap)
  if (!matchesCampaignTargets(campaign, swap, source)) return { campaign: null, reason: 'CAMPAIGN_TARGET_MISMATCH' }
  return { campaign, multiplier, reason: null }
}

function activePeriod(timestamp, configuration) {
  const time = timestamp ? Date.parse(timestamp) : NaN
  if (!Number.isFinite(time)) return false
  if (configuration.startDate && time < Date.parse(configuration.startDate)) return false
  if (configuration.endDate && time > Date.parse(configuration.endDate)) return false
  return true
}

async function getTokenUsdPrice(mint) {
  if (mint === USDC_MINT || mint === USDT_MINT) return 1
  const response = await fetchJupiter(`/price/v3?ids=${encodeURIComponent(mint)}`, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error('PRICE_UNAVAILABLE')
  const body = await response.json()
  const price = Number(body?.[mint]?.usdPrice ?? body?.data?.[mint]?.price ?? body?.data?.[mint]?.usdPrice)
  if (!Number.isFinite(price) || price <= 0) throw new Error('PRICE_UNAVAILABLE')
  return price
}

export async function calculateSamuraiPoints(swap, configuration = getPointsConfiguration()) {
  const sourceInfo = classifySamuraiPointSource(swap)
  const base = {
    qualified: false,
    source: sourceInfo.source,
    qualifyingVolumeUsd: 0,
    minimumQualifyingSwapUsd: configuration.minimumQualifyingSwapUsd,
    basePoints: 0,
    multiplier: sourceInfo.multiplier,
    campaignId: null,
    campaignMultiplier: 1,
    bonusPoints: 0,
    campaignReason: null,
    finalPoints: 0,
    pointsAwarded: 0,
    pointsRuleVersion: configuration.ruleVersion,
    exclusionReason: sourceInfo.exclusionReason || null,
  }
  console.log('[ETH-POINTS-TRACE] calculateSamuraiPoints input', {
    signature: swap?.signature || null,
    verificationStatus: swap?.verification_status || null,
    chainId: swap?.chain_id ?? null,
    volumeUsd: swap?.volume_usd ?? null,
    timestamp: swap?.timestamp || null,
    minimumQualifyingSwapUsd: configuration.minimumQualifyingSwapUsd,
    pointsEnabled: configuration.pointsEnabled,
    source: sourceInfo.source,
    multiplier: sourceInfo.multiplier,
  })
  if (!swap || swap.verification_status !== 'verified') return { ...base, exclusionReason: 'TRANSACTION_NOT_VERIFIED' }
  if (!configuration.pointsEnabled) return { ...base, exclusionReason: 'POINTS_DISABLED' }
  if (!activePeriod(swap.timestamp, configuration)) return { ...base, exclusionReason: 'OUTSIDE_ACTIVE_PERIOD' }
  if (sourceInfo.invalid) return { ...base, qualified: false, finalPoints: 0, pointsAwarded: 0, exclusionReason: sourceInfo.exclusionReason }

  const chainId = Number(swap.chain_id)
  if (chainId === 1 || chainId === 4663) {
    let qualifyingVolumeUsd = Number(swap.volume_usd)
    if (!Number.isFinite(qualifyingVolumeUsd) || qualifyingVolumeUsd <= 0) {
      const rawInput = BigInt(String(swap.input_amount_raw ?? '0'))
      const inputDecimals = Number(swap.input_decimals)
      const inputAmount = Number(rawInput) / (10 ** inputDecimals)
      if (!Number.isFinite(inputAmount) || inputAmount <= 0) return { ...base, exclusionReason: 'INVALID_INPUT_AMOUNT' }
      try {
        const priceUsd = await getEvmUsdPrice(chainId, swap.input_mint)
        qualifyingVolumeUsd = Number((inputAmount * priceUsd).toFixed(6))
      } catch {
        return { ...base, exclusionReason: 'PRICE_UNAVAILABLE' }
      }
    }
    if (!Number.isFinite(qualifyingVolumeUsd) || qualifyingVolumeUsd < 0) return { ...base, exclusionReason: 'INVALID_VOLUME' }
    if (qualifyingVolumeUsd < configuration.minimumQualifyingSwapUsd) return { ...base, qualifyingVolumeUsd, exclusionReason: 'BELOW_MINIMUM' }
    const basePoints = Number((qualifyingVolumeUsd * configuration.pointsPerUsd).toFixed(6))
    const multiplier = getSourceMultiplier(sourceInfo, configuration)
    const campaignResult = resolveSamuraiPointCampaign(swap, configuration)
    const campaignMultiplier = campaignResult.multiplier || 1
    const sourcePoints = Number((basePoints * multiplier).toFixed(6))
    const combinedMultiplier = multiplier * campaignMultiplier
    const effectiveMultiplier = Math.min(combinedMultiplier, configuration.multiplierCeiling)
    let finalPoints = Number((basePoints * effectiveMultiplier).toFixed(6))
    if (configuration.transactionPointsCapEnabled && configuration.transactionPointsCap != null) finalPoints = Math.min(finalPoints, configuration.transactionPointsCap)
    const bonusPoints = Number(Math.max(0, finalPoints - sourcePoints).toFixed(6))
    const result = { ...base, qualified: finalPoints > 0, qualifyingVolumeUsd, basePoints, multiplier, campaignId: campaignResult.campaign?.id || null, campaignMultiplier, bonusPoints, campaignReason: campaignResult.reason, finalPoints, pointsAwarded: finalPoints, source: sourceInfo.source }
    console.log('[ETH-POINTS-TRACE] calculateSamuraiPoints result', result)
    return result
  }

  const rawInput = BigInt(String(swap.input_amount_raw))
  const decimals = Number(swap.input_decimals)
  const inputAmount = Number(rawInput) / (10 ** decimals)
  if (!Number.isFinite(inputAmount) || inputAmount <= 0) return { ...base, exclusionReason: 'INVALID_INPUT_AMOUNT' }

  let priceUsd
  try {
    priceUsd = await getTokenUsdPrice(swap.input_mint)
  } catch {
    return { ...base, exclusionReason: 'PRICE_UNAVAILABLE' }
  }

  const qualifyingVolumeUsd = Number((inputAmount * priceUsd).toFixed(6))
  if (!Number.isFinite(qualifyingVolumeUsd)) return { ...base, exclusionReason: 'PRICE_UNAVAILABLE' }
  if (qualifyingVolumeUsd < configuration.minimumQualifyingSwapUsd) {
    return { ...base, qualifyingVolumeUsd, exclusionReason: 'BELOW_MINIMUM' }
  }

  const basePoints = Number((qualifyingVolumeUsd * configuration.pointsPerUsd).toFixed(6))
  const multiplier = getSourceMultiplier(sourceInfo, configuration)
  const campaignResult = resolveSamuraiPointCampaign(swap, configuration)
  const campaignMultiplier = campaignResult.multiplier || 1
  const sourcePoints = Number((basePoints * multiplier).toFixed(6))
  const combinedMultiplier = multiplier * campaignMultiplier
  const effectiveMultiplier = Math.min(combinedMultiplier, configuration.multiplierCeiling)
  let finalPoints = Number((basePoints * effectiveMultiplier).toFixed(6))
  if (configuration.transactionPointsCapEnabled && configuration.transactionPointsCap != null) {
    finalPoints = Math.min(finalPoints, configuration.transactionPointsCap)
  }
  const bonusPoints = Number(Math.max(0, finalPoints - sourcePoints).toFixed(6))
  const result = { ...base, qualified: finalPoints > 0, qualifyingVolumeUsd, basePoints, multiplier, campaignId: campaignResult.campaign?.id || null, campaignMultiplier, bonusPoints, campaignReason: campaignResult.reason, finalPoints, pointsAwarded: finalPoints, source: sourceInfo.source }
  console.log('[ETH-POINTS-TRACE] calculateSamuraiPoints result', result)
  return result
}

export { JUPITER_TIMEOUT_MS, SOL_MINT }