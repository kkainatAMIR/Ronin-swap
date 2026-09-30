import { SOL_INCINERATOR_BASE_URL, incineratorHeaders, json, parseBody, readUpstream } from '../../api/_lib/roninBackend.mjs'
import { validateBurnRequest } from '../../api/_lib/solanaValidation.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })
  // FIXED: Removed the `if (!SOL_INCINERATOR_API_KEY)` guard that was
  // blocking ALL burn preview requests when the API key was not set.
  // The Sol Incinerator v2 API (https://v2.api.sol-incinerator.com)
  // works WITHOUT an API key — the key is optional (used only for
  // rate-limiting bypass). The incineratorHeaders() function already
  // conditionally adds the x-api-key header only if the key is set.
  const parsed = validateBurnRequest(parseBody(req), res)
  if (!parsed) return

  try {
    const upstream = await fetch(`${SOL_INCINERATOR_BASE_URL}/burn/preview`, { method: 'POST', headers: incineratorHeaders(), body: JSON.stringify(parsed) })
    const body = await readUpstream(upstream)
    if (!upstream.ok) return json(res, upstream.status, { error: body?.error || body?.message || 'Sol Incinerator could not preview this burn.' })
    return json(res, 200, body)
  } catch (error) {
    console.error('burn preview proxy error', error)
    return json(res, 502, { error: 'Unable to reach the burn service right now.' })
  }
}
