import { apiError, json, parseBody, rateLimit } from '../_lib/roninBackend.mjs'
import { ethereumRpc, ethereumChainId, isEthereumAddress, verifyQuoteProof } from '../_lib/ethereum.mjs'
import { awardSamuraiPoints, getAdminSettings, getEthereumSwapByHash, getPointsBySignature, getSeasonForTimestamp, isSupabaseConfigured, persistEthereumSwap } from '../_lib/supabaseBackend.mjs'
import { calculateSamuraiPoints, getPointsConfiguration } from '../_lib/samuraiPoints.mjs'

function hash(value) { return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) }

function formatPoints(points) {
  if (!points) return null
  return {
    ...points,
    qualified: points.eligibility_status === 'qualified' || points.qualified === true,
    pointsAwarded: Number(points.points_awarded || points.pointsAwarded || 0),
    qualifyingVolumeUsd: Number(points.qualifying_volume_usd || points.qualifyingVolumeUsd || 0),
    walletSeasonPoints: Number(points.season_points || points.walletSeasonPoints || 0),
    walletLifetimePoints: Number(points.lifetime_points || points.walletLifetimePoints || 0),
    reason: points.exclusion_reason || points.reason || null,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'evm-complete', 20)) return apiError(res, 429, 'RATE_LIMITED', 'Too many completion requests. Try again shortly.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Ethereum swap persistence is not configured.')
  const body = parseBody(req) || {}
  const { transactionHash, wallet, sellToken, buyToken, sellAmount, buyAmount, quoteProof } = body
  const validAsset = (value) => value === 'native' || isEthereumAddress(value)
  if (!hash(transactionHash) || !isEthereumAddress(wallet) || !validAsset(sellToken) || !validAsset(buyToken) || sellToken === buyToken || !/^\d+$/.test(String(sellAmount || '')) || !/^\d+$/.test(String(buyAmount || ''))) return apiError(res, 400, 'INVALID_COMPLETION', 'A valid Ethereum transaction completion is required.')
  if (Number(body.chainId) !== ethereumChainId()) return apiError(res, 400, 'INVALID_CHAIN', 'Ethereum Mainnet is required.')
  try {
    const trustedQuote = verifyQuoteProof(quoteProof, { chainId: 1, wallet, sellToken, buyToken, sellAmount })
    if (String(trustedQuote.buyAmount) !== String(buyAmount)) return apiError(res, 400, 'QUOTE_INVALID', 'The completion does not match the quoted output.')
    const existing = await getEthereumSwapByHash(transactionHash)
    if (existing) return json(res, 200, { success: true, duplicate: true, swap: existing, points: formatPoints(await getPointsBySignature(transactionHash)) })
    const tx = await ethereumRpc('eth_getTransactionByHash', [transactionHash])
    const receipt = await ethereumRpc('eth_getTransactionReceipt', [transactionHash])
    if (!tx || !receipt || receipt.status !== '0x1' || String(tx.from).toLowerCase() !== wallet.toLowerCase() || String(tx.to).toLowerCase() !== String(trustedQuote.to).toLowerCase() || String(tx.input || '').toLowerCase() !== String(trustedQuote.data || '').toLowerCase() || BigInt(tx.value || '0x0') !== BigInt(trustedQuote.value || '0') || receipt.blockNumber == null) return apiError(res, 422, 'TRANSACTION_NOT_CONFIRMED', 'The Ethereum transaction was not confirmed successfully.')
    const block = await ethereumRpc('eth_getBlockByNumber', [receipt.blockNumber, false])
    const timestamp = block?.timestamp ? new Date(Number.parseInt(block.timestamp, 16) * 1000).toISOString() : new Date().toISOString()
    const persisted = await persistEthereumSwap({ wallet, transactionHash, sellToken, buyToken, sellAmount, buyAmount, sellDecimals: trustedQuote.sellDecimals, buyDecimals: trustedQuote.buyDecimals, volumeUsd: trustedQuote.volumeUsd, timestamp, blockNumber: receipt.blockNumber })
    const season = await getSeasonForTimestamp(timestamp)
    const saved = await getAdminSettings().catch(() => null)
    const fallback = getPointsConfiguration()
    const configuration = saved ? { ...fallback, pointsEnabled: saved.points_enabled, minimumQualifyingSwapUsd: Number(saved.minimum_qualifying_swap_usd), pointsPerUsd: Number(saved.points_per_usd), transactionPointsCapEnabled: saved.transaction_points_cap_enabled, transactionPointsCap: saved.transaction_points_cap == null ? null : Number(saved.transaction_points_cap), campaigns: Array.isArray(saved.campaigns) ? saved.campaigns : [] } : fallback
    const calculation = await calculateSamuraiPoints({ verification_status: 'verified', chain_id: 1, volume_usd: Number(trustedQuote.volumeUsd), timestamp, input_mint: sellToken, output_mint: buyToken, input_amount_raw: sellAmount, input_decimals: trustedQuote.sellDecimals }, season ? { ...configuration, pointsEnabled: season.points_enabled, minimumQualifyingSwapUsd: Number(season.minimum_qualifying_volume), pointsPerUsd: Number(season.base_points_per_usd), campaigns: Array.isArray(season.multiplier_rules) ? season.multiplier_rules : configuration.campaigns } : configuration)
    const points = await awardSamuraiPoints({ signature: transactionHash, ...calculation, seasonId: season?.id || null })
    return json(res, 200, { success: true, duplicate: false, swap: persisted.swap, points: formatPoints(points) })
  } catch (error) {
    console.error('Ethereum completion failed:', error?.message || error)
    return apiError(res, 502, 'ETHEREUM_COMPLETION_ERROR', 'Ethereum swap completion could not be recorded.')
  }
}