// =====================================================================
// GET /api/wallet-link/list?wallet=<solanaOrEvm>
// =====================================================================
// Returns the verified reward identity for the supplied wallet:
//   {
//     inputWallet,
//     solanaWallet,             // canonical Solana payout wallet (or null)
//     linkedEvmWallets: [...],  // ACTIVE EVM wallets linked to solana_wallet
//     verified: bool,           // is the input wallet part of a verified identity?
//   }
//
// SECURITY:
//   * The handler accepts ONE wallet address. The frontend cannot
//     supply an arbitrary list — the server determines linked
//     wallets from the database only.
//   * Never returns signatures, nonces, or challenge data.
//
// This endpoint is read-only and safe to call from the frontend.
// Used by:
//   * WalletContext (to load `verifiedEvmWallets` after Phantom connects)
//   * RewardClaimPanel (to decide which UX state to show)
//   * WalletLinkPanel (to render the linked-wallets list)
// =====================================================================

import { apiError, json, rateLimitPersistent } from '../../api/_lib/roninBackend.mjs'
import {
  callGetVerifiedRewardIdentityRpc,
  isValidSolanaAddress,
  isValidEvmAddress,
  canonicalSolanaAddress,
  canonicalEvmAddress,
  isWalletLinkStoreConfigured,
} from '../../api/_lib/walletLinkAuth.mjs'

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!(await rateLimitPersistent(req, 'wallet_link_list', 60))) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many requests. Try again shortly.')
  }
  if (!isWalletLinkStoreConfigured()) {
    // No backend store — fall back gracefully: treat any valid Solana
    // wallet as an unverified identity (no linked EVMs). This lets
    // the UI still function in local dev without Supabase configured.
    const wallet = String(req.query?.wallet || '').trim()
    if (isValidSolanaAddress(wallet)) {
      return json(res, 200, {
        inputWallet: canonicalSolanaAddress(wallet),
        solanaWallet: canonicalSolanaAddress(wallet),
        linkedEvmWallets: [],
        verified: false,
      })
    }
    if (isValidEvmAddress(wallet)) {
      return json(res, 200, {
        inputWallet: canonicalEvmAddress(wallet),
        solanaWallet: null,
        linkedEvmWallets: [],
        verified: false,
      })
    }
    return apiError(res, 400, 'INVALID_WALLET', 'A valid wallet address is required.')
  }

  const wallet = String(req.query?.wallet || '').trim()
  if (!isValidSolanaAddress(wallet) && !isValidEvmAddress(wallet)) {
    return apiError(res, 400, 'INVALID_WALLET',
      'A valid Solana (32-44 char base58) or EVM (0x + 40 hex) wallet address is required.')
  }

  try {
    const identity = await callGetVerifiedRewardIdentityRpc(wallet)
    const normalizedInput = isValidSolanaAddress(wallet)
      ? canonicalSolanaAddress(wallet)
      : canonicalEvmAddress(wallet)

    // The identity RPC returns:
    //   { solana_wallet, linked_evm_wallets[], verified }
    // The linked_evm_wallets array contains lowercase 0x... addresses.
    return json(res, 200, {
      inputWallet: normalizedInput,
      solanaWallet: identity?.solana_wallet || null,
      linkedEvmWallets: Array.isArray(identity?.linked_evm_wallets) ? identity.linked_evm_wallets : [],
      verified: Boolean(identity?.verified),
    })
  } catch (error) {
    console.error('wallet-link/list failed:', error?.message || error)
    return apiError(res, 502, 'WALLET_LINK_LOOKUP_FAILED',
      'Could not load your verified wallet identity.')
  }
}
