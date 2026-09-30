import { SOL_INCINERATOR_BASE_URL, incineratorHeaders, json, parseBody, readUpstream } from '../../api/_lib/roninBackend.mjs'
import { validateBurnRequest } from '../../api/_lib/solanaValidation.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })
  // FIXED: Removed the `if (!SOL_INCINERATOR_API_KEY)` guard that was
  // blocking ALL burn build requests when the API key was not set.
  // The Sol Incinerator v2 API works WITHOUT an API key — the key is
  // optional (rate-limiting bypass). incineratorHeaders() already
  // conditionally adds the x-api-key header only if the key is set.
  const parsed = validateBurnRequest(parseBody(req), res)
  if (!parsed) return

  try {
    const upstream = await fetch(`${SOL_INCINERATOR_BASE_URL}/burn`, { method: 'POST', headers: incineratorHeaders(), body: JSON.stringify(parsed) })
    const body = await readUpstream(upstream)
    if (!upstream.ok || !body?.serializedTransaction) return json(res, upstream.ok ? 502 : upstream.status, { error: body?.error || body?.message || 'The burn transaction could not be prepared.' })
    return json(res, 200, body)
  } catch (error) {
    console.error('burn build proxy error', error)
    return json(res, 502, { error: 'Unable to reach the burn service right now.' })
  }
}
