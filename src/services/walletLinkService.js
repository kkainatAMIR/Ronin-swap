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
const MOBILE_WL_ROUTE_PARAM = 'route'  // Ronin page route (e.g. 'profile') — query-param transport for mobile deep-links
const MOBILE_WL_STORAGE_KEY = 'ronin.mobileWalletLinkState'

function saveMobileWalletLinkState(state) {
  if (typeof window === 'undefined') return
  try {
    if (!state) {
      window.sessionStorage.removeItem(MOBILE_WL_STORAGE_KEY)
      return
    }
    const payload = { ...state, savedAt: Date.now() }
    window.sessionStorage.setItem(MOBILE_WL_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // sessionStorage may be unavailable in some privacy-restricted browsers;
    // failing silently is safer than breaking the wallet-link flow.
  }
}

function readMobileWalletLinkState() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.sessionStorage.getItem(MOBILE_WL_STORAGE_KEY)
    if (!raw) return null
    const state = JSON.parse(raw)
    if (!state || !state.phase) return null
    return state
  } catch {
    return null
  }
}

// Read the mobile wallet-link phase from the current URL.
//
// PRIMARY MECHANISM: window.location.search (the ? query string)
//   Example: https://ronin-swap6.vercel.app/?wl=1&sw=<solanaWallet>#profile
//
// The wallet-link params (wl, sw, cid, evm, es, ms) MUST be in the
// search query string — NOT in the hash fragment. This is because
// the MetaMask Mobile deep-link (metamask.app.link/dapp/<url>)
// treats the #fragment of the destination URL as the OUTER deep-link
// URL's fragment, which it strips/ignores. Only the search query
// string survives the deep-link handoff.
//
// BACKWARD-COMPAT FALLBACK: also check the hash query string
// (#profile?wl=1&...) for older deep-links that used the hash-based
// protocol. This fallback can be removed once no users have stale
// hash-based URLs in their history.
//
// Returns:
//   { phase: '1', solanaWallet }     — inside MetaMask Mobile, need to EVM-sign
//   { phase: '2', challengeId, evmWallet, evmSignature, messageSolana } — back in Phantom, need to Solana-sign
//   null                              — not in the mobile wallet-link flow (desktop, or fresh visit)
export function getMobileWalletLinkPhase() {
  if (typeof window === 'undefined') return null

  // PRIMARY: read from window.location.search
  const searchParams = new URLSearchParams(window.location.search)

  // BACKWARD-COMPAT FALLBACK: also read from the hash query string
  // (#profile?wl=1&...) — for old deep-links that used the hash protocol.
  let hashParams = new URLSearchParams()
  const hash = window.location.hash || ''
  const hashQueryIndex = hash.indexOf('?')
  if (hashQueryIndex >= 0) {
    hashParams = new URLSearchParams(hash.slice(hashQueryIndex + 1))
  }

  // Prefer search params (primary); fall back to hash params (legacy)
  const getParam = (key) => searchParams.get(key) ?? hashParams.get(key)

  const phase = getParam(MOBILE_WL_PARAM)
  const persisted = readMobileWalletLinkState()

  if (!phase && persisted) {
    if (persisted.phase === '1' && persisted.solanaWallet) {
      console.info('[WalletLinkMobile] persisted wl=1 state detected', {
        solanaWalletShort: persisted.solanaWallet.slice(0, 4) + '...' + persisted.solanaWallet.slice(-4),
      })
      return { phase: '1', solanaWallet: persisted.solanaWallet }
    }
    if (persisted.phase === '2' && persisted.challengeId && persisted.evmWallet && persisted.evmSignature && persisted.messageSolana) {
      console.info('[WalletLinkMobile] persisted wl=2 state detected', {
        challengeId: persisted.challengeId,
        evmWalletShort: persisted.evmWallet.slice(0, 6) + '...' + persisted.evmWallet.slice(-4),
        sigLen: persisted.evmSignature?.length,
        msLen: persisted.messageSolana?.length,
      })
      return { phase: '2', challengeId: persisted.challengeId, evmWallet: persisted.evmWallet, evmSignature: persisted.evmSignature, messageSolana: persisted.messageSolana }
    }
  }

  if (!phase) return null

  if (phase === '1') {
    const solanaWallet = getParam(MOBILE_WL_SW_PARAM)
    if (!solanaWallet) return null
    saveMobileWalletLinkState({ phase: '1', solanaWallet, route: getParam(MOBILE_WL_ROUTE_PARAM) || 'profile' })
    console.info('[WalletLinkMobile] wl=1 detected', {
      solanaWalletShort: solanaWallet.slice(0, 4) + '...' + solanaWallet.slice(-4),
      source: searchParams.get(MOBILE_WL_PARAM) ? 'search' : 'hash',
    })
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
    saveMobileWalletLinkState({ phase: '2', challengeId, evmWallet, evmSignature, messageSolana, route: getParam(MOBILE_WL_ROUTE_PARAM) || 'profile' })
    console.info('[WalletLinkMobile] wl=2 detected', {
      challengeId,
      evmWalletShort: evmWallet.slice(0, 6) + '...' + evmWallet.slice(-4),
      sigLen: evmSignature?.length,
      msLen: messageSolana?.length,
      source: searchParams.get(MOBILE_WL_PARAM) ? 'search' : 'hash',
    })
    return { phase: '2', challengeId, evmWallet, evmSignature, messageSolana }
  }

  return null
}

// Remove the mobile wallet-link params from the URL without triggering
// a page reload. Uses window.history.replaceState so the params don't
// linger in the browser's address bar or history.
//
// SECURITY: The EVM signature (es) and messageSolana (ms) are sensitive
// flow data. They are removed from the URL IMMEDIATELY after being
// consumed by getMobileWalletLinkPhase() — they should never linger in
// browser history or the address bar longer than necessary.
//
// Clears params from BOTH window.location.search (primary) AND
// window.location.hash (backward-compat with old deep-links).
export function clearMobileWalletLinkParams() {
  if (typeof window === 'undefined') return

  const url = new URL(window.location.href)
  let changed = false
  const paramsToRemove = [MOBILE_WL_PARAM, MOBILE_WL_SW_PARAM, MOBILE_WL_CID_PARAM, MOBILE_WL_EVM_PARAM, MOBILE_WL_ES_PARAM, MOBILE_WL_MS_PARAM, MOBILE_WL_ROUTE_PARAM]

  // PRIMARY: clear from the search query string
  for (const p of paramsToRemove) {
    if (url.searchParams.has(p)) { url.searchParams.delete(p); changed = true }
  }

  // BACKWARD-COMPAT: also clear from the hash query string (#profile?wl=1&...)
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

  // IMPORTANT: when the mobile wallet-link flow is being consumed, any
  // plain hash route (for example '#profile') must also be cleared.
  // Keeping the hash would cause the browser to reopen at a bare
  // '#profile' URL with no wallet-link state, which is exactly the
  // failure mode seen in MetaMask → Phantom handoff.
  if (url.hash) {
    url.hash = ''
    changed = true
  }

  if (changed) {
    window.history.replaceState({}, '', url.toString())
  }
}

export function clearMobileWalletLinkState() {
  saveMobileWalletLinkState(null)
}

// Construct the MetaMask Mobile deep-link URL for Phase 1.
//
// DESTINATION URL STRUCTURE (after fix):
//   https://ronin-swap6.vercel.app/?wl=1&sw=<solanaWallet>&route=profile
//
// CRITICAL: The wallet-link params AND the route MUST be in the
// destination URL's QUERY STRING (?wl=1&sw=...&route=profile), NOT
// in the hash fragment (#profile).
//
// WHY: The MetaMask deep-link format is:
//   https://metamask.app.link/dapp/<destination-url>
//
// If the destination URL includes a #fragment (e.g.
// https://ronin-swap6.vercel.app/?wl=1&sw=...#profile), the '#'
// is treated as the OUTER metamask.app.link URL's fragment —
// which MetaMask Mobile's deep-link parser STRIPS/DROPS. The dapp
// opens WITHOUT the #profile hash → the hash router defaults to
// 'home' → WalletLinkPanel never mounts → auto-resume never fires.
//
// FIX: Put the route in a 'route' QUERY PARAMETER (?route=profile)
// instead of the hash fragment. The app's router (App.jsx) checks
// for a valid hash route FIRST (existing behavior), and falls back
// to ?route= only when no hash route exists (new fallback for mobile
// wallet-link deep-links). This preserves existing desktop behavior
// (which always has a #hash) while making mobile deep-links reliable.
//
// The destination URL after the deep-link resolves is:
//   https://ronin-swap6.vercel.app/?wl=1&sw=<solanaWallet>&route=profile
//
// NO hash fragment in the deep-link destination — MetaMask Mobile
// can't strip what isn't there.
export function openMetaMaskMobileForWalletLink(solanaWallet) {
  if (typeof window === 'undefined') return false
  if (!solanaWallet) return false

  // Force a stable destination URL rooted at the site origin and carry
  // the wallet-link state in the query string. Do not rely on the hash
  // route at all, because MetaMask strips hash fragments during handoff.
  const target = new URL(window.location.origin)
  target.pathname = '/'
  target.searchParams.delete(MOBILE_WL_PARAM)
  target.searchParams.delete(MOBILE_WL_SW_PARAM)
  target.searchParams.delete(MOBILE_WL_CID_PARAM)
  target.searchParams.delete(MOBILE_WL_EVM_PARAM)
  target.searchParams.delete(MOBILE_WL_ES_PARAM)
  target.searchParams.delete(MOBILE_WL_MS_PARAM)
  target.searchParams.delete(MOBILE_WL_ROUTE_PARAM)
  target.searchParams.set(MOBILE_WL_PARAM, '1')
  target.searchParams.set(MOBILE_WL_SW_PARAM, solanaWallet)
  target.searchParams.set(MOBILE_WL_ROUTE_PARAM, 'profile')

  const destinationUrl = `${window.location.origin}/?${MOBILE_WL_PARAM}=1&${MOBILE_WL_SW_PARAM}=${encodeURIComponent(solanaWallet)}&${MOBILE_WL_ROUTE_PARAM}=profile`
  const deepLink = `https://metamask.app.link/dapp/${destinationUrl}`

  saveMobileWalletLinkState({ phase: '1', solanaWallet, route: 'profile' })

  console.info('[WalletLinkMobile] deep-link destination generated', {
    destinationUrl,
    phase: 1,
    solanaWalletShort: solanaWallet.slice(0, 4) + '...' + solanaWallet.slice(-4),
  })

  window.location.href = deepLink
  return true
}

// Construct the Phantom deep-link URL for Phase 2→3 transition.
//
// DESTINATION URL STRUCTURE (after fix):
//   https://ronin-swap6.vercel.app/?wl=2&cid=<challengeId>&evm=<evmAddr>&es=<evmSig>&ms=<base64>&route=profile
//
// Same pattern as openMetaMaskMobileForWalletLink:
//   ?query  → wallet-link protocol state + route (survives Phantom deep-link)
//   NO #hash in the deep-link destination (hash gets stripped by Phantom)
//
// The Phantom deep-link format opens the URL inside Phantom's
// in-app browser: https://phantom.app/ul/browse/<url-encoded-full-url>?ref=<origin>
export function openPhantomForSolanaSign({ challengeId, evmWallet, evmSignature, messageSolana }) {
  if (typeof window === 'undefined') return false
  if (!challengeId || !evmWallet || !evmSignature || !messageSolana) return false
  const url = new URL(window.location.href)

  // Strip any stale wallet-link params + route from BOTH search and hash.
  // The critical fix is to remove the hash entirely before building the
  // Phantom redirect target. Hash fragments are not reliable across wallet
  // deep-link handoffs and are the reason the browser returns to a bare
  // '#profile' URL instead of resuming the Phase 3 flow.
  for (const p of [MOBILE_WL_PARAM, MOBILE_WL_SW_PARAM, MOBILE_WL_CID_PARAM, MOBILE_WL_EVM_PARAM, MOBILE_WL_ES_PARAM, MOBILE_WL_MS_PARAM, MOBILE_WL_ROUTE_PARAM]) {
    url.searchParams.delete(p)
  }
  url.hash = ''

  // Put Phase 2 wallet-link params + route in the SEARCH query string.
  url.searchParams.set(MOBILE_WL_PARAM, '2')
  url.searchParams.set(MOBILE_WL_CID_PARAM, challengeId)
  url.searchParams.set(MOBILE_WL_EVM_PARAM, evmWallet)
  url.searchParams.set(MOBILE_WL_ES_PARAM, evmSignature)
  url.searchParams.set(MOBILE_WL_MS_PARAM, btoa(messageSolana))
  url.searchParams.set(MOBILE_WL_ROUTE_PARAM, 'profile')

  // CRITICAL: Do NOT include url.hash in the destination URL.
  // Same reason as openMetaMaskMobileForWalletLink — the hash fragment
  // becomes the OUTER phantom.app.link URL's fragment, which Phantom
  // strips. The route is carried via ?route=profile instead.
  // Build destination WITHOUT the hash:
  const destinationUrl = `${url.origin}${url.pathname}${url.search}`

  // Phantom's deep-link opens the URL inside Phantom's in-app browser.
  // Format: https://phantom.app/ul/browse/<url-encoded-full-url>?ref=<origin>
  const deepLink = `https://phantom.app/ul/browse/${encodeURIComponent(destinationUrl)}?ref=${encodeURIComponent(window.location.origin)}`

  saveMobileWalletLinkState({ phase: '2', challengeId, evmWallet, evmSignature, messageSolana, route: 'profile' })
  console.info('[WalletLinkMobile] Phase 2 state persisted', {
    phase: 2,
    challengeId,
    evmWalletShort: evmWallet.slice(0, 6) + '...' + evmWallet.slice(-4),
    sigLen: evmSignature?.length,
    msLen: messageSolana?.length,
  })

  // Debug log (addresses + signature are public — but shorten for safety)
  console.info('[WalletLinkMobile] Phase 2 deep-link generated', {
    destinationHostname: new URL(destinationUrl).hostname,
    destinationPathname: new URL(destinationUrl).pathname,
    phase: 2,
    challengeId,
    evmWalletShort: evmWallet.slice(0, 6) + '...' + evmWallet.slice(-4),
    sigLen: evmSignature?.length,
    msLen: messageSolana?.length,
  })
  console.info('[WalletLinkMobile] Phantom deep-link navigation starting', {
    deepLinkHostname: new URL(deepLink).hostname,
    deepLinkPathname: new URL(deepLink).pathname,
    phase: 2,
    challengeId,
    evmWalletShort: evmWallet.slice(0, 6) + '...' + evmWallet.slice(-4),
    sigLen: evmSignature?.length,
    msLen: messageSolana?.length,
  })

  const currentUrl = window.location.href
  try {
    const anchor = document.createElement('a')
    anchor.href = deepLink
    anchor.rel = 'noopener noreferrer'
    anchor.style.position = 'fixed'
    anchor.style.left = '-9999px'
    anchor.style.top = '-9999px'
    anchor.style.opacity = '0'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  } catch (error) {
    console.warn('[WalletLinkMobile] Phantom deep-link anchor fallback failed', { message: error?.message })
  }

  setTimeout(() => {
    if (window.location.href === currentUrl) {
      console.warn('[WalletLinkMobile] Phantom handoff did not leave MetaMask browser', {
        currentUrl: window.location.href,
        deepLinkHostname: new URL(deepLink).hostname,
        deepLinkPathname: new URL(deepLink).pathname,
      })
      window.location.href = deepLink
    }
  }, 1200)

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

  // CRITICAL (mobile): On mobile, when Phantom opens the dapp via a
  // deep-link, the Phantom provider IS injected, but the wallet is NOT
  // connected. The WalletContext tries provider.connect({ onlyIfTrusted:
  // true }) which silently fails if the dapp isn't trusted yet.
  //
  // Calling signMessage() on an unconnected wallet can:
  //   a. Fail silently
  //   b. Show a connection popup that doesn't auto-proceed to signMessage
  //   c. Sign with a different account than the one that created the
  //      challenge → backend rejects with WALLET_MISMATCH
  //
  // FIX: Explicitly call provider.connect() (without onlyIfTrusted) before
  // signMessage. This ensures the wallet is connected and the user's
  // Phantom account is active before we request a signature. On desktop,
  // this is a no-op if already connected (Phantom returns immediately).
  if (provider.connect && !provider.isConnected) {
    console.info('[WalletLinkMobile] Phantom not connected — calling connect()')
    try {
      await provider.connect()
      console.info('[WalletLinkMobile] Phantom connected successfully')
    } catch (connectErr) {
      console.error('[WalletLinkMobile] Phantom connect() failed', { message: connectErr?.message })
      throw new Error('Phantom connection was rejected. Please approve the connection to sign the linking message.')
    }
  }

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
