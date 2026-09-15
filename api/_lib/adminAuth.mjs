import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PublicKey } from '@solana/web3.js'

const challenges = new Map()
const SESSION_TTL_SECONDS = 60 * 60 * 8

function runtimeEnv() {
  return globalThis.__RONIN_LOCAL_ENV__ || process.env
}

function readLocalEnvFile() {
  const localEnvPath = path.resolve(process.cwd(), '.env.local')
  if (!fs.existsSync(localEnvPath)) return {}

  const env = {}
  const file = fs.readFileSync(localEnvPath, 'utf8')
  for (const line of file.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue

    const separatorIndex = trimmed.indexOf('=')
    const key = trimmed.slice(0, separatorIndex).trim()
    const rawValue = trimmed.slice(separatorIndex + 1).trim()

    if (!key) continue

    env[key] = rawValue.replace(/^['"]|['"]$/g, '')
  }

  return env
}

function configuredWallets() {
  const env = { ...readLocalEnvFile(), ...runtimeEnv() }
  return String(env.ADMIN_WALLET_ADDRESSES || env.ADMIN_WALLET_ADDRESS || '')
    .split(',').map((value) => value.trim()).filter(Boolean)
}

function sessionSecret() {
  const env = { ...readLocalEnvFile(), ...runtimeEnv() }
  return env.ADMIN_SESSION_SECRET || env.ADMIN_API_TOKEN || ''
}

function cookieValue(req, name) {
  const cookies = String(req.headers?.cookie || '').split(';')
  const entry = cookies.find((item) => item.trim().startsWith(`${name}=`))
  return entry ? decodeURIComponent(entry.trim().slice(name.length + 1)) : ''
}

function signSession(wallet, expiresAt) {
  const payload = `${wallet}.${expiresAt}`
  const signature = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function validSession(value) {
  const [wallet, expiresAt, supplied] = String(value || '').split('.')
  if (!wallet || !expiresAt || !supplied || !configuredWallets().includes(wallet) || Number(expiresAt) < Math.floor(Date.now() / 1000) || !sessionSecret()) return null
  const expected = crypto.createHmac('sha256', sessionSecret()).update(`${wallet}.${expiresAt}`).digest('base64url')
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return null
  return wallet
}

export function getAdminWallets() {
  return configuredWallets()
}

export function createAdminChallenge(wallet) {
  if (!configuredWallets().includes(wallet)) throw new Error('ADMIN_WALLET_NOT_ALLOWED')
  const nonce = crypto.randomBytes(24).toString('hex')
  const message = `RONIN Admin Login\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${new Date(Date.now() + 5 * 60_000).toISOString()}`
  challenges.set(nonce, { wallet, message, expiresAt: Date.now() + 5 * 60_000 })
  return { nonce, message }
}

export function verifyAdminChallenge({ wallet, nonce, signature }) {
  const challenge = challenges.get(nonce)
  challenges.delete(nonce)
  if (!challenge || challenge.wallet !== wallet || challenge.expiresAt < Date.now()) throw new Error('ADMIN_CHALLENGE_INVALID')
  let publicKey
  try { publicKey = new PublicKey(wallet) } catch { throw new Error('INVALID_ADMIN_WALLET') }
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey.toBytes())])
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' })
  const signatureBytes = Buffer.from(String(signature || ''), 'base64')
  if (signatureBytes.length !== 64 || !crypto.verify(null, Buffer.from(challenge.message), key, signatureBytes)) throw new Error('ADMIN_SIGNATURE_INVALID')
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  return { wallet, cookie: `ronin_admin_session=${encodeURIComponent(signSession(wallet, expiresAt))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}` }
}

export async function requireAdmin(req, res) {
  const wallet = validSession(cookieValue(req, 'ronin_admin_session'))
  if (!wallet) {
    res.status(401).json({ error: 'Admin wallet authentication required.', code: 'ADMIN_UNAUTHORIZED' })
    return false
  }
  req.adminWallet = wallet
  return true
}

export function isAdminConfigured() {
  return configuredWallets().length > 0 && Boolean(sessionSecret())
}
