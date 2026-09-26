// =====================================================================
// POST /api/wallet-link/challenge
// =====================================================================
// Body: { solanaWallet, evmWallet, evmChainScope? }
//
// Creates a server-issued, one-time-use, expiring link challenge.
// The handler:
//   1. validates both address formats
//   2. normalizes (Solana canonical base58, EVM lowercase 0x)
//   3. generates challenge_id + nonce from node:crypto.randomBytes
//   4. builds human-readable EVM and Solana signing messages
//   5. inserts a PENDING row in wallet_link_challenges
//   6. returns the challenge payload (messages included so the
//      frontend can pass them to MetaMask/Phantom without re-deriving
//      them — the messages are server-authoritative)
//
// The nonce MUST originate from the backend. The frontend never
// generates or influences it. The challenge is single-use; the
// /verify endpoint marks it USED atomically inside the link_wallets
// RPC.
//
// Rate-limited per IP at 8 requests / minute (link attempts are
// intentionally slow so an attacker can't brute-force challenges).
// =====================================================================

import { apiError, json, parseBody, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import {
  createLinkChallenge,
  isWalletLinkStoreConfigured,
  isValidSolanaAddress,
  isValidEvmAddress,
} from '../../api/_lib/walletLinkAuth.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!(await rateLimitPersistent(req, 'wallet_link_challenge', 8, 60_000))) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many link attempts. Try again shortly.')
  }
  if (!isWalletLinkStoreConfigured()) {
    return apiError(res, 503, 'WALLET_LINK_STORE_UNAVAILABLE',
      'The wallet-link store is not configured on the server.')
  }

  const body = parseBody(req) || {}
  const solanaWallet = String(body.solanaWallet || body.solana_wallet || '').trim()
  const evmWallet = String(body.evmWallet || body.evm_wallet || '').trim()
  // evm_chain_scope is intentionally NOT accepted. The link is between
  // two wallet addresses — chain scope is irrelevant because an EVM
  // address is one row in public.wallets regardless of which EVM chain
  // it swapped on (chain_id lives on swap_transactions / samurai_points,
  // not on wallets). See migration 20260926000000_wallet_links.sql for
  // the rationale.

  if (!isValidSolanaAddress(solanaWallet)) {
    return apiError(res, 400, 'INVALID_SOLANA_WALLET',
      'A valid Solana wallet address (32-44 char base58, on-curve) is required.')
  }
  if (!isValidEvmAddress(evmWallet)) {
    return apiError(res, 400, 'INVALID_EVM_WALLET',
      'A valid EVM wallet address (0x + 40 hex chars) is required.')
  }

  try {
    const challenge = await createLinkChallenge({ solanaWallet, evmWallet })
    return json(res, 200, {
      success: true,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      solanaWallet: challenge.solanaWallet,
      evmWallet: challenge.evmWallet,
      messageEvm: challenge.messageEvm,
      messageSolana: challenge.messageSolana,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      expiresIn: Math.floor((Date.parse(challenge.expiresAt) - Date.now()) / 1000),
    })
  } catch (error) {
    const code = error?.message || 'WALLET_LINK_CHALLENGE_FAILED'
    // Never leak internal store errors — surface a generic message.
    if (code === 'WALLET_LINK_STORE_UNAVAILABLE') {
      return apiError(res, 503, code, 'The wallet-link store is unavailable.')
    }
    if (code === 'INVALID_SOLANA_WALLET' || code === 'INVALID_EVM_WALLET') {
      return apiError(res, 400, code, 'Invalid wallet address.')
    }
    console.error('wallet-link/challenge failed:', code)
    return apiError(res, 500, 'WALLET_LINK_CHALLENGE_FAILED',
      'Could not create a link challenge. Try again shortly.')
  }
}
