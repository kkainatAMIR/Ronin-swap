import { apiError, json, parseBody, rateLimit } from '../_lib/roninBackend.mjs'
import { getAdminSettings, getLifiSwapByHash, getPointsBySignature, awardSamuraiPoints, isSupabaseConfigured, persistLifiSwap } from '../_lib/supabaseBackend.mjs'
import { calculateSamuraiPoints, getPointsConfiguration } from '../_lib/samuraiPoints.mjs'
import { isApprovedLifiToken, lifiRpc } from '../_lib/lifi.mjs'
import { getSeasonForTimestamp } from '../_lib/supabaseBackend.mjs'
import { verifyQuoteProof } from '../_lib/ethereum.mjs'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/

function receiptSucceeded(receipt) {
  const status = receipt?.status
  return status === '0x1' || status === '0x01' || status === 1 || status === '1' || status === true
}

function pointsView(points) {
  if (!points) return null
  return { ...points, qualified: points.eligibility_status === 'qualified', pointsAwarded: Number(points.points_awarded || points.final_points || 0), qualifyingVolumeUsd: Number(points.qualifying_volume_usd || 0), walletSeasonPoints: Number(points.season_points || 0), reason: points.exclusion_reason || null }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'lifi-complete', 20)) return apiError(res, 429, 'RATE_LIMITED', 'Too many completion requests. Try again shortly.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Swap persistence is not configured.')
  const body = parseBody(req) || {}
  const { transactionHash, wallet, fromChain, toChain, fromToken, toToken, fromAmount, toAmount, quoteId, quoteProof } = body
  if (!HASH.test(String(transactionHash || '')) || !ADDRESS.test(String(wallet || '')) || !ADDRESS.test(String(fromToken || '')) || !ADDRESS.test(String(toToken || '')) || !/^[1-9]\d*$/.test(String(fromAmount || '')) || !/^[1-9]\d*$/.test(String(toAmount || '')) || !Number.isInteger(Number(fromChain)) || !Number.isInteger(Number(toChain))) return apiError(res, 400, 'INVALID_COMPLETION', 'A valid LI.FI transaction completion is required.')
  try {
    const proof = verifyQuoteProof(quoteProof, { provider: 'lifi', fromChain, toChain, wallet, fromToken: fromToken.toLowerCase(), toToken: toToken.toLowerCase(), fromAmount, toAmount })
    const [fromApproved, toApproved] = await Promise.all([isApprovedLifiToken(fromChain, fromToken), isApprovedLifiToken(toChain, toToken)])
    if (!fromApproved || !toApproved) return apiError(res, 403, 'UNSUPPORTED_TOKEN', 'The completed tokens are not approved.')
    const existing = await getLifiSwapByHash(transactionHash)
    if (existing) return json(res, 200, { success: true, duplicate: true, swap: existing, points: pointsView(await getPointsBySignature(transactionHash)) })
    const [tx, receipt] = await Promise.all([lifiRpc(fromChain, 'eth_getTransactionByHash', [transactionHash]), lifiRpc(fromChain, 'eth_getTransactionReceipt', [transactionHash])])
    if (!tx || !receipt || !receiptSucceeded(receipt) || String(tx.from || '').toLowerCase() !== wallet.toLowerCase() || String(tx.to || '').toLowerCase() !== String(proof.transactionTo || '').toLowerCase() || String(tx.input || '').trim().toLowerCase() !== String(proof.transactionData || '').trim().toLowerCase() || BigInt(tx.value || '0x0') !== BigInt(proof.transactionValue || '0x0') || receipt.blockNumber == null) return apiError(res, 422, 'TRANSACTION_NOT_CONFIRMED', 'The LI.FI transaction was not confirmed successfully.')
    const timestamp = new Date().toISOString()
    const persisted = await persistLifiSwap({ wallet, transactionHash, fromChain, toChain, fromToken, toToken, fromAmount, toAmount, volumeUsd: proof.volumeUsd, timestamp, blockNumber: receipt.blockNumber, quoteId })
    const season = await getSeasonForTimestamp(timestamp)
    const saved = await getAdminSettings().catch(() => null)
    const fallback = getPointsConfiguration()
    const configuration = saved ? { ...fallback, pointsEnabled: saved.points_enabled, minimumQualifyingSwapUsd: Number(saved.minimum_qualifying_volume_usd || saved.minimum_qualifying_swap_usd), pointsPerUsd: Number(saved.points_per_usd), campaigns: Array.isArray(saved.campaigns) ? saved.campaigns : [] } : fallback
    const calculation = await calculateSamuraiPoints({ verification_status: 'verified', chain_id: Number(fromChain), volume_usd: proof.volumeUsd == null ? null : Number(proof.volumeUsd), timestamp, input_mint: fromToken, output_mint: toToken, input_amount_raw: fromAmount, input_decimals: Number.isInteger(proof.fromDecimals) ? proof.fromDecimals : 18 }, season ? { ...configuration, pointsEnabled: season.points_enabled, minimumQualifyingSwapUsd: Number(season.minimum_qualifying_volume), pointsPerUsd: Number(season.base_points_per_usd) } : configuration)
    const points = await awardSamuraiPoints({ signature: transactionHash, ...calculation, seasonId: season?.id || null })
    return json(res, 200, { success: true, duplicate: false, swap: persisted.swap, points: pointsView(points) })
  } catch (error) {
    console.error('LI.FI completion failed:', error?.message || error)
    return apiError(res, 502, 'LIFI_COMPLETION_ERROR', 'LI.FI swap completion could not be recorded.')
  }
}