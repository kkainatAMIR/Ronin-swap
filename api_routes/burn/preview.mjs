import { SOL_INCINERATOR_BASE_URL, SOL_INCINERATOR_API_KEY, incineratorHeaders, json, parseBody, readUpstream } from '../../api/_lib/roninBackend.mjs'
import { validateBurnRequest } from '../../api/_lib/solanaValidation.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })
  if (!SOL_INCINERATOR_API_KEY) return json(res, 500, { error: 'Burn service is not configured on the server yet.' })
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
