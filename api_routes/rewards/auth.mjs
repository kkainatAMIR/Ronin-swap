import crypto from 'node:crypto'
import { apiError, json, parseBody, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import {
  buildRewardViewerMessage,
  createRewardViewerSession,
  getRewardViewerSessionWallet,
  normalizeRewardViewerWallet,
  rewardViewerCookieOptions,
} from '../../api/_lib/rewardViewerAuth.mjs'
import { isSupabaseConfigured } from '../../api/_lib/supabaseBackend.mjs'
import { verifyEvmSignature, verifySolanaSignature, validateWalletLinkOrigin } from '../../api/_lib/walletLinkAuth.mjs'

const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env
const CHALLENGE_TTL_MS = 5 * 60_000

function authStoreUnavailable(operation, status) {
  return new Error(`REWARD_VIEWER_AUTH_STORE_UNAVAILABLE: ${operation} returned HTTP ${status}.`)
}

function supabaseHeaders() {
  return {
    apikey: runtimeEnv.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${runtimeEnv.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  }
}

async function fetchChallenge(nonce, wallet) {
  const response = await fetch(
    `${runtimeEnv.SUPABASE_URL}/rest/v1/reward_viewer_auth_challenges?nonce=eq.${encodeURIComponent(nonce)}&wallet_address=eq.${encodeURIComponent(wallet)}&used_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=nonce,wallet_address,message&limit=1`,
    { headers: supabaseHeaders(), signal: AbortSignal.timeout(10_000) },
  )
  if (!response.ok) throw authStoreUnavailable('challenge lookup', response.status)
  const rows = await response.json()
  return rows?.[0] || null
}

async function consumeChallenge(nonce, wallet) {
  const response = await fetch(`${runtimeEnv.SUPABASE_URL}/rest/v1/rpc/consume_reward_viewer_auth_challenge`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify({ p_nonce: nonce, p_wallet_address: wallet }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    if (String(error?.message || '').includes('REWARD_VIEWER_CHALLENGE_INVALID')) return false
    throw authStoreUnavailable('challenge consumption', response.status)
  }
  return true
}

function requestDomain(req) {
  const origin = String(req.headers?.origin || '').trim()
  if (origin) {
    try { return new URL(origin).host } catch { return '' }
  }
  return String(req.headers?.host || '').split(':')[0]
}

async function removeExpiredChallenges() {
  const response = await fetch(
    `${runtimeEnv.SUPABASE_URL}/rest/v1/reward_viewer_auth_challenges?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,
    {
      method: 'DELETE',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok) throw authStoreUnavailable('expired challenge cleanup', response.status)
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const wallet = normalizeRewardViewerWallet(req.query?.wallet)
    if (!wallet) return apiError(res, 400, 'INVALID_WALLET', 'A valid wallet address is required.')
    if (!isSupabaseConfigured()) return apiError(res, 503, 'REWARD_VIEWER_AUTH_UNAVAILABLE', 'Reward access authentication is not configured.')
    try {
      if (getRewardViewerSessionWallet(req) === wallet) return json(res, 200, { authenticated: true })
      return apiError(res, 401, 'REWARD_VIEWER_AUTH_REQUIRED', 'Verify wallet ownership to view reward details.')
    } catch (error) {
      console.error('rewards/auth session validation failed:', error?.message || error)
      return apiError(res, 503, 'REWARD_VIEWER_AUTH_UNAVAILABLE', 'Reward access authentication is not available.')
    }
  }

  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!validateWalletLinkOrigin(req)) return apiError(res, 403, 'ORIGIN_NOT_ALLOWED', 'This request origin is not allowed.')
  if (!(await rateLimitPersistent(req, 'rewards_viewer_auth', 10, 60_000))) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many authentication attempts. Try again shortly.')
  }
  if (!isSupabaseConfigured()) return apiError(res, 503, 'REWARD_VIEWER_AUTH_UNAVAILABLE', 'Reward access authentication is not configured.')

  const body = parseBody(req) || {}
  const action = String(body.action || '')
  const wallet = normalizeRewardViewerWallet(body.wallet)
  if (!wallet) return apiError(res, 400, 'INVALID_WALLET', 'A valid wallet address is required.')

  try {
    if (action === 'challenge') {
      const domain = requestDomain(req)
      if (!domain) return apiError(res, 400, 'INVALID_ORIGIN', 'The request domain could not be verified.')
      const nonce = crypto.randomBytes(32).toString('base64url')
      const issuedAt = Date.now()
      const expiresAt = issuedAt + CHALLENGE_TTL_MS
      const message = buildRewardViewerMessage({
        wallet,
        nonce,
        domain,
        issuedAt,
        expiresAt,
      })
      // Expired rows are rejected by their expiry timestamp; cleanup is only
      // storage maintenance and must not delay or prevent a new challenge.
      void removeExpiredChallenges().catch((error) => {
        console.warn('rewards/auth expired challenge cleanup failed:', error?.message || error)
      })
      const response = await fetch(`${runtimeEnv.SUPABASE_URL}/rest/v1/reward_viewer_auth_challenges`, {
        method: 'POST',
        headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify([{
          nonce,
          wallet_address: wallet,
          message,
          expires_at: new Date(expiresAt).toISOString(),
        }]),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw authStoreUnavailable('challenge creation', response.status)
      return json(res, 200, { nonce, message, expiresAt: new Date(expiresAt).toISOString() })
    }

    if (action !== 'verify') return apiError(res, 400, 'INVALID_ACTION', 'A valid authentication action is required.')

    const nonce = String(body.nonce || '')
    const signature = String(body.signature || '')
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(nonce) || !signature) {
      return apiError(res, 400, 'INVALID_AUTH_PROOF', 'A valid wallet signature is required.')
    }

    const challenge = await fetchChallenge(nonce, wallet)
    if (!challenge) return apiError(res, 401, 'REWARD_VIEWER_CHALLENGE_INVALID', 'The wallet verification challenge is expired or already used.')

    const validSignature = wallet.startsWith('0x')
      ? verifyEvmSignature({ message: challenge.message, signature, expectedAddress: wallet })
      : verifySolanaSignature({ message: challenge.message, signature, expectedAddress: wallet })
    if (!validSignature) return apiError(res, 401, 'REWARD_VIEWER_SIGNATURE_INVALID', 'The wallet signature could not be verified.')

    if (!(await consumeChallenge(nonce, wallet))) {
      return apiError(res, 401, 'REWARD_VIEWER_CHALLENGE_INVALID', 'The wallet verification challenge is expired or already used.')
    }

    const session = createRewardViewerSession(wallet)
    res.setHeader('Set-Cookie', rewardViewerCookieOptions(req, session.cookie))
    return json(res, 200, { authenticated: true, expiresAt: new Date(session.expiresAt * 1000).toISOString() })
  } catch (error) {
    console.error('rewards/auth failed:', error?.message || error)
    return apiError(res, 503, 'REWARD_VIEWER_AUTH_UNAVAILABLE', 'Reward access authentication is temporarily unavailable.')
  }
}
