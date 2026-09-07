  
  import {
  JUPITER_REFERRAL_ACCOUNT,
  JUPITER_REFERRAL_FEE_BPS,
  apiError,
  fetchJupiter,
  isJupiterConfigured,
  isValidAmount,
  isValidSlippageBps,
  json,
  readUpstream,
} from '../_lib/roninBackend.mjs'
import { isValidMintAddress, isValidPublicKey } from '../_lib/solanaValidation.mjs'

const DEFAULT_SLIPPAGE_BPS = 100 // 1%
export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')

  const { inputMint, outputMint, amount, taker, slippageBps } = req.query || {}
  if (!isValidMintAddress(inputMint)) return apiError(res, 400, 'INVALID_INPUT_MINT', 'inputMint must be a valid Solana mint address.')
  if (!isValidMintAddress(outputMint)) return apiError(res, 400, 'INVALID_OUTPUT_MINT', 'outputMint must be a valid Solana mint address.')
  if (inputMint === outputMint) return apiError(res, 400, 'SAME_MINT', 'inputMint and outputMint must be different.')
  if (!isValidAmount(amount)) return apiError(res, 400, 'INVALID_AMOUNT', 'amount must be a positive integer in base units.')
  if (!isValidSlippageBps(slippageBps)) return apiError(res, 400, 'INVALID_SLIPPAGE', 'slippageBps must be an integer from 0 to 5000.')
  if (taker && !isValidPublicKey(taker)) {
    return apiError(res, 400, 'INVALID_TAKER', 'taker must be a valid Solana public key.')
  }
  if (!isJupiterConfigured()) return apiError(res, 503, 'JUPITER_NOT_CONFIGURED', 'Jupiter API configuration is missing.')

  try {
    // Swap V2 is the recommended meta-aggregator flow. Referral params are
    // passed on every eligible /order request so the fee is applied to both
    // buy (SOL → RONIN) and sell (RONIN → SOL) swaps.
    const params = new URLSearchParams({
      inputMint: String(inputMint),
      outputMint: String(outputMint),
      amount: String(amount),
      slippageBps: String(slippageBps || DEFAULT_SLIPPAGE_BPS),
      swapMode: 'ExactIn',
      referralAccount: JUPITER_REFERRAL_ACCOUNT,
      referralFee: String(JUPITER_REFERRAL_FEE_BPS),
    })
    if (taker) params.set('taker', String(taker))

    const upstream = await fetchJupiter(`/swap/v2/order?${params}`, { headers: { Accept: 'application/json' } })
    const body = await readUpstream(upstream)
    if (!upstream.ok) {
      const referralError = /referralAccount is initialized/i.test(body?.error || body?.message || '')
      if (referralError) {
        return apiError(res, upstream.status, 'JUPITER_REFERRAL_NOT_INITIALIZED', 'Jupiter referral setup is not initialized for Swap V2.')
      }
      return apiError(res, upstream.status >= 500 ? 502 : upstream.status, 'JUPITER_API_ERROR', body?.error || body?.message || 'Jupiter order request failed.')
    }
    return json(res, 200, body)
  } catch (error) {
    console.error('order proxy error', error)
    return apiError(res, error?.name === 'AbortError' ? 504 : 502, error?.name === 'AbortError' ? 'JUPITER_TIMEOUT' : 'JUPITER_NETWORK_ERROR', error?.name === 'AbortError' ? 'Jupiter did not respond in time.' : 'Unable to reach Jupiter right now.')
  }
}
