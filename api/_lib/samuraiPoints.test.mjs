import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateSamuraiPoints, getEffectivePointsConfiguration, resolveSamuraiPointCampaign } from './samuraiPoints.mjs'
import { RONIN_MINT } from './roninBackend.mjs'

const timestamp = '2026-10-05T12:00:00.000Z'
const config = {
  pointsEnabled: true,
  pointsPerUsd: 1,
  minimumQualifyingSwapUsd: 0,
  transactionPointsCapEnabled: false,
  transactionPointsCap: null,
  multiplierCeiling: 3,
  roninBuyMultiplier: 2,
  roninSellMultiplier: 0.25,
  campaigns: [],
  ruleVersion: 'test',
}
const baseSwap = {
  verification_status: 'verified',
  chain_id: 1,
  volume_usd: 100,
  timestamp,
  input_mint: '0x0000000000000000000000000000000000000001',
  output_mint: '0x0000000000000000000000000000000000000002',
  input_amount_raw: '100',
  input_decimals: 0,
}

test('season-specific rate and enabled flag control point calculation', async () => {
  const season = {
    points_enabled: true,
    base_points_per_usd: 2,
    minimum_qualifying_volume: 10,
    multiplier_rules: [],
  }
  const seasonConfig = getEffectivePointsConfiguration({
    points_enabled: true,
    points_per_usd: 1,
    minimum_qualifying_swap_usd: 1,
  }, season)
  const seasonRateResult = await calculateSamuraiPoints({
    ...baseSwap,
    volume_usd: 10,
  }, seasonConfig)

  assert.equal(seasonConfig.pointsPerUsd, 2)
  assert.equal(seasonRateResult.basePoints, 20)
  assert.equal(seasonRateResult.finalPoints, 20)

  const disabledSeasonConfig = getEffectivePointsConfiguration({
    points_enabled: true,
    points_per_usd: 1,
    minimum_qualifying_swap_usd: 1,
  }, { ...season, points_enabled: false })
  const disabledSeasonResult = await calculateSamuraiPoints({
    ...baseSwap,
    volume_usd: 10,
  }, disabledSeasonConfig)

  assert.equal(disabledSeasonConfig.pointsEnabled, false)
  assert.equal(disabledSeasonResult.qualified, false)
  assert.equal(disabledSeasonResult.pointsAwarded, 0)
  assert.equal(disabledSeasonResult.exclusionReason, 'POINTS_DISABLED')
})

test('global and default season rates preserve existing point behavior', async () => {
  const globalConfig = getEffectivePointsConfiguration({
    points_enabled: true,
    points_per_usd: 1,
    minimum_qualifying_swap_usd: 1,
  })
  const result = await calculateSamuraiPoints({
    ...baseSwap,
    volume_usd: 10,
  }, globalConfig)

  assert.equal(globalConfig.pointsPerUsd, 1)
  assert.equal(result.basePoints, 10)
  assert.equal(result.finalPoints, 10)

  const defaultSeasonConfig = getEffectivePointsConfiguration({
    points_enabled: true,
    points_per_usd: 1,
    minimum_qualifying_swap_usd: 1,
  }, {
    points_enabled: true,
    base_points_per_usd: 1,
    minimum_qualifying_volume: 1,
    multiplier_rules: [],
  })
  const defaultSeasonResult = await calculateSamuraiPoints({
    ...baseSwap,
    volume_usd: 10,
  }, defaultSeasonConfig)

  assert.equal(defaultSeasonResult.basePoints, 10)
  assert.equal(defaultSeasonResult.finalPoints, 10)
})

test('source multipliers remain 1x, 2x, and 0.25x without a promo', async () => {
  const swap = await calculateSamuraiPoints(baseSwap, config)
  const buy = await calculateSamuraiPoints({ ...baseSwap, output_mint: RONIN_MINT }, config)
  const sell = await calculateSamuraiPoints({ ...baseSwap, input_mint: RONIN_MINT }, config)

  assert.equal(swap.multiplier, 1)
  assert.equal(swap.finalPoints, 100)
  assert.equal(buy.multiplier, 2)
  assert.equal(buy.finalPoints, 200)
  assert.equal(sell.multiplier, 0.25)
  assert.equal(sell.finalPoints, 25)
})

test('effective multiplier ceiling caps directional and campaign multipliers together', async () => {
  const campaign = {
    id: 'ceiling-campaign',
    promoCode: 'CEILING',
    enabled: true,
    multiplier: 1,
    startDate: '2026-10-05T00:00:00.000Z',
    endDate: '2026-10-06T00:00:00.000Z',
  }
  const swap = { ...baseSwap, output_mint: RONIN_MINT, requested_promo_code: 'CEILING' }

  const unchanged = await calculateSamuraiPoints({ ...baseSwap, requested_promo_code: null }, config)
  const directionalOnly = await calculateSamuraiPoints(swap, { ...config, campaigns: [campaign] })
  const exactlyAtCeiling = await calculateSamuraiPoints(swap, {
    ...config,
    campaigns: [{ ...campaign, multiplier: 1.5 }],
  })
  const capped = await calculateSamuraiPoints(swap, {
    ...config,
    campaigns: [{ ...campaign, multiplier: 2 }],
  })

  assert.equal(unchanged.finalPoints, 100)
  assert.equal(directionalOnly.finalPoints, 200)
  assert.equal(exactlyAtCeiling.finalPoints, 300)
  assert.equal(capped.finalPoints, 300)
})

test('effective multiplier ceiling respects configurable limits and low multipliers', async () => {
  const campaign = {
    id: 'ceiling-campaign',
    promoCode: 'CEILING',
    enabled: true,
    multiplier: 2,
    startDate: '2026-10-05T00:00:00.000Z',
    endDate: '2026-10-06T00:00:00.000Z',
  }
  const buy = { ...baseSwap, output_mint: RONIN_MINT, requested_promo_code: 'CEILING' }
  const sell = { ...baseSwap, input_mint: RONIN_MINT, requested_promo_code: 'CEILING' }

  const ceilingFive = await calculateSamuraiPoints(buy, {
    ...config,
    multiplierCeiling: 5,
    campaigns: [{ ...campaign, multiplier: 2 }],
  })
  const ceilingTwo = await calculateSamuraiPoints(buy, {
    ...config,
    multiplierCeiling: 2,
    campaigns: [{ ...campaign, multiplier: 1.5 }],
  })
  const sellWithCampaign = await calculateSamuraiPoints(sell, { ...config, campaigns: [campaign] })

  assert.equal(ceilingFive.finalPoints, 400)
  assert.equal(ceilingTwo.finalPoints, 200)
  assert.equal(sellWithCampaign.finalPoints, 50)
})

test('explicit zero directional multipliers award zero points', async () => {
  const buy = await calculateSamuraiPoints(
    { ...baseSwap, output_mint: RONIN_MINT },
    { ...config, roninBuyMultiplier: 0 },
  )
  const sell = await calculateSamuraiPoints(
    { ...baseSwap, input_mint: RONIN_MINT },
    { ...config, roninSellMultiplier: 0 },
  )

  assert.equal(buy.multiplier, 0)
  assert.equal(buy.finalPoints, 0)
  assert.equal(buy.pointsAwarded, 0)
  assert.equal(sell.multiplier, 0)
  assert.equal(sell.finalPoints, 0)
  assert.equal(sell.pointsAwarded, 0)
})

test('absolute transaction points cap applies after effective multiplier ceiling', async () => {
  const campaign = {
    id: 'cap-campaign',
    promoCode: 'CAP',
    enabled: true,
    multiplier: 2,
    startDate: '2026-10-05T00:00:00.000Z',
    endDate: '2026-10-06T00:00:00.000Z',
  }
  const result = await calculateSamuraiPoints({
    ...baseSwap,
    output_mint: RONIN_MINT,
    requested_promo_code: 'CAP',
  }, {
    ...config,
    transactionPointsCapEnabled: true,
    transactionPointsCap: 250,
    campaigns: [campaign],
  })

  assert.equal(result.finalPoints, 250)
  assert.equal(result.pointsAwarded, 250)
})

test('valid promo multiplier is applied after source multiplier and separately records its bonus', async () => {
  const campaign = { id: 'buy-campaign', name: 'Buy promo', promoCode: 'BUY15', enabled: true, multiplier: 1.5, source: 'RONIN_BUY', direction: 'buy', chainId: 1, startDate: '2026-10-05T00:00:00.000Z', endDate: '2026-10-06T00:00:00.000Z' }
  const result = await calculateSamuraiPoints({
    ...baseSwap,
    output_mint: RONIN_MINT,
    requested_promo_code: 'buy15',
  }, { ...config, campaigns: [campaign] })

  assert.equal(result.basePoints, 100)
  assert.equal(result.multiplier, 2)
  assert.equal(result.campaignId, 'buy-campaign')
  assert.equal(result.campaignMultiplier, 1.5)
  assert.equal(result.bonusPoints, 100)
  assert.equal(result.finalPoints, 300)
})

test('SWAP campaign direction matches the configured token side and preserves promo multiplier', async () => {
  const campaign = {
    id: 'evm-buy-campaign',
    promoCode: 'TESTING2',
    enabled: true,
    multiplier: 4,
    source: 'SWAP',
    direction: 'buy',
    chainId: 1,
    inputMint: baseSwap.input_mint,
    outputMint: baseSwap.output_mint,
    startDate: '2026-10-05T00:00:00.000Z',
    endDate: '2026-10-06T00:00:00.000Z',
  }
  const result = await calculateSamuraiPoints({
    ...baseSwap,
    volume_usd: 1,
    requested_promo_code: 'TESTING2',
  }, { ...config, minimumQualifyingSwapUsd: 1, multiplierCeiling: 5, campaigns: [campaign] })
  const reverse = await calculateSamuraiPoints({
    ...baseSwap,
    input_mint: baseSwap.output_mint,
    output_mint: baseSwap.input_mint,
    volume_usd: 1,
    requested_promo_code: 'TESTING2',
  }, { ...config, minimumQualifyingSwapUsd: 1, multiplierCeiling: 5, campaigns: [campaign] })
  const sellCampaign = { ...campaign, id: 'evm-sell-campaign', direction: 'sell' }
  const sell = await calculateSamuraiPoints({
    ...baseSwap,
    volume_usd: 1,
    requested_promo_code: 'TESTING2',
  }, { ...config, minimumQualifyingSwapUsd: 1, multiplierCeiling: 5, campaigns: [sellCampaign] })

  assert.equal(result.source, 'SWAP')
  assert.equal(result.campaignId, 'evm-buy-campaign')
  assert.equal(result.campaignMultiplier, 4)
  assert.equal(result.bonusPoints, 3)
  assert.equal(result.finalPoints, 4)
  assert.equal(reverse.campaignId, null)
  assert.equal(reverse.finalPoints, 1)
  assert.equal(sell.campaignId, 'evm-sell-campaign')
  assert.equal(sell.finalPoints, 4)
})

test('invalid, disabled, expired, future, and incorrectly targeted promos are excluded', () => {
  const valid = { id: 'promo', promoCode: 'PROMO', enabled: true, multiplier: 1.5, startDate: '2026-10-05T00:00:00.000Z', endDate: '2026-10-06T00:00:00.000Z' }
  const swap = { ...baseSwap, timestamp, requested_promo_code: 'PROMO' }

  assert.equal(resolveSamuraiPointCampaign(swap, { campaigns: [] }).reason, 'INVALID_PROMO_CODE')
  assert.equal(resolveSamuraiPointCampaign(swap, { campaigns: [{ ...valid, enabled: false }] }).reason, 'CAMPAIGN_DISABLED')
  assert.equal(resolveSamuraiPointCampaign(swap, { campaigns: [{ ...valid, startDate: '2026-10-06T00:00:00.000Z' }] }).reason, 'CAMPAIGN_NOT_STARTED')
  assert.equal(resolveSamuraiPointCampaign(swap, { campaigns: [{ ...valid, endDate: '2026-10-05T00:00:00.000Z' }] }).reason, 'CAMPAIGN_EXPIRED')
  assert.equal(resolveSamuraiPointCampaign(swap, { campaigns: [{ ...valid, source: 'RONIN_BUY' }] }).reason, 'CAMPAIGN_TARGET_MISMATCH')
  assert.equal(resolveSamuraiPointCampaign(swap, { campaigns: [{ ...valid, direction: 'buy' }] }).reason, 'CAMPAIGN_TARGET_MISMATCH')
  assert.equal(resolveSamuraiPointCampaign(swap, { campaigns: [{ ...valid, chainId: 4663 }] }).reason, 'CAMPAIGN_TARGET_MISMATCH')
  assert.equal(resolveSamuraiPointCampaign(swap, { campaigns: [{ ...valid, inputMint: '0x0000000000000000000000000000000000000003' }] }).reason, 'CAMPAIGN_TARGET_MISMATCH')
  assert.equal(resolveSamuraiPointCampaign(swap, { campaigns: [{ ...valid, outputMint: '0x0000000000000000000000000000000000000003' }] }).reason, 'CAMPAIGN_TARGET_MISMATCH')
})
