import { fetchJupiter, JUPITER_TIMEOUT_MS } from './roninBackend.mjs'
import { getEvmUsdPrice } from './ethereum.mjs'

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

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

export function getPointsConfiguration() {
  const configuredRate = Number(runtimeEnv.SAMURAI_POINTS_PER_DOLLAR || 1)
  const configuredMinimum = Number(runtimeEnv.SAMURAI_MINIMUM_QUALIFYING_SWAP_USD || runtimeEnv.SAMURAI_MINIMUM_QUALIFYING_SWAP || 10)
  return {
    pointsEnabled: parseBoolean(runtimeEnv.SAMURAI_POINTS_ENABLED, true),
    pointsPerUsd: Number.isFinite(configuredRate) && configuredRate >= 0 ? configuredRate : 1,
    minimumQualifyingSwapUsd: Number.isFinite(configuredMinimum) && configuredMinimum >= 0 ? configuredMinimum : 10,
    transactionPointsCapEnabled: parseBoolean(runtimeEnv.SAMURAI_TRANSACTION_POINTS_CAP_ENABLED, false),
    transactionPointsCap: parseOptionalNumber(runtimeEnv.SAMURAI_TRANSACTION_POINTS_CAP),
    campaigns: parseCampaigns(runtimeEnv.SAMURAI_POINTS_CAMPAIGNS),
    startDate: runtimeEnv.SAMURAI_POINTS_START_DATE || null,
    endDate: runtimeEnv.SAMURAI_POINTS_END_DATE || null,
    ruleVersion: runtimeEnv.SAMURAI_POINTS_RULE_VERSION || 'v1',
  }
}

export function mergePointsConfiguration(configuration) {
  const fallback = getPointsConfiguration()
  return { ...fallback, ...(configuration || {}), ruleVersion: fallback.ruleVersion }
}

function getMultiplier(swap, configuration) {
  const timestamp = Date.parse(swap.timestamp)
  const campaign = configuration.campaigns.find((item) => {
    if (item?.enabled === false || !Number.isFinite(Number(item?.multiplier)) || Number(item.multiplier) <= 0) return false
    const starts = item.startDate ? Date.parse(item.startDate) : -Infinity
    const ends = item.endDate ? Date.parse(item.endDate) : Infinity
    if (!Number.isFinite(timestamp) || timestamp < starts || timestamp > ends) return false
    if (item.inputMint && item.inputMint !== swap.input_mint) return false
    if (item.outputMint && item.outputMint !== swap.output_mint) return false
    return true
  })
  return campaign ? Number(campaign.multiplier) : 1
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
  const base = {
    qualified: false,
    qualifyingVolumeUsd: 0,
    basePoints: 0,
    multiplier: 1,
    finalPoints: 0,
    pointsAwarded: 0,
    pointsRuleVersion: configuration.ruleVersion,
    exclusionReason: null,
  }
  if (!swap || swap.verification_status !== 'verified') return { ...base, exclusionReason: 'TRANSACTION_NOT_VERIFIED' }
  if (!configuration.pointsEnabled) return { ...base, exclusionReason: 'POINTS_DISABLED' }
  if (!activePeriod(swap.timestamp, configuration)) return { ...base, exclusionReason: 'OUTSIDE_ACTIVE_PERIOD' }

  const chainId = Number(swap.chain_id)
  if (chainId === 1 || chainId === 4663) {
    let qualifyingVolumeUsd = Number(swap.volume_usd)
    if (!Number.isFinite(qualifyingVolumeUsd) || qualifyingVolumeUsd <= 0) {
      // Only stablecoin-paired quotes carry a pre-computed USD amount. Every
      // other EVM pair (the common case) needs a live price fallback, same
      // idea as the Solana branch below — this is what previously left
      // non-stablecoin Ethereum/Robinhood swaps stuck at 0 qualifying volume.
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
    const multiplier = getMultiplier(swap, configuration)
    let finalPoints = Number((basePoints * multiplier).toFixed(6))
    if (configuration.transactionPointsCapEnabled && configuration.transactionPointsCap != null) finalPoints = Math.min(finalPoints, configuration.transactionPointsCap)
    return { ...base, qualified: finalPoints > 0, qualifyingVolumeUsd, basePoints, multiplier, finalPoints, pointsAwarded: finalPoints }
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
  const multiplier = getMultiplier(swap, configuration)
  let finalPoints = Number((basePoints * multiplier).toFixed(6))
  if (configuration.transactionPointsCapEnabled && configuration.transactionPointsCap != null) {
    finalPoints = Math.min(finalPoints, configuration.transactionPointsCap)
  }
  return { ...base, qualified: finalPoints > 0, qualifyingVolumeUsd, basePoints, multiplier, finalPoints, pointsAwarded: finalPoints }
}

export { JUPITER_TIMEOUT_MS, SOL_MINT }