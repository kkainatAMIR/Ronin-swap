import { apiError, json, parseBody, rateLimit } from '../../api/_lib/roninBackend.mjs'
import { getAdminSettings, getLifiSwapByHash, getPointsBySignature, awardSamuraiPoints, isSupabaseConfigured, persistLifiSwap } from '../../api/_lib/supabaseBackend.mjs'
import { calculateSamuraiPoints, getEffectivePointsConfiguration } from '../../api/_lib/samuraiPoints.mjs'
import { isApprovedLifiToken, lifiRpc, normalizeNativeTokenAddress } from '../../api/_lib/lifi.mjs'
import { getSeasonForTimestamp } from '../../api/_lib/supabaseBackend.mjs'
import { verifyQuoteProof } from '../../api/_lib/ethereum.mjs'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

function normalizeAddressLike(value) {
  const normalized = normalizeNativeTokenAddress(value)
  if (!normalized) return ''
  return normalized.toLowerCase() === 'native' ? ZERO_ADDRESS : normalized
}

function validAddressOrNative(value) {
  const normalized = normalizeAddressLike(value)
  return normalized === ZERO_ADDRESS || ADDRESS.test(normalized)
}

function receiptSucceeded(receipt) {
  const status = receipt?.status
  return status === '0x1' || status === '0x01' || status === 1 || status === '1' || status === true
}

function pointsView(points) {
  if (!points) return null
  return {
    ...points,
    qualified: points.eligibility_status === 'qualified' || points.qualified === true,
    pointsAwarded: Number(points.points_awarded ?? points.pointsAwarded ?? points.final_points ?? points.finalPoints ?? 0),
    qualifyingVolumeUsd: Number(points.qualifying_volume_usd ?? points.qualifyingVolumeUsd ?? 0),
    walletSeasonPoints: Number(points.season_points ?? points.walletSeasonPoints ?? 0),
    reason: points.exclusion_reason || points.reason || null,
    eligibility_status: points.eligibility_status || (points.qualified === true ? 'qualified' : 'not_qualified'),
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'lifi-complete', 20)) return apiError(res, 429, 'RATE_LIMITED', 'Too many completion requests. Try again shortly.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Swap persistence is not configured.')
  const body = parseBody(req) || {}
  const { transactionHash, wallet, fromChain, toChain, fromToken, toToken, fromAmount, toAmount, quoteId, quoteProof } = body
  const normalizedFromToken = normalizeAddressLike(fromToken)
  const normalizedToToken = normalizeAddressLike(toToken)
  if (!HASH.test(String(transactionHash || '')) || !validAddressOrNative(wallet) || !validAddressOrNative(fromToken) || !validAddressOrNative(toToken) || !/^[1-9]\d*$/.test(String(fromAmount || '')) || !/^[1-9]\d*$/.test(String(toAmount || '')) || !Number.isInteger(Number(fromChain)) || !Number.isInteger(Number(toChain))) {
    console.error('LI.FI completion validation failed', { chain: Number(fromChain), transactionHash, wallet, fromToken, toToken, normalizedFromToken, normalizedToToken, completionStatus: 'validation_failed', validationFailureReason: 'invalid completion payload' })
    return apiError(res, 400, 'INVALID_COMPLETION', 'A valid LI.FI transaction completion is required.')
  }
  try {
    const proof = verifyQuoteProof(quoteProof, { provider: 'lifi', fromChain, toChain, wallet, fromToken: normalizedFromToken.toLowerCase(), toToken: normalizedToToken.toLowerCase(), fromAmount, toAmount })
    const [fromApproved, toApproved] = await Promise.all([isApprovedLifiToken(fromChain, normalizedFromToken), isApprovedLifiToken(toChain, normalizedToToken)])
    if (!fromApproved || !toApproved) return apiError(res, 403, 'UNSUPPORTED_TOKEN', 'The completed tokens are not approved.')
    const existing = await getLifiSwapByHash(transactionHash)
    if (existing) {
      const existingPoints = await getPointsBySignature(transactionHash)
      if (existingPoints) return json(res, 200, { success: true, duplicate: true, swap: existing, points: pointsView(existingPoints) })
      const timestamp = new Date().toISOString()
      const season = await getSeasonForTimestamp(timestamp)
      const saved = await getAdminSettings().catch(() => null)
      const configuration = getEffectivePointsConfiguration(saved)
      const calculation = await calculateSamuraiPoints({ verification_status: existing.verification_status || 'verified', chain_id: Number(existing.chain_id ?? fromChain), volume_usd: existing.volume_usd == null ? (proof.volumeUsd == null ? null : Number(proof.volumeUsd)) : Number(existing.volume_usd), timestamp: existing.timestamp || timestamp, input_mint: existing.input_mint || normalizedFromToken, output_mint: existing.output_mint || normalizedToToken, input_amount_raw: existing.input_amount_raw || fromAmount, input_decimals: Number(existing.input_decimals ?? proof.fromDecimals ?? 18) }, configuration)
      const points = await awardSamuraiPoints({ signature: transactionHash, ...calculation, seasonId: season?.id || null })
      return json(res, 200, { success: true, duplicate: true, swap: existing, points: pointsView(points || { eligibility_status: calculation.qualified ? 'qualified' : 'not_qualified', points_awarded: calculation.pointsAwarded || 0, exclusion_reason: calculation.exclusionReason || null, qualifying_volume_usd: calculation.qualifyingVolumeUsd || 0, season_points: 0 }) })
    }
    const [tx, receipt] = await Promise.all([lifiRpc(fromChain, 'eth_getTransactionByHash', [transactionHash]), lifiRpc(fromChain, 'eth_getTransactionReceipt', [transactionHash])])
    if (!tx || !receipt || !receiptSucceeded(receipt) || String(tx.from || '').toLowerCase() !== wallet.toLowerCase() || String(tx.to || '').toLowerCase() !== String(proof.transactionTo || '').toLowerCase() || String(tx.input || '').trim().toLowerCase() !== String(proof.transactionData || '').trim().toLowerCase() || BigInt(tx.value || '0x0') !== BigInt(proof.transactionValue || '0x0') || receipt.blockNumber == null) {
      const reason = 'transaction confirmation did not match the verified LI.FI proof'
      console.error('LI.FI completion validation failed', { chain: Number(fromChain), transactionHash, wallet, fromToken, toToken, normalizedFromToken, normalizedToToken, completionStatus: 'transaction_not_confirmed', validationFailureReason: reason })
      return apiError(res, 422, 'TRANSACTION_NOT_CONFIRMED', 'The LI.FI transaction was not confirmed successfully.')
    }
    const timestamp = new Date().toISOString()
    const persisted = await persistLifiSwap({ wallet, transactionHash, fromChain, toChain, fromToken: normalizedFromToken, toToken: normalizedToToken, fromAmount, toAmount, volumeUsd: proof.volumeUsd, timestamp, blockNumber: receipt.blockNumber, quoteId, fromDecimals: proof.fromDecimals, toDecimals: proof.toDecimals })
    const season = await getSeasonForTimestamp(timestamp)
    const saved = await getAdminSettings().catch(() => null)
    const configuration = getEffectivePointsConfiguration(saved)
    const calculation = await calculateSamuraiPoints({ verification_status: 'verified', chain_id: Number(fromChain), volume_usd: proof.volumeUsd == null ? null : Number(proof.volumeUsd), timestamp, input_mint: normalizedFromToken, output_mint: normalizedToToken, input_amount_raw: fromAmount, input_decimals: Number.isInteger(proof.fromDecimals) ? proof.fromDecimals : 18 }, configuration)
    const points = await awardSamuraiPoints({ signature: transactionHash, ...calculation, seasonId: season?.id || null })
    return json(res, 200, { success: true, duplicate: false, swap: persisted.swap, points: pointsView(points) })
  } catch (error) {
    console.error('LI.FI completion failed', { chain: Number(fromChain), transactionHash, wallet, fromToken, toToken, normalizedFromToken, normalizedToToken, completionStatus: 'failed', validationFailureReason: error?.message || String(error) })
    return apiError(res, 502, 'LIFI_COMPLETION_ERROR', error?.message || 'LI.FI swap completion could not be recorded.')
  }
}