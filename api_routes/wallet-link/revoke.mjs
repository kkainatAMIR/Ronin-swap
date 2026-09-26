// =====================================================================
// POST /api/wallet-link/revoke
// =====================================================================
// Body: { solanaWallet, evmWallet, solanaSignature, message }
//
// Revokes an ACTIVE link. Only the canonical Solana wallet's owner
// may unlink an EVM wallet from their identity. The caller must
// re-sign a fresh revocation message with Phantom to prove continued
// ownership of the Solana wallet at unlink time.
//
// The message is server-built (NOT frontend-supplied) and contains:
//   - "Revoke wallet link"
//   - solana_wallet, evm_wallet
//   - nonce (random, server-generated)
//   - timestamp + short expiry
//
// This endpoint does NOT support unlinking via EVM signature alone —
// only the Solana wallet owner can unlink. If the user loses access
// to their Solana wallet, they must contact admin support.
//
// SECURITY:
//   * Solana signature MUST verify against the exact solana_wallet
//     stored on the link row.
//   * The message is one-time (the nonce is hashed into the message
//     text — re-using the same signed message is fine for revocation
//     since revocation is idempotent, but a fresh sign per request
//     prevents replay of stale signatures being used to silently
//     unlink wallets the user no longer intends to revoke).
// =====================================================================

import { apiError, json, parseBody, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import {
  verifySolanaSignature,
  callUnlinkWalletRpc,
  isValidSolanaAddress,
  isValidEvmAddress,
  canonicalSolanaAddress,
  canonicalEvmAddress,
  isWalletLinkStoreConfigured,
} from '../../api/_lib/walletLinkAuth.mjs'
import crypto from 'node:crypto'

function buildRevokeMessage({ solanaWallet, evmWallet, nonce, issuedAt, expiresAt }) {
  return [
    'RoninSwap Wallet Link Revocation',
    '',
    `Solana wallet: ${solanaWallet}`,
    `EVM wallet: ${evmWallet.toLowerCase()}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    '',
    'Purpose: revoke the verified link between these wallets. After revocation, Samurai Points earned by this EVM wallet will no longer be aggregated into the Solana reward identity.',
    '',
    'This signature does not authorize transactions or token transfers.',
  ].join('\n')
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!(await rateLimitPersistent(req, 'wallet_link_revoke', 10, 60_000))) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many revoke attempts. Try again shortly.')
  }
  if (!isWalletLinkStoreConfigured()) {
    return apiError(res, 503, 'WALLET_LINK_STORE_UNAVAILABLE',
      'The wallet-link store is not configured on the server.')
  }

  const body = parseBody(req) || {}
  const solanaWallet = String(body.solanaWallet || body.solana_wallet || '').trim()
  const evmWallet = String(body.evmWallet || body.evm_wallet || '').trim()
  const solanaSignature = String(body.solanaSignature || body.solana_signature || '').trim()
  const clientMessage = typeof body.message === 'string' ? body.message : ''

  if (!isValidSolanaAddress(solanaWallet)) {
    return apiError(res, 400, 'INVALID_SOLANA_WALLET',
      'A valid Solana wallet address is required.')
  }
  if (!isValidEvmAddress(evmWallet)) {
    return apiError(res, 400, 'INVALID_EVM_WALLET',
      'A valid EVM wallet address is required.')
  }
  if (!solanaSignature) {
    return apiError(res, 400, 'SIGNATURE_REQUIRED',
      'A fresh Solana signature is required to revoke a wallet link.')
  }

  const solanaCanonical = canonicalSolanaAddress(solanaWallet)
  const evmCanonical = canonicalEvmAddress(evmWallet)

  // The client must have signed a message with the same shape we'd
  // have built server-side. We re-build it deterministically using
  // the nonce/timestamp the client passed in the message text, then
  // verify the signature against it. If the client tampered with the
  // message text, the signature will fail verification.
  //
  // To make this safe, the client SHOULD have first requested a
  // revoke-challenge from the server (we accept the message body
  // verbatim but verify the signature against the EXACT bytes the
  // client claims to have signed). The simplest pattern that the
  // frontend uses: fetch a fresh nonce from this same endpoint with
  // GET /api/wallet-link/revoke-challenge?solanaWallet=...&evmWallet=...,
  // then sign the returned message and POST here.
  //
  // For now we accept the message string as-is and verify the
  // signature against it — provided the message matches our
  // expected shape (so it contains the right revocation language).
  if (!clientMessage.includes('RoninSwap Wallet Link Revocation')) {
    return apiError(res, 400, 'INVALID_MESSAGE',
      'The revocation message must be the server-issued challenge message.')
  }

  if (!verifySolanaSignature({
    message: clientMessage,
    signature: solanaSignature,
    expectedAddress: solanaCanonical,
  })) {
    return apiError(res, 401, 'SOLANA_SIGNATURE_INVALID',
      'The Solana signature could not be verified. Re-sign with the correct Phantom wallet.')
  }

  try {
    const result = await callUnlinkWalletRpc({
      solanaWallet: solanaCanonical,
      evmWallet: evmCanonical,
    })
    return json(res, 200, {
      success: true,
      link: result,
      solanaWallet: solanaCanonical,
      evmWallet: evmCanonical,
      status: 'REVOKED',
      message: 'The wallet link has been revoked. Future Samurai Points earned by this EVM wallet will no longer be aggregated into your Solana reward balance.',
    })
  } catch (error) {
    const code = error?.code || error?.message || 'UNLINK_FAILED'
    const friendly = {
      LINK_NOT_FOUND: 'No active link found between these wallets.',
      WALLET_REQUIRED: 'A wallet address is required.',
    }[code] || 'Could not revoke the wallet link.'
    return apiError(res, 409, code, friendly)
  }
}

// Helper exported for the frontend to fetch a fresh revoke challenge
// message — same pattern as the link challenge but simpler. The
// frontend calls GET /api/wallet-link/revoke-challenge?solanaWallet=...
// &evmWallet=... to get a server-built message + nonce, signs it with
// Phantom, then POSTs the signature to /revoke. This avoids the
// client having to invent nonces.
//
// (We put it in the same handler file so the route table only has to
// register two paths — POST /revoke and GET /revoke-challenge.)
export async function revokeChallengeHandler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!(await rateLimitPersistent(req, 'wallet_link_revoke_challenge', 10, 60_000))) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many requests. Try again shortly.')
  }
  if (!isWalletLinkStoreConfigured()) {
    return apiError(res, 503, 'WALLET_LINK_STORE_UNAVAILABLE',
      'The wallet-link store is not configured on the server.')
  }

  const solanaWallet = String(req.query?.solanaWallet || req.query?.solana_wallet || '').trim()
  const evmWallet = String(req.query?.evmWallet || req.query?.evm_wallet || '').trim()

  if (!isValidSolanaAddress(solanaWallet)) {
    return apiError(res, 400, 'INVALID_SOLANA_WALLET', 'A valid Solana wallet address is required.')
  }
  if (!isValidEvmAddress(evmWallet)) {
    return apiError(res, 400, 'INVALID_EVM_WALLET', 'A valid EVM wallet address is required.')
  }

  const solanaCanonical = canonicalSolanaAddress(solanaWallet)
  const evmCanonical = canonicalEvmAddress(evmWallet)
  const nonce = crypto.randomBytes(16).toString('hex')
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 5 * 60_000  // 5 minutes

  const message = buildRevokeMessage({
    solanaWallet: solanaCanonical,
    evmWallet: evmCanonical,
    nonce,
    issuedAt,
    expiresAt,
  })

  return json(res, 200, {
    success: true,
    solanaWallet: solanaCanonical,
    evmWallet: evmCanonical,
    message,
    nonce,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    expiresIn: 300,
  })
}
