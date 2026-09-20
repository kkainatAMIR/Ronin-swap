import { configSummary, json } from '../api/_lib/roninBackend.mjs'

export default function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' })
  return json(res, 200, configSummary())
}
