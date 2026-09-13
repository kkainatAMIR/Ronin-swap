import { json } from '../_lib/roninBackend.mjs'
import { lifiConfigSummary } from '../_lib/lifi.mjs'

export default function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' })
  return json(res, 200, lifiConfigSummary())
}
