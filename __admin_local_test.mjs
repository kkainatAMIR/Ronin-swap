import fs from 'node:fs'
import crypto from 'node:crypto'

const parseEnv = (text) => {
  const env = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const idx = line.indexOf('=')
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '')
    env[key] = value
  }
  return env
}

const text = fs.readFileSync('.env.local', 'utf8')
const env = parseEnv(text)
const wallet = env.ADMIN_WALLET_ADDRESS
const secret = env.ADMIN_SESSION_SECRET
const expiresAt = Math.floor(Date.now() / 1000) + 3600
const payload = `${wallet}.${expiresAt}`
const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
const cookie = `ronin_admin_session=${encodeURIComponent(`${payload}.${signature}`)}`
const body = {
  points_enabled: true,
  minimum_qualifying_swap_usd: 2,
  points_per_usd: 1,
  transaction_points_cap_enabled: false,
  transaction_points_cap: null,
  campaigns: [],
  swap_enabled: true,
  sol_rewards_enabled: false,
  platform_fee_enabled: false,
  platform_fee_bps: 0,
}

const res = await fetch('http://localhost:5174/api/admin/dashboard?resource=settings', {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    Cookie: cookie,
    'x-admin-id': 'local-test',
  },
  body: JSON.stringify(body),
})

const responseText = await res.text()
console.log('STATUS', res.status)
console.log(responseText)

const updatedText = fs.readFileSync('.env.local', 'utf8')
console.log('--- .env.local check ---')
for (const line of updatedText.split(/\r?\n/)) {
  if (line.startsWith('SAMURAI_MINIMUM_QUALIFYING_SWAP_USD=')) {
    console.log(line)
  }
}
