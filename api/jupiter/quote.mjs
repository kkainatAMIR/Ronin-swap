import { apiError, fetchJupiter, isJupiterConfigured, isValidAmount, isValidSlippageBps, json, readUpstream } from '../_lib/roninBackend.mjs'
import { isValidMintAddress } from '../_lib/solanaValidation.mjs'

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  const { inputMint, outputMint, amount, slippageBps } = req.query || {}
  if (!isValidMintAddress(inputMint)) return apiError(res, 400, 'INVALID_INPUT_MINT', 'inputMint must be a valid Solana mint address.')
  if (!isValidMintAddress(outputMint)) return apiError(res, 400, 'INVALID_OUTPUT_MINT', 'outputMint must be a valid Solana mint address.')
  if (inputMint === outputMint) return apiError(res, 400, 'SAME_MINT', 'inputMint and outputMint must be different.')
  if (!isValidAmount(amount)) return apiError(res, 400, 'INVALID_AMOUNT', 'amount must be a positive integer in base units.')
  if (!isValidSlippageBps(slippageBps)) return apiError(res, 400, 'INVALID_SLIPPAGE', 'slippageBps must be an integer from 0 to 5000.')
  if (!isJupiterConfigured()) return apiError(res, 503, 'JUPITER_NOT_CONFIGURED', 'Jupiter API configuration is missing.')

  try {
    const params = new URLSearchParams({
      inputMint: String(inputMint), outputMint: String(outputMint), amount: String(amount),
      slippageBps: String(slippageBps || 50), swapMode: 'ExactIn',
    })
    const upstream = await fetchJupiter(`/swap/v1/quote?${params}`, { headers: { Accept: 'application/json' } })
    const body = await readUpstream(upstream)
    if (!upstream.ok) return apiError(res, upstream.status >= 500 ? 502 : upstream.status, 'JUPITER_API_ERROR', body?.error || body?.message || 'Jupiter quote request failed.')
    return json(res, 200, body)
  } catch (error) {
    console.error('quote proxy error', error)
    return apiError(res, error?.name === 'AbortError' ? 504 : 502, error?.name === 'AbortError' ? 'JUPITER_TIMEOUT' : 'JUPITER_NETWORK_ERROR', error?.name === 'AbortError' ? 'Jupiter did not respond in time.' : 'Unable to reach Jupiter right now.')
  }
}
