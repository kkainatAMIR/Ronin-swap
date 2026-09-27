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

// =====================================================================
// MOBILE WALLET-LINK FLOW — URL-based phase passing
// =====================================================================
//
// On mobile, the wallet-link flow spans TWO browser contexts:
//
//   Phase 1 — Phantom browser (no window.ethereum):
//     User clicks "Link EVM Wallet" → we deep-link to MetaMask Mobile
//     with ?wl=1&sw=<solanaWallet> appended to the Ronin URL.
//
//   Phase 2 — MetaMask Mobile in-app browser (window.ethereum available):
//     Page loads with ?wl=1 → auto-resume: ensureMetaMaskAccount →
//     createWalletLinkChallenge → signLinkMessageWithMetaMask.
//     After EVM signature obtained, deep-link BACK to Phantom with
//     ?wl=2&cid=<challengeId>&evm=<evmAddr>&es=<evmSig>&ms=<base64(messageSolana)>.
//
//   Phase 3 — Phantom browser (window.solana available):
//     Page loads with ?wl=2 → auto-resume: signLinkMessageWithPhantom
//     using messageSolana from URL → verifyWalletLink with stored EVM
//     signature + fresh Solana signature → clear URL params → success.
//
// SECURITY:
//   * The EVM signature passed via URL is a time-limited proof (the
//     challenge expires in 5 minutes per the backend). It can ONLY be
//     used for THIS specific challenge — an attacker who intercepts it
//     would still need the corresponding Solana signature for the same
//     challenge to complete the link.
//   * The Solana wallet address passed via URL is a PUBLIC key — not
//     a private key. Putting it in the URL is safe.
//   * No private keys, seed phrases, or long-lived secrets are ever
//     stored in the URL or sessionStorage.
//   * URL params are cleared immediately after use via
//     window.history.replaceState (removes them from the address bar
//     and future browser history entries).
//   * The backend verification protocol is UNCHANGED — same challenge,
//     same message, same personal_sign, same signMessage, same
//     /api/wallet-link/verify payload.

const MOBILE_WL_PARAM = 'wl'           // '1' = EVM sign phase, '2' = Solana sign phase
const MOBILE_WL_SW_PARAM = 'sw'        // Solana wallet address (public key)
const MOBILE_WL_CID_PARAM = 'cid'      // challengeId from backend
const MOBILE_WL_EVM_PARAM = 'evm'      // EVM wallet address (0x...)
const MOBILE_WL_ES_PARAM = 'es'        // EVM signature (0x... hex)
const MOBILE_WL_MS_PARAM = 'ms'        // base64-encoded messageSolana

// Read the mobile wallet-link phase from the current URL.
//
// IMPORTANT: The Ronin app uses HASH routing (#profile, #swap, etc.).
// URL params can end up in window.location.search (the ? query string)
// OR in window.location.hash (e.g. #profile?wl=1&sw=...). We check
// BOTH to be robust across different deep-link redirect behaviors.
//
// Returns:
//   { phase: '1', solanaWallet }     — inside MetaMask Mobile, need to EVM-sign
//   { phase: '2', challengeId, evmWallet, evmSignature, messageSolana } — back in Phantom, need to Solana-sign
//   null                              — not in the mobile wallet-link flow (desktop, or fresh visit)
export function getMobileWalletLinkPhase() {
  if (typeof window === 'undefined') return null

  // Collect params from both ?query and #hash?query
  const searchParams = new URLSearchParams(window.location.search)
  let hashParams = new URLSearchParams()
  const hash = window.location.hash || ''
  // Hash looks like '#profile' or '#profile?wl=1&sw=...' — extract the
  // query portion after the first '?' if present.
  const hashQueryIndex = hash.indexOf('?')
  if (hashQueryIndex >= 0) {
    hashParams = new URLSearchParams(hash.slice(hashQueryIndex + 1))
  }

  // Prefer search params; fall back to hash params
  const getParam = (key) => searchParams.get(key) ?? hashParams.get(key)

  const phase = getParam(MOBILE_WL_PARAM)
  if (!phase) return null

  if (phase === '1') {
    const solanaWallet = getParam(MOBILE_WL_SW_PARAM)
    if (!solanaWallet) return null
    return { phase: '1', solanaWallet }
  }

  if (phase === '2') {
    const challengeId = getParam(MOBILE_WL_CID_PARAM)
    const evmWallet = getParam(MOBILE_WL_EVM_PARAM)
    const evmSignature = getParam(MOBILE_WL_ES_PARAM)
    const msB64 = getParam(MOBILE_WL_MS_PARAM)
    if (!challengeId || !evmWallet || !evmSignature || !msB64) return null
    let messageSolana = ''
    try { messageSolana = atob(msB64) } catch { return null }
    return { phase: '2', challengeId, evmWallet, evmSignature, messageSolana }
  }

  return null
}

// Remove the mobile wallet-link params from the URL without triggering
// a page reload. Uses window.history.replaceState so the params don't
// linger in the browser's address bar or history.
//
// Clears params from BOTH window.location.search AND window.location.hash
// (the app uses hash routing, so params may be in either place).
export function clearMobileWalletLinkParams() {
  if (typeof window === 'undefined') return

  // Clear from the search query string
  const url = new URL(window.location.href)
  let changed = false
  const paramsToRemove = [MOBILE_WL_PARAM, MOBILE_WL_SW_PARAM, MOBILE_WL_CID_PARAM, MOBILE_WL_EVM_PARAM, MOBILE_WL_ES_PARAM, MOBILE_WL_MS_PARAM]
  for (const p of paramsToRemove) {
    if (url.searchParams.has(p)) { url.searchParams.delete(p); changed = true }
  }

  // Clear from the hash query string (e.g. #profile?wl=1&sw=...)
  if (url.hash && url.hash.includes('?')) {
    const hashQueryIndex = url.hash.indexOf('?')
    const hashPath = url.hash.slice(0, hashQueryIndex) // e.g. '#profile'
    const hashParams = new URLSearchParams(url.hash.slice(hashQueryIndex + 1))
    let hashChanged = false
    for (const p of paramsToRemove) {
      if (hashParams.has(p)) { hashParams.delete(p); hashChanged = true }
    }
    if (hashChanged) {
      const remaining = hashParams.toString()
      url.hash = remaining ? `${hashPath}?${remaining}` : hashPath
      changed = true
    }
  }

  if (changed) {
    window.history.replaceState({}, '', url.toString())
  }
}

// Construct the MetaMask Mobile deep-link URL for Phase 1.
// Appends wl=1&sw=<solanaWallet> to the current Ronin URL so that
// when MetaMask Mobile opens the page, the app auto-resumes the
// EVM signing step.
//
// IMPORTANT: The Ronin app uses hash routing (#profile, #swap, etc.).
// We must preserve the hash so the user lands on the Profile page
// inside MetaMask Mobile's browser, not on the Home page.
// We put the wallet-link params in the hash query string
// (e.g. #profile?wl=1&sw=...) so they survive the deep-link redirect
// and are readable by getMobileWalletLinkPhase().
export function openMetaMaskMobileForWalletLink(solanaWallet) {
  if (typeof window === 'undefined') return false
  if (!solanaWallet) return false
  const url = new URL(window.location.href)

  // Build the wallet-link params
  const wlParams = new URLSearchParams()
  wlParams.set(MOBILE_WL_PARAM, '1')
  wlParams.set(MOBILE_WL_SW_PARAM, solanaWallet)

  // Ensure we're on the #profile page inside MetaMask Mobile — the
  // auto-resume useEffect lives in WalletLinkPanel which is only
  // rendered on the Profile page.
  const hashPath = url.hash ? url.hash.split('?')[0] : '#profile'
  if (!hashPath.startsWith('#profile')) {
    // If not on profile, navigate to profile with the wl params
    url.hash = `#profile?${wlParams.toString()}`
  } else {
    // Already on profile (or a sub-route) — append wl params to the
    // existing hash query string
    const existingHashQuery = url.hash.includes('?')
      ? new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1))
      : new URLSearchParams()
    // Strip any existing wl params from a previous attempt
    for (const p of [MOBILE_WL_PARAM, MOBILE_WL_SW_PARAM, MOBILE_WL_CID_PARAM, MOBILE_WL_EVM_PARAM, MOBILE_WL_ES_PARAM, MOBILE_WL_MS_PARAM]) {
      existingHashQuery.delete(p)
    }
    // Set the Phase 1 params
    existingHashQuery.set(MOBILE_WL_PARAM, '1')
    existingHashQuery.set(MOBILE_WL_SW_PARAM, solanaWallet)
    url.hash = `${hashPath}?${existingHashQuery.toString()}`
  }

  // Also strip any wl params from the search query (cleanup)
  url.searchParams.delete(MOBILE_WL_PARAM)
  url.searchParams.delete(MOBILE_WL_SW_PARAM)
  url.searchParams.delete(MOBILE_WL_CID_PARAM)
  url.searchParams.delete(MOBILE_WL_EVM_PARAM)
  url.searchParams.delete(MOBILE_WL_ES_PARAM)
  url.searchParams.delete(MOBILE_WL_MS_PARAM)

  // MetaMask Mobile deep-link format: metamask.app.link/dapp/<full-url>
  // The full URL includes the hash, so MetaMask Mobile opens the right
  // page with the right params.
  window.location.href = `https://metamask.app.link/dapp/${url.host}${url.pathname}${url.search}${url.hash}`
  return true
}

// Construct the Phantom deep-link URL for Phase 2→3 transition.
// Appends wl=2&cid=<challengeId>&evm=<evmAddr>&es=<evmSig>&ms=<base64(messageSolana)>
// to the current Ronin URL so that when Phantom opens the page, the app
// auto-resumes the Solana signing step.
//
// IMPORTANT: Same hash-routing logic as openMetaMaskMobileForWalletLink.
// We put the wallet-link params in the hash query string
// (e.g. #profile?wl=2&cid=...) so they survive the deep-link redirect
// and land the user on the Profile page inside Phantom's browser.
export function openPhantomForSolanaSign({ challengeId, evmWallet, evmSignature, messageSolana }) {
  if (typeof window === 'undefined') return false
  if (!challengeId || !evmWallet || !evmSignature || !messageSolana) return false
  const url = new URL(window.location.href)

  // Build the Phase 2 wallet-link params
  const wlParams = new URLSearchParams()
  wlParams.set(MOBILE_WL_PARAM, '2')
  wlParams.set(MOBILE_WL_CID_PARAM, challengeId)
  wlParams.set(MOBILE_WL_EVM_PARAM, evmWallet)
  wlParams.set(MOBILE_WL_ES_PARAM, evmSignature)
  wlParams.set(MOBILE_WL_MS_PARAM, btoa(messageSolana))

  // Ensure we land on #profile inside Phantom's browser
  const hashPath = url.hash ? url.hash.split('?')[0] : '#profile'
  if (!hashPath.startsWith('#profile')) {
    url.hash = `#profile?${wlParams.toString()}`
  } else {
    // Already on profile — merge with existing hash query, stripping old wl params
    const existingHashQuery = url.hash.includes('?')
      ? new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1))
      : new URLSearchParams()
    for (const p of [MOBILE_WL_PARAM, MOBILE_WL_SW_PARAM, MOBILE_WL_CID_PARAM, MOBILE_WL_EVM_PARAM, MOBILE_WL_ES_PARAM, MOBILE_WL_MS_PARAM]) {
      existingHashQuery.delete(p)
    }
    for (const [k, v] of wlParams) { existingHashQuery.set(k, v) }
    url.hash = `${hashPath}?${existingHashQuery.toString()}`
  }

  // Strip wl params from the search query (cleanup)
  url.searchParams.delete(MOBILE_WL_PARAM)
  url.searchParams.delete(MOBILE_WL_SW_PARAM)
  url.searchParams.delete(MOBILE_WL_CID_PARAM)
  url.searchParams.delete(MOBILE_WL_EVM_PARAM)
  url.searchParams.delete(MOBILE_WL_ES_PARAM)
  url.searchParams.delete(MOBILE_WL_MS_PARAM)

  // Phantom's deep-link opens the URL inside Phantom's in-app browser.
  // Format: https://phantom.app/ul/browse/<url-encoded-full-url>?ref=<origin>
  window.location.href = `https://phantom.app/ul/browse/${encodeURIComponent(url.toString())}?ref=${encodeURIComponent(window.location.origin)}`
  return true
}

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
