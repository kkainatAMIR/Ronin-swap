import { apiError, json, parseBody, rateLimit } from '../../api/_lib/roninBackend.mjs'
import { lifiRequest } from '../../api/_lib/lifi.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'lifi-status', 60)) return apiError(res, 429, 'RATE_LIMITED', 'Too many LI.FI status requests.')
  const body = parseBody(req) || {}
  if (!body.txHash || !body.fromChain) return apiError(res, 400, 'INVALID_LIFI_STATUS', 'Transaction hash and source chain are required.')
  try {
    const params = new URLSearchParams({ txHash: String(body.txHash), fromChain: String(body.fromChain), ...(body.toChain ? { toChain: String(body.toChain) } : {}), ...(body.bridge ? { bridge: String(body.bridge) } : {}) })
    return json(res, 200, { success: true, status: await lifiRequest(`/status?${params}`) })
  } catch {
    return apiError(res, 502, 'LIFI_STATUS_ERROR', 'LI.FI status is unavailable.')
  }
}