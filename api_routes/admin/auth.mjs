import { apiError, json, parseBody, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import { createAdminChallenge, verifyAdminChallenge, isAdminConfigured, requireAdmin } from '../../api/_lib/adminAuth.mjs'

export default async function handler(req, res) {
  if (!isAdminConfigured()) return apiError(res, 503, 'ADMIN_NOT_CONFIGURED', 'Admin wallet authentication is not configured.')
  if (!(await rateLimitPersistent(req, `admin_auth:${req.query?.action || 'unknown'}`, 10, 60_000))) return apiError(res, 429, 'RATE_LIMITED', 'Authentication is temporarily rate limited.')
  try {
    const body = parseBody(req) || {}
    if (req.method === 'POST' && req.query?.action === 'challenge') return json(res, 200, await createAdminChallenge(String(body.wallet || '').trim()))
    if (req.method === 'POST' && req.query?.action === 'verify') {
      const result = await verifyAdminChallenge({ wallet: String(body.wallet || '').trim(), nonce: String(body.nonce || ''), signature: body.signature })
      res.setHeader('Set-Cookie', result.cookie)
      return json(res, 200, { authenticated: true, wallet: result.wallet })
    }
    if (req.method === 'POST' && req.query?.action === 'logout') {
      res.setHeader('Set-Cookie', 'ronin_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
      return json(res, 200, { authenticated: false })
    }
    if (req.method === 'GET' && req.query?.action === 'session') return json(res, 200, { authenticated: await requireAdmin(req, res), wallet: req.adminWallet || null })
    return apiError(res, 404, 'ADMIN_AUTH_ROUTE_NOT_FOUND', 'Admin authentication route not found.')
  } catch (error) {
    const code = ['ADMIN_WALLET_NOT_ALLOWED', 'ADMIN_CHALLENGE_INVALID', 'ADMIN_SIGNATURE_INVALID', 'INVALID_ADMIN_WALLET'].includes(error?.message) ? error.message : 'ADMIN_AUTH_ERROR'
    return apiError(res, 401, code, 'Admin wallet authentication failed.')
  }
}