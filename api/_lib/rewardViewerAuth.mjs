import crypto from 'node:crypto'
import { canonicalEvmAddress, canonicalSolanaAddress, isValidEvmAddress, isValidSolanaAddress } from './walletLinkAuth.mjs'

const COOKIE_NAME = 'ronin_reward_viewer'
const SESSION_TTL_SECONDS = 4 * 60 * 60

function runtimeEnv() {
  return globalThis.__RONIN_LOCAL_ENV__ || process.env
}

function sessionKey() {
  const env = runtimeEnv()
  const secret = env.REWARD_VIEWER_SESSION_SECRET || env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('REWARD_VIEWER_SESSION_SECRET_UNAVAILABLE')
  return crypto.createHmac('sha256', secret).update('ronin-reward-viewer-session-v1').digest()
}

export function normalizeRewardViewerWallet(wallet) {
  const value = String(wallet || '').trim()
  if (isValidSolanaAddress(value)) return canonicalSolanaAddress(value)
  if (isValidEvmAddress(value)) return canonicalEvmAddress(value)
  return null
}

export function buildRewardViewerMessage({ wallet, nonce, domain, issuedAt, expiresAt }) {
  return [
    'Ronin Samurai Rewards Access',
    '',
    `Domain: ${domain}`,
    'Purpose: Verify wallet ownership to view your Samurai Points and reward history.',
    'This signature does not authorize transactions or token transfers.',
    '',
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
  ].join('\n')
}

export function createRewardViewerSession(wallet, now = Date.now()) {
  const normalizedWallet = normalizeRewardViewerWallet(wallet)
  if (!normalizedWallet) throw new Error('INVALID_REWARD_VIEWER_WALLET')

  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS
  const payload = `${normalizedWallet}|${expiresAt}`
  const signature = crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url')
  return {
    wallet: normalizedWallet,
    expiresAt,
    cookie: `${COOKIE_NAME}=${encodeURIComponent(`${payload}|${signature}`)}; HttpOnly; SameSite=Strict; Path=/api/rewards; Max-Age=${SESSION_TTL_SECONDS}`,
  }
}

function getCookie(req) {
  const cookies = String(req.headers?.cookie || '').split(';')
  const entry = cookies.find((item) => item.trim().startsWith(`${COOKIE_NAME}=`))
  if (!entry) return ''
  try {
    return decodeURIComponent(entry.trim().slice(COOKIE_NAME.length + 1))
  } catch {
    return ''
  }
}

export function getRewardViewerSessionWallet(req, now = Date.now()) {
  const [wallet, expiresAtText, supplied] = getCookie(req).split('|')
  if (!wallet || !expiresAtText || !supplied) return null

  const normalizedWallet = normalizeRewardViewerWallet(wallet)
  const expiresAt = Number(expiresAtText)
  if (!normalizedWallet || normalizedWallet !== wallet || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return null

  const expected = crypto.createHmac('sha256', sessionKey()).update(`${wallet}|${expiresAt}`).digest('base64url')
  const suppliedBytes = Buffer.from(supplied)
  const expectedBytes = Buffer.from(expected)
  if (suppliedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) return null
  return wallet
}

export function rewardViewerWalletMatches(req, wallet) {
  const sessionWallet = getRewardViewerSessionWallet(req)
  const requestedWallet = normalizeRewardViewerWallet(wallet)
  return Boolean(sessionWallet && requestedWallet && sessionWallet === requestedWallet)
}

export function rewardViewerCookieOptions(req, cookie) {
  const protocol = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
  const host = String(req.headers?.host || '')
  if (protocol === 'https' || (!protocol && !/^localhost(?::|$)|^127\.0\.0\.1(?::|$)/i.test(host))) {
    return cookie.replace('; HttpOnly;', '; Secure; HttpOnly;')
  }
  return cookie
}

export const REWARD_VIEWER_SESSION_TTL_SECONDS = SESSION_TTL_SECONDS
