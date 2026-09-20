import { apiError, fetchJupiter, isJupiterConfigured, json, parseBody, readUpstream } from '../../api/_lib/roninBackend.mjs'
import { isValidPublicKey } from '../../api/_lib/solanaValidation.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  const body = parseBody(req)
  const { quoteResponse, userPublicKey } = body || {}
  if (!body) return apiError(res, 400, 'INVALID_JSON', 'Request body must be valid JSON.')
  if (!quoteResponse || typeof quoteResponse !== 'object') return apiError(res, 400, 'INVALID_QUOTE', 'quoteResponse must be a Jupiter quote object.')
  if (!isValidPublicKey(userPublicKey)) return apiError(res, 400, 'INVALID_USER_PUBLIC_KEY', 'A valid Solana userPublicKey is required.')
  if (!isJupiterConfigured()) return apiError(res, 503, 'JUPITER_NOT_CONFIGURED', 'Jupiter API configuration is missing.')

  try {
    const upstream = await fetchJupiter('/swap/v1/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: 'high' } } }),
    })
    const responseBody = await readUpstream(upstream)
    if (!upstream.ok) return apiError(res, upstream.status >= 500 ? 502 : upstream.status, 'JUPITER_API_ERROR', responseBody?.error || responseBody?.message || 'Jupiter swap build failed.')
    return json(res, 200, responseBody)
  } catch (error) {
    console.error('swap proxy error', error)
    return apiError(res, error?.name === 'AbortError' ? 504 : 502, error?.name === 'AbortError' ? 'JUPITER_TIMEOUT' : 'JUPITER_NETWORK_ERROR', error?.name === 'AbortError' ? 'Jupiter did not respond in time.' : 'Unable to reach Jupiter right now.')
  }
}
