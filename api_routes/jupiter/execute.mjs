import { apiError, fetchJupiter, isJupiterConfigured, json, parseBody, readUpstream } from '../../api/_lib/roninBackend.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')

  const body = parseBody(req)
  const { signedTransaction, requestId, lastValidBlockHeight } = body || {}
  if (!body) return apiError(res, 400, 'INVALID_JSON', 'Request body must be valid JSON.')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(String(signedTransaction || ''))) return apiError(res, 400, 'INVALID_TRANSACTION', 'signedTransaction must be a base64 transaction.')
  if (String(requestId || '').length < 1 || String(requestId).length > 200) return apiError(res, 400, 'INVALID_REQUEST_ID', 'requestId is required and must be 200 characters or fewer.')
  if (lastValidBlockHeight != null && !/^\d+$/.test(String(lastValidBlockHeight))) return apiError(res, 400, 'INVALID_BLOCK_HEIGHT', 'lastValidBlockHeight must be a non-negative integer.')
  if (!isJupiterConfigured()) return apiError(res, 503, 'JUPITER_NOT_CONFIGURED', 'Jupiter API configuration is missing.')

  try {
    const payload = { signedTransaction: String(signedTransaction), requestId: String(requestId) }
    if (lastValidBlockHeight != null && lastValidBlockHeight !== '') {
      payload.lastValidBlockHeight = Number(lastValidBlockHeight)
    }

    const upstream = await fetchJupiter('/swap/v2/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    const responseBody = await readUpstream(upstream)
    if (!upstream.ok || responseBody?.error || responseBody?.code != null && Number(responseBody.code) !== 0) {
      return apiError(res, upstream.status >= 500 ? 502 : 400, 'JUPITER_API_ERROR', responseBody?.error || responseBody?.message || 'Jupiter execute failed.')
    }
    return json(res, 200, responseBody)
  } catch (error) {
    console.error('execute proxy error', error)
    return apiError(res, error?.name === 'AbortError' ? 504 : 502, error?.name === 'AbortError' ? 'JUPITER_TIMEOUT' : 'JUPITER_NETWORK_ERROR', error?.name === 'AbortError' ? 'Jupiter did not respond in time.' : 'Unable to reach Jupiter right now.')
  }
}
