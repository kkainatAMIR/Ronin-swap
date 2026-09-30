// =====================================================================
// POST /api/wallet-link/verify
// =====================================================================
// Body: { challengeId, evmSignature, solanaSignature }
//
// Verifies BOTH signatures against the challenge's stored messages
// and atomically creates the wallet link.
//
// Steps:
//   1. Validate input format.
//   2. Fetch the PENDING challenge row from the DB (the message
//      strings come from the DB — the frontend never supplies them).
//   3. Verify EVM signature via ethers.verifyMessage (EIP-191
//      personal_sign) → recovered address must equal challenge.evm_wallet.
//   4. Verify Solana signature via node:crypto ed25519 → must verify
//      against challenge.solana_wallet.
//   5. Call the link_wallets RPC, which atomically:
//        - re-locks the challenge row (FOR UPDATE)
//        - re-checks status=PENDING + not expired
//        - re-checks signer identity (defense in depth)
//        - inserts (or reactivates) the wallet_links row
//        - marks the challenge USED
//   6. Return the new link record.
//
// SECURITY:
//   * A replay (same challengeId twice) fails at step 5: the RPC
//     raises CHALLENGE_NOT_PENDING because the first /verify already
//     marked it USED.
//   * A fake signature fails at step 3 or 4.
//   * A "switched signer" attack (sign with 0xATTACKER, submit as
//     challenge bound to 0xABC) fails at step 3: ethers.verifyMessage
//     recovers 0xATTACKER, which != challenge.evm_wallet.
//   * An expired challenge fails at step 2 (PENDING filter wouldn't
//     match if a cron had marked it EXPIRED) AND at step 5 (the RPC
//     also checks expires_at < now()).
// =====================================================================

import { apiError, json, parseBody, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import {
  getPendingChallenge,
  verifyEvmSignature,
  verifySolanaSignature,
  callLinkWalletsRpc,
  isWalletLinkStoreConfigured,
  validateWalletLinkOrigin,
  logWalletLinkEvent,
  checkVerifyFailureLimit,
  recordVerifyFailure,
} from '../../api/_lib/walletLinkAuth.mjs'

function isValidChallengeId(value) {
  return typeof value === 'string' && /^wlc-[a-f0-9]{16,64}$/.test(value)
}
function isValidEvmSignature(value) {
  // 0x + 130 hex chars (65 bytes r+s+v). Allow legacy EIP-191 sigs.
  return typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value)
}
function isValidSolanaSignature(value) {
  // base64 ed25519 signature → 88 chars incl. padding
  return typeof value === 'string' && /^[A-Za-z0-9+/]{86,88}={0,2}$/.test(value)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  // SECURITY-4: Origin/Host validation — wallet-link endpoints only.
  if (!validateWalletLinkOrigin(req)) {
    return apiError(res, 403, 'ORIGIN_NOT_ALLOWED', 'This request origin is not allowed for wallet-link operations.')
  }
  if (!(await rateLimitPersistent(req, 'wallet_link_verify', 10, 60_000))) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many verify attempts. Try again shortly.')
  }
  if (!isWalletLinkStoreConfigured()) {
    return apiError(res, 503, 'WALLET_LINK_STORE_UNAVAILABLE',
      'The wallet-link store is not configured on the server.')
  }

  const body = parseBody(req) || {}
  const challengeId = String(body.challengeId || body.challenge_id || '').trim()
  const evmSignature = String(body.evmSignature || body.evm_signature || '').trim()
  const solanaSignature = String(body.solanaSignature || body.solana_signature || '').trim()

  if (!isValidChallengeId(challengeId)) {
    return apiError(res, 400, 'INVALID_CHALLENGE_ID',
      'A valid challengeId is required.')
  }
  // SECURITY-6: Per-challengeId failure rate limiting. After 5 failed
  // verify attempts (EVM/Solana signature invalid), block further verify
  // attempts for this challengeId for 5 minutes. This is NARROW (per-
  // challengeId, not per-IP) so it doesn't interfere with legitimate
  // mobile retries (which use a new challengeId each attempt).
  if (!checkVerifyFailureLimit(challengeId)) {
    logWalletLinkEvent('WALLET_LINK_RATE_LIMITED', { challengeId, reason: 'verify_failures_exceeded' })
    return apiError(res, 429, 'RATE_LIMITED', 'Too many failed verify attempts for this challenge. Please start a new link attempt.')
  }
  if (!isValidEvmSignature(evmSignature)) {
    return apiError(res, 400, 'INVALID_EVM_SIGNATURE',
      'A valid EVM signature (0x + 130 hex chars) is required.')
  }
  if (!isValidSolanaSignature(solanaSignature)) {
    return apiError(res, 400, 'INVALID_SOLANA_SIGNATURE',
      'A valid Solana signature (base64, 64 bytes) is required.')
  }

  // Step 2: fetch the challenge row. The messages stored on the row
  // are the source of truth — the frontend never supplies them.
  let challenge
  try {
    challenge = await getPendingChallenge(challengeId)
  } catch (error) {
    // SECURITY-8: Don't leak internal store errors — log a safe event
    // and return a generic message.
    logWalletLinkEvent('WALLET_LINK_STORE_UNAVAILABLE', { challengeId, code: 'get_pending_failed' })
    return apiError(res, 503, 'WALLET_LINK_STORE_UNAVAILABLE',
      'Could not read the challenge. Try again shortly.')
  }

  if (!challenge) {
    // SECURITY-7: Log replay/expired/not-found events. This covers:
    //   * Replay (challenge was already USED by a previous verify)
    //   * Expired (challenge was marked EXPIRED by supersede or cron)
    //   * Not found (challengeId doesn't exist)
    logWalletLinkEvent('WALLET_LINK_REPLAY_REJECTED', { challengeId, reason: 'challenge_not_pending' })
    return apiError(res, 404, 'CHALLENGE_NOT_FOUND',
      'The challenge was not found, has expired, or has already been used.')
  }

  if (challenge.expiresAt < Date.now()) {
    logWalletLinkEvent('WALLET_LINK_EXPIRED', { challengeId, solanaWallet: challenge.solanaWallet, evmWallet: challenge.evmWallet })
    return apiError(res, 410, 'CHALLENGE_EXPIRED',
      'The challenge has expired. Request a new link challenge.')
  }

  // Step 3: verify EVM signature.
  if (!verifyEvmSignature({
    message: challenge.messageEvm,
    signature: evmSignature,
    expectedAddress: challenge.evmWallet,
  })) {
    recordVerifyFailure(challengeId)
    logWalletLinkEvent('WALLET_LINK_SIGNATURE_INVALID', { challengeId, evmWallet: challenge.evmWallet, code: 'EVM_SIGNATURE_INVALID' })
    return apiError(res, 401, 'EVM_SIGNATURE_INVALID',
      'The EVM signature could not be verified. Make sure you signed the exact challenge message with the correct MetaMask account.')
  }

  // Step 4: verify Solana signature.
  if (!verifySolanaSignature({
    message: challenge.messageSolana,
    signature: solanaSignature,
    expectedAddress: challenge.solanaWallet,
  })) {
    recordVerifyFailure(challengeId)
    logWalletLinkEvent('WALLET_LINK_SIGNATURE_INVALID', { challengeId, solanaWallet: challenge.solanaWallet, code: 'SOLANA_SIGNATURE_INVALID' })
    return apiError(res, 401, 'SOLANA_SIGNATURE_INVALID',
      'The Solana signature could not be verified. Make sure you signed the exact challenge message with the correct Phantom wallet.')
  }

  // Step 5: call link_wallets RPC — atomically mark USED + insert link.
  let rpcResult
  try {
    rpcResult = await callLinkWalletsRpc({
      challengeId,
      evmSignature,
      solanaSignature,
      evmSigner: challenge.evmWallet,
      solanaSigner: challenge.solanaWallet,
    })
  } catch (error) {
    const code = error?.code || error?.message || 'LINK_RPC_FAILED'
    // SECURITY-7 + SECURITY-8: Log the RPC failure code + challengeId
    // (safe identifiers only — no signatures, nonces, or request bodies).
    // This REPLACES the previous bodyPreview diagnostic log which could
    // leak internal Supabase/Postgres error details.
    logWalletLinkEvent('WALLET_LINK_RPC_FAILED', { challengeId, code, reason: 'link_rpc_error' })

    // Log specific security-relevant events
    if (code === 'EVM_SIGNER_MISMATCH' || code === 'SOLANA_SIGNER_MISMATCH') {
      logWalletLinkEvent('WALLET_LINK_SIGNER_MISMATCH', { challengeId, code })
    }
    if (code === 'EVM_ALREADY_LINKED_ELSEWHERE') {
      logWalletLinkEvent('WALLET_LINK_ALREADY_LINKED', { challengeId, evmWallet: challenge.evmWallet })
    }
    if (code === 'CHALLENGE_NOT_PENDING') {
      logWalletLinkEvent('WALLET_LINK_REPLAY_REJECTED', { challengeId, reason: 'rpc_concurrent' })
    }

    const friendly = {
      CHALLENGE_NOT_FOUND: 'The challenge was not found.',
      CHALLENGE_NOT_PENDING: 'This challenge has already been used. Request a new one.',
      CHALLENGE_EXPIRED: 'The challenge has expired. Request a new one.',
      EVM_SIGNER_MISMATCH: 'The EVM signer does not match the challenge.',
      SOLANA_SIGNER_MISMATCH: 'The Solana signer does not match the challenge.',
      EVM_ALREADY_LINKED_ELSEWHERE: 'This EVM wallet is already linked to a different Solana wallet. Unlink it first.',
    }[code] || 'Could not create the wallet link.'
    // Return the response with the code so the WalletLinkPanel can
    // show the actionable hint for THIS specific code.
    return apiError(res, 409, code, friendly)
  }

  // SECURITY-7: Log successful link creation.
  logWalletLinkEvent('WALLET_LINK_SUCCESS', {
    challengeId,
    solanaWallet: challenge.solanaWallet,
    evmWallet: challenge.evmWallet,
  })

  return json(res, 200, {
    success: true,
    link: rpcResult.link,
    solanaWallet: rpcResult.solana_wallet,
    evmWallet: rpcResult.evm_wallet,
    status: rpcResult.status,
    message: 'Wallet successfully linked. Your Samurai Points from this EVM wallet will now be included in your Solana reward balance.',
  })
}
