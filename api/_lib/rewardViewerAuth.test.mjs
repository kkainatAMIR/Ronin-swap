import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Keypair } from '@solana/web3.js'
import {
  buildRewardViewerMessage,
  createRewardViewerSession,
  getRewardViewerSessionWallet,
  normalizeRewardViewerWallet,
  rewardViewerWalletMatches,
} from './rewardViewerAuth.mjs'

process.env.REWARD_VIEWER_SESSION_SECRET = 'test-only-reward-viewer-session-secret'

const wallet = '0x1234567890abcdef1234567890abcdef12345678'

function requestWithCookie(cookie) {
  return { headers: { cookie: cookie.split(';')[0] } }
}

test('reward viewer session is valid only for the wallet that signed in', () => {
  const session = createRewardViewerSession(wallet)
  const req = requestWithCookie(session.cookie)

  assert.equal(getRewardViewerSessionWallet(req), wallet)
  assert.equal(rewardViewerWalletMatches(req, wallet.toUpperCase().replace('0X', '0x')), true)
  assert.equal(rewardViewerWalletMatches(req, '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'), false)
})

test('reward viewer session rejects tampering and expiration', () => {
  const session = createRewardViewerSession(wallet, 1_000_000)
  const tampered = requestWithCookie(session.cookie.replace(wallet, '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'))
  const expired = requestWithCookie(session.cookie)

  assert.equal(getRewardViewerSessionWallet(tampered, 1_000_000), null)
  assert.equal(getRewardViewerSessionWallet(expired, 20_000_000), null)
})

test('reward viewer wallet normalization accepts Solana and EVM address forms only', () => {
  assert.equal(normalizeRewardViewerWallet(wallet.toUpperCase().replace('0X', '0x')), wallet)
  const solanaWallet = Keypair.generate().publicKey.toBase58()
  assert.equal(normalizeRewardViewerWallet(solanaWallet), solanaWallet)
  assert.equal(normalizeRewardViewerWallet('not-a-wallet'), null)
})

test('viewer challenge binds a short-lived nonce to the wallet and read-only purpose', () => {
  const message = buildRewardViewerMessage({
    wallet,
    nonce: 'server-random-nonce',
    domain: 'ronin.example',
    issuedAt: 1_000,
    expiresAt: 301_000,
  })
  assert.match(message, /Domain: ronin\.example/)
  assert.match(message, new RegExp(`Wallet: ${wallet}`))
  assert.match(message, /does not authorize transactions or token transfers/)
  assert.match(message, /Nonce: server-random-nonce/)
})

test('reward auth route is registered for session verification', async () => {
  const routes = await readFile(new URL('../_routes.mjs', import.meta.url), 'utf8')
  assert.match(routes, /'GET \/api\/rewards\/auth':\s+rewardsAuth/)
  assert.match(routes, /'POST \/api\/rewards\/auth':\s+rewardsAuth/)
})
