// =====================================================================
// Wallet Link Service (frontend client)
// =====================================================================
// Talks to the /api/wallet-link/* endpoints. Never performs signature
// verification on the frontend — that's the backend's job. The frontend
// only:
//   1. asks the backend to create a challenge
//   2. asks MetaMask + Phantom to sign the messages returned by (1)
//   3. submits both signatures to the backend for verification
//
// The frontend never invents nonces, never aggregates wallet lists for
// the backend, and never trusts localStorage for ownership.
// =====================================================================

// POST /api/wallet-link/challenge
// Returns: { success, challengeId, nonce, solanaWallet, evmWallet,
//           messageEvm, messageSolana, issuedAt, expiresAt, expiresIn }
//
// NOTE: evmChainScope is intentionally NOT accepted. The link is
// between two wallet addresses, period — an EVM address is one row
// in public.wallets regardless of which EVM chain it swapped on.
// (See api_routes/wallet-link/challenge.mjs for the full rationale.)
export async function createWalletLinkChallenge({ solanaWallet, evmWallet } = {}) {
  if (!solanaWallet) throw new Error('A Solana wallet address is required.')
  if (!evmWallet) throw new Error('An EVM wallet address is required.')
  const response = await fetch('/api/wallet-link/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ solanaWallet, evmWallet }),
    cache: 'no-store',
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(body?.error || 'Could not create a link challenge.')
    err.code = body?.code || 'CHALLENGE_FAILED'
    throw err
  }
  return body
}

// GET /api/wallet-link/list?wallet=<solanaOrEvm>
// Returns: { inputWallet, solanaWallet, linkedEvmWallets[], verified }
//
// Read-only. The frontend can call this whenever it needs the
// verified identity for the currently-connected wallet. The backend
// determines linked wallets from the database — the frontend never
// supplies a list.
export async function getVerifiedRewardIdentity(wallet) {
  if (!wallet) throw new Error('A wallet address is required.')
  const response = await fetch(
    `/api/wallet-link/list?wallet=${encodeURIComponent(wallet)}`,
    { cache: 'no-store' }
  )
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(body?.error || 'Could not load your verified wallet identity.')
    err.code = body?.code || 'LIST_FAILED'
    throw err
  }
  return body
}

// POST /api/wallet-link/verify
// Submits both signatures for backend verification.
// Returns: { success, link, solanaWallet, evmWallet, status, message }
export async function verifyWalletLink({ challengeId, evmSignature, solanaSignature }) {
  if (!challengeId) throw new Error('A challengeId is required.')
  if (!evmSignature) throw new Error('An EVM signature is required.')
  if (!solanaSignature) throw new Error('A Solana signature is required.')
  const response = await fetch('/api/wallet-link/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, evmSignature, solanaSignature }),
    cache: 'no-store',
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(body?.error || 'Could not verify the wallet link.')
    err.code = body?.code || 'VERIFY_FAILED'
    throw err
  }
  return body
}

// GET /api/wallet-link/revoke-challenge?solanaWallet=...&evmWallet=...
// Returns a fresh revocation message for Phantom to sign.
export async function createRevokeChallenge({ solanaWallet, evmWallet }) {
  if (!solanaWallet || !evmWallet) throw new Error('Both wallets are required.')
  const response = await fetch(
    `/api/wallet-link/revoke-challenge?solanaWallet=${encodeURIComponent(solanaWallet)}&evmWallet=${encodeURIComponent(evmWallet)}`,
    { cache: 'no-store' }
  )
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(body?.error || 'Could not create a revoke challenge.')
    err.code = body?.code || 'REVOKE_CHALLENGE_FAILED'
    throw err
  }
  return body
}

// POST /api/wallet-link/revoke
// Revokes an ACTIVE link. Requires a fresh Solana signature.
export async function revokeWalletLink({ solanaWallet, evmWallet, solanaSignature, message }) {
  if (!solanaWallet || !evmWallet || !solanaSignature || !message) {
    throw new Error('solanaWallet, evmWallet, solanaSignature, and message are all required.')
  }
  const response = await fetch('/api/wallet-link/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ solanaWallet, evmWallet, solanaSignature, message }),
    cache: 'no-store',
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(body?.error || 'Could not revoke the wallet link.')
    err.code = body?.code || 'REVOKE_FAILED'
    throw err
  }
  return body
}

// =====================================================================
// Wallet-provider helpers (MetaMask + Phantom)
// =====================================================================

// Reuse the existing mobile detection + MetaMask Mobile deep-link from
// ethereumService.js — no second deep-link implementation. The swap
// flow already uses these; the wallet-link flow now uses them too.
//
// `openMetaMaskMobile` is re-exported below (after ensureMetaMaskAccount)
// so the WalletLinkPanel can call it AFTER updating its UI state.
import { isMobileBrowser } from './ethereumService'

// Returns the MetaMask provider (or null if unavailable). The
// WalletContext already does this; we re-implement here so the
// WalletLinkPanel is self-contained.
function getMetaMaskProvider() {
  if (typeof window === 'undefined') return null
  const injected = window.ethereum
  if (!injected) return null
  const providers = Array.isArray(injected?.providers) ? injected.providers : []
  return providers.find((p) => p?.isMetaMask && !p?.isPhantom)
    || (injected?.isMetaMask && !injected?.isPhantom ? injected : null)
}

// Request the user's MetaMask account (triggers the connect popup if
// not already connected). Returns the lowercase 0x... address.
//
// MOBILE HANDLING:
//   On a normal mobile browser (Safari/Chrome), window.ethereum is
//   undefined — MetaMask is not injected. We signal this case to the
//   caller by returning the EVM_REDIRECTING_TO_METAMASK_MOBILE
//   sentinel; the caller is responsible for (a) updating its UI to
//   show a waiting state and THEN (b) calling openMetaMaskMobile() to
//   trigger the deep-link navigation.
//
//   IMPORTANT: We intentionally do NOT call openMetaMaskMobile() from
//   inside this function. Doing so would set window.location.href
//   BEFORE the caller had a chance to update its React state, which
//   caused a "Can't perform a React state update on an unmounted
//   component" crash on mobile Safari/Chrome (the navigation starts
//   tearing down the component before setStep() runs). By returning
//   the sentinel and letting the caller decide WHEN to navigate, we
//   give React a chance to render the waiting state first.
//
//   On desktop, behavior is unchanged — throws
//   'MetaMask is not available in this browser.' if no provider.
export const EVM_REDIRECTING_TO_METAMASK_MOBILE = 'REDIRECTING_TO_METAMASK_MOBILE'

export async function ensureMetaMaskAccount() {
  const provider = getMetaMaskProvider()
  if (!provider) {
    // No injected MetaMask provider. On mobile, signal to the caller
    // that they should redirect into MetaMask Mobile. On desktop,
    // throw (the user needs to install MetaMask as a browser
    // extension).
    if (isMobileBrowser()) {
      return EVM_REDIRECTING_TO_METAMASK_MOBILE
    }
    throw new Error('MetaMask is not available in this browser.')
  }
  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  if (!Array.isArray(accounts) || !accounts[0]) {
    throw new Error('No MetaMask account was returned.')
  }
  return accounts[0]
}

// Trigger the MetaMask Mobile deep-link. Should be called AFTER the
// caller has updated its UI state to show a waiting message — the
// navigation will tear down the current page.
//
// Re-exported from ethereumService.js so the swap flow and the
// wallet-link flow use the SAME deep-link implementation.
export { openMetaMaskMobile } from './ethereumService'

// Ask MetaMask to sign the EVM linking message via personal_sign.
// Returns the 0x-prefixed hex signature.
export async function signLinkMessageWithMetaMask({ address, message }) {
  const provider = getMetaMaskProvider()
  if (!provider) throw new Error('MetaMask is not available in this browser.')
  // personal_sign: params are [message, address]. The wallet will
  // display the message and ask the user to confirm.
  const signature = await provider.request({
    method: 'personal_sign',
    params: [message, address],
  })
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    throw new Error('MetaMask returned an unexpected signature.')
  }
  return signature
}

// Ask Phantom to sign the Solana linking message via signMessage.
// Returns the base64 signature.
//
// The Phantom provider is the same one WalletContext returns — we
// re-detect here so WalletLinkPanel can be used from any context.
export function getPhantomProvider() {
  if (typeof window === 'undefined') return null
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana
  if (window.solana?.isPhantom) return window.solana
  return window.solana || null
}

export async function signLinkMessageWithPhantom({ message }) {
  const provider = getPhantomProvider()
  if (!provider) throw new Error('Phantom is not available in this browser.')
  // Phantom's signMessage expects UTF-8 encoded bytes.
  const encoded = new TextEncoder().encode(message)
  const result = await provider.signMessage(encoded, 'utf8')
  // Phantom returns { signature, publicKey } — signature is a Uint8Array.
  let sigBytes
  if (result instanceof Uint8Array) {
    sigBytes = result
  } else if (result?.signature instanceof Uint8Array) {
    sigBytes = result.signature
  } else if (result?.data instanceof Uint8Array) {
    sigBytes = result.data
  } else if (Array.isArray(result?.signature)) {
    sigBytes = new Uint8Array(result.signature)
  } else {
    throw new Error('Phantom returned an unexpected signature format.')
  }
  // base64-encode (browser-native btoa works on byte strings)
  let binary = ''
  for (let i = 0; i < sigBytes.length; i++) binary += String.fromCharCode(sigBytes[i])
  return btoa(binary)
}

// Ask Phantom to sign an arbitrary revocation message (same flow as
// the linking message — different message text).
export async function signRevokeMessageWithPhantom({ message }) {
  return signLinkMessageWithPhantom({ message })
}
