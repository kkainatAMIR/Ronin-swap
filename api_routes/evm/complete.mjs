import { apiError, json, parseBody, rateLimit } from '../../api/_lib/roninBackend.mjs'
import { ethereumRpc, ethereumChainId, isEthereumAddress, verifyQuoteProof } from '../../api/_lib/ethereum.mjs'
import { awardSamuraiPoints, getAdminSettings, getEthereumSwapByHash, getPointsBySignature, getSeasonForTimestamp, isSupabaseConfigured, persistEthereumSwap } from '../../api/_lib/supabaseBackend.mjs'
import { calculateSamuraiPoints, getEffectivePointsConfiguration } from '../../api/_lib/samuraiPoints.mjs'

function hash(value) { return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) }

function formatPoints(points) {
  if (!points) return {
    qualified: false,
    pointsAwarded: 0,
    qualifyingVolumeUsd: 0,
    walletSeasonPoints: 0,
    walletLifetimePoints: 0,
    reason: 'POINTS_RECORD_MISSING',
    eligibility_status: 'not_qualified',
  }
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
  console.log('[ETH-POINTS-TRACE] complete request received', { transactionHash, wallet, sellToken, buyToken, sellAmount, buyAmount, chainId: body.chainId, hasQuoteProof: Boolean(quoteProof) })
  if (!hash(transactionHash) || !isEthereumAddress(wallet) || !validAsset(sellToken) || !validAsset(buyToken) || sellToken === buyToken || !/^\d+$/.test(String(sellAmount || '')) || !/^\d+$/.test(String(buyAmount || ''))) return apiError(res, 400, 'INVALID_COMPLETION', 'A valid Ethereum transaction completion is required.')
  if (Number(body.chainId) !== ethereumChainId()) return apiError(res, 400, 'INVALID_CHAIN', 'Ethereum Mainnet is required.')
  try {
    const trustedQuote = verifyQuoteProof(quoteProof, { chainId: 1, wallet, sellToken, buyToken, sellAmount })
    console.log('[ETH-POINTS-TRACE] quote verified', { buyAmount: trustedQuote.buyAmount, volumeUsd: trustedQuote.volumeUsd, to: trustedQuote.to, value: trustedQuote.value })
    if (String(trustedQuote.buyAmount) !== String(buyAmount)) return apiError(res, 400, 'QUOTE_INVALID', 'The completion does not match the quoted output.')
    const existing = await getEthereumSwapByHash(transactionHash)
    console.log('[ETH-POINTS-TRACE] existing swap found/not found', { found: Boolean(existing), signature: existing?.signature || null, volumeUsd: existing?.volume_usd ?? null, verificationStatus: existing?.verification_status || null })
    if (existing) {
      const existingPoints = await getPointsBySignature(transactionHash)
      console.log('[ETH-POINTS-TRACE] existing points found', { found: Boolean(existingPoints), signature: existingPoints?.signature || null, status: existingPoints?.eligibility_status || null, points_awarded: existingPoints?.points_awarded || null })
      if (existingPoints) return json(res, 200, { success: true, duplicate: true, swap: existing, points: formatPoints(existingPoints) })
      const season = await getSeasonForTimestamp(existing.timestamp)
      const saved = await getAdminSettings().catch(() => null)
      const configuration = getEffectivePointsConfiguration(saved)
      console.log('[ETH-POINTS-TRACE] duplicate path calculation input', { signature: transactionHash, volumeUsd: Number(existing.volume_usd ?? 0), input_mint: existing.input_mint, output_mint: existing.output_mint, seasonId: season?.id || null, minimum: configuration.minimumQualifyingSwapUsd, pointsEnabled: configuration.pointsEnabled })
      const calculation = await calculateSamuraiPoints({ verification_status: existing.verification_status || 'verified', chain_id: Number(existing.chain_id ?? 1), volume_usd: Number(existing.volume_usd ?? 0), timestamp: existing.timestamp, input_mint: existing.input_mint, output_mint: existing.output_mint, input_amount_raw: existing.input_amount_raw, input_decimals: Number(existing.input_decimals ?? 18) }, configuration)
      console.log('[ETH-POINTS-TRACE] duplicate path calculation result', calculation)
      const points = await awardSamuraiPoints({ signature: transactionHash, ...calculation, seasonId: season?.id || null })
      console.log('[ETH-POINTS-TRACE] duplicate path awarded points', points)
      return json(res, 200, { success: true, duplicate: true, swap: existing, points: formatPoints(points || { eligibility_status: calculation.qualified ? 'qualified' : 'not_qualified', points_awarded: calculation.pointsAwarded || 0, exclusion_reason: calculation.exclusionReason || null, qualifying_volume_usd: calculation.qualifyingVolumeUsd || 0, season_points: 0 }) })
    }
    console.log('[ETH-POINTS-TRACE] persistEthereumSwap entered', { transactionHash, wallet, sellToken, buyToken, sellAmount, buyAmount, volumeUsd: trustedQuote.volumeUsd })
    const tx = await ethereumRpc('eth_getTransactionByHash', [transactionHash])
    const receipt = await ethereumRpc('eth_getTransactionReceipt', [transactionHash])
    if (!tx || !receipt || receipt.status !== '0x1' || String(tx.from).toLowerCase() !== wallet.toLowerCase() || String(tx.to).toLowerCase() !== String(trustedQuote.to).toLowerCase() || String(tx.input || '').toLowerCase() !== String(trustedQuote.data || '').toLowerCase() || BigInt(tx.value || '0x0') !== BigInt(trustedQuote.value || '0') || receipt.blockNumber == null) return apiError(res, 422, 'TRANSACTION_NOT_CONFIRMED', 'The Ethereum transaction was not confirmed successfully.')
    const block = await ethereumRpc('eth_getBlockByNumber', [receipt.blockNumber, false])
    const timestamp = block?.timestamp ? new Date(Number.parseInt(block.timestamp, 16) * 1000).toISOString() : new Date().toISOString()
    const persisted = await persistEthereumSwap({ wallet, transactionHash, sellToken, buyToken, sellAmount, buyAmount, sellDecimals: trustedQuote.sellDecimals, buyDecimals: trustedQuote.buyDecimals, volumeUsd: trustedQuote.volumeUsd, timestamp, blockNumber: receipt.blockNumber })
    if (!persisted?.swap?.signature) throw new Error('ETHEREUM_SWAP_INSERT_FAILED')
    console.log('[ETH-POINTS-TRACE] persistEthereumSwap result', { signature: persisted.swap.signature, volumeUsd: persisted.swap.volume_usd, verificationStatus: persisted.swap.verification_status })
    const season = await getSeasonForTimestamp(timestamp)
    const saved = await getAdminSettings().catch(() => null)
    const configuration = getEffectivePointsConfiguration(saved)
    console.log('[ETH-POINTS-TRACE] calculateSamuraiPoints entered', { signature: transactionHash, volumeUsd: Number(trustedQuote.volumeUsd), seasonId: season?.id || null, min: configuration.minimumQualifyingSwapUsd, enabled: configuration.pointsEnabled, pointsPerUsd: configuration.pointsPerUsd })
    const calculation = await calculateSamuraiPoints({ verification_status: 'verified', chain_id: 1, volume_usd: Number(trustedQuote.volumeUsd), timestamp, input_mint: sellToken, output_mint: buyToken, input_amount_raw: sellAmount, input_decimals: trustedQuote.sellDecimals }, configuration)
    console.log('[ETH-POINTS-TRACE] calculation result', calculation)
    let points
    try {
      console.log('[ETH-POINTS-TRACE] awardSamuraiPoints entered', { signature: transactionHash, qualified: calculation.qualified, seasonId: season?.id || null, qualifyingVolumeUsd: calculation.qualifyingVolumeUsd, finalPoints: calculation.finalPoints })
      points = await awardSamuraiPoints({ signature: transactionHash, ...calculation, seasonId: season?.id || null })
      console.log('[ETH-POINTS-TRACE] RPC result', points)
    } catch (error) {
      console.error('[ETH POINTS AWARD ERROR]', {
        message: error?.message || String(error),
        status: error?.status || null,
        body: error?.body || null,
      })
      throw error
    }
    console.log('[ETH-POINTS-TRACE] samurai_points row', points)
    return json(res, 200, { success: true, duplicate: false, swap: persisted.swap, points: formatPoints(points || { eligibility_status: calculation.qualified ? 'qualified' : 'not_qualified', points_awarded: calculation.pointsAwarded || 0, exclusion_reason: calculation.exclusionReason || null, qualifying_volume_usd: calculation.qualifyingVolumeUsd || 0, season_points: 0 }) })
  } catch (error) {
    console.error('Ethereum completion failed:', error?.message || error)
    return apiError(res, 502, 'ETHEREUM_COMPLETION_ERROR', 'Ethereum swap completion could not be recorded.')
  }
}