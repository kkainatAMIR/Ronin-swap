import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, SectionHeading, Tag } from './Layout'
import Icon from './Icon'
import { useWallet } from '../context/WalletContext'
import { getSolanaProvider } from '../context/WalletContext'
import {
  createWalletLinkChallenge,
  verifyWalletLink,
  getVerifiedRewardIdentity,
  createRevokeChallenge,
  revokeWalletLink,
  ensureMetaMaskAccount,
  signLinkMessageWithMetaMask,
  signLinkMessageWithPhantom,
  signRevokeMessageWithPhantom,
  getPhantomProvider,
  openMetaMaskMobile,
  openMetaMaskMobileForWalletLink,
  openPhantomForSolanaSign,
  getMobileWalletLinkPhase,
  clearMobileWalletLinkParams,
  EVM_REDIRECTING_TO_METAMASK_MOBILE,
} from '../services/walletLinkService'

// =====================================================================
// WalletLinkPanel — redesigned to use RoninSwap's existing visual
// language (paper panels, Ronin red accents, gold highlights, ink
// text). No new CSS framework. Matches the existing profile-panel
// + profile-rewards-panel + btn/btn-primary/btn-outline patterns.
// =====================================================================
//
// UX states:
//   IDLE      → "Link EVM Wallet" CTA + explanation
//   FLOW      → 4-step progress (EVM sig → Solana sig → verifying →
//               linking). Each step shows ✓/spinner/pending.
//   SUCCESS   → "✓ EVM Wallet Linked" + aggregated points (from
//               backend, not hardcoded) + linked wallets list
//   ERROR     → friendly error + console.error for debugging
//
// SECURITY NOTE — message signatures, not transactions:
//   The 4 progress steps are MESSAGE SIGNATURES only. The UI must
//   NOT make the user think a blockchain transaction is being sent.
//   The copy explicitly says "This signature does not authorize
//   transactions or token transfers."
// =====================================================================

const STEP_IDLE = 'idle'
const STEP_REQUESTING_CHALLENGE = 'requesting-challenge'
const STEP_SIGNING_EVM = 'signing-evm'
const STEP_SIGNING_SOLANA = 'signing-solana'
const STEP_VERIFYING = 'verifying'
const STEP_SUCCESS = 'success'
const STEP_ERROR = 'error'
// Mobile-only: MetaMask is not injected in this browser. We've
// deep-linked into MetaMask Mobile — the user will reopen this site
// inside MetaMask Mobile's in-app browser, where window.ethereum
// is injected, and then they click "Link EVM Wallet" again. No
// challenge has been created yet, so there's nothing to roll back.
const STEP_OPENING_METAMASK_MOBILE = 'opening-metamask-mobile'
// Mobile-only Phase 2→3: EVM signature obtained inside MetaMask Mobile.
// We're deep-linking BACK to Phantom so the user can sign the Solana
// message. No user action needed — this is a brief redirect state.
const STEP_RETURNING_TO_PHANTOM = 'returning-to-phantom'

// The 4 user-visible progress steps. Indexed by step number.
const PROGRESS_STEPS = [
  { id: 'evm-sig', label: 'EVM wallet signature', sub: 'Prove you own the EVM wallet' },
  { id: 'solana-sig', label: 'Solana wallet signature', sub: 'Prove you own the Solana wallet' },
  { id: 'verify', label: 'Verifying ownership', sub: 'Backend verifies both signatures' },
  { id: 'link', label: 'Linking reward identity', sub: 'Associating EVM points with Solana identity' },
]

// Map internal STEP_* to the progress step that should be highlighted.
function stepToProgressIndex(step) {
  if (step === STEP_REQUESTING_CHALLENGE) return -1  // before any progress
  if (step === STEP_SIGNING_EVM) return 0
  if (step === STEP_SIGNING_SOLANA) return 1
  if (step === STEP_VERIFYING) return 2
  if (step === STEP_SUCCESS) return 4  // all done
  // Mobile intermediate states show the EVM step as complete (EVM
  // sig was obtained in MetaMask Mobile) and the Solana step as active.
  if (step === STEP_RETURNING_TO_PHANTOM) return 1
  return -1
}

function shortAddr(addr) {
  if (!addr) return ''
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function WalletLinkPanel({ onLinkedChange }) {
  const { wallet, verifiedEvmWallets, refreshLinkedWallets, solanaPayoutWallet } = useWallet()
  const [step, setStep] = useState(STEP_IDLE)
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [evmAddress, setEvmAddress] = useState('')
  const [activeLink, setActiveLink] = useState(null)
  const [unlinkingEvm, setUnlinkingEvm] = useState(null)

  // Diagnostic: log on every render what the URL looks like + what
  // getMobileWalletLinkPhase returns. This helps trace exactly where
  // the flow stops on mobile.
  if (typeof window !== 'undefined') {
    const urlSearch = window.location.search || '(empty)'
    const phase = getMobileWalletLinkPhase()
    if (phase) {
      console.info('[WalletLinkMobile] WalletLinkPanel render — mobile phase active', {
        phase: phase.phase,
        urlSearch: urlSearch.slice(0, 80),
        step,
        walletAddress: wallet?.address ? 'set' : 'null',
      })
    }
  }

  // Ref to always hold the LATEST refreshLinkedWallets. The auto-resume
  // useEffect captures `refreshLinkedWallets` at mount time, but on mobile
  // the wallet state changes asynchronously (Phantom connects after page
  // load). Without this ref, the Phase 3 code would call a STALE
  // refreshLinkedWallets that has wallet.address=null → returns early →
  // verifiedEvmWallets never updates → the linked EVM wallet doesn't appear.
  const refreshLinkedWalletsRef = useRef(refreshLinkedWallets)
  useEffect(() => { refreshLinkedWalletsRef.current = refreshLinkedWallets }, [refreshLinkedWallets])
  const [aggregatedPoints, setAggregatedPoints] = useState(null)

  // Reset state if the user switches Phantom wallet.
  //
  // CRITICAL MOBILE FIX: This effect fires whenever `wallet?.address`
  // changes. On mobile Phase 3, when Phantom reconnects after the
  // deep-link return, `wallet.address` transitions from `null` →
  // `<real address>`. This triggers the reset → wipes STEP_SIGNING_SOLANA /
  // activeLink / evmAddress → the async signing/verify operation is
  // still running but the UI has been reset to STEP_IDLE.
  //
  // FIX: Skip the reset when a mobile wallet-link flow is active
  // (mobileResumeStartedRef.current = true) or when mobile wallet-link
  // URL params are present (getMobileWalletLinkPhase() returns non-null).
  // This prevents the state from being wiped mid-flow.
  //
  // NOTE: mobileResumeStartedRef is declared below (line ~140) but is
  // accessible inside this effect callback because the callback executes
  // AFTER render, by which time the const has been initialized.
  useEffect(() => {
    // Skip reset during mobile wallet-link flow
    if (mobileResumeStartedRef?.current) return
    // Also check URL params as a backup (in case the ref wasn't set yet)
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search)
      let hp = new URLSearchParams()
      const hash = window.location.hash || ''
      const hqi = hash.indexOf('?')
      if (hqi >= 0) hp = new URLSearchParams(hash.slice(hqi + 1))
      if (sp.get('wl') || hp.get('wl')) return
    }
    setStep(STEP_IDLE)
    setError('')
    setErrorCode('')
    setActiveLink(null)
    setEvmAddress('')
    setAggregatedPoints(null)
  }, [wallet?.address])

  const solanaWallet = solanaPayoutWallet || (wallet?.address && !wallet?.isDemo ? wallet.address : null)
  const hasPhantom = Boolean(getPhantomProvider())
  const linkedList = verifiedEvmWallets || []

  // =====================================================================
  // MOBILE AUTO-RESUME — detect wallet-link phase from URL params
  // =====================================================================
  //
  // On mobile, the wallet-link flow spans two browser contexts:
  //   Phase 1: Phantom browser → deep-link to MetaMask Mobile
  //   Phase 2: MetaMask Mobile browser → EVM connect + sign → deep-link back to Phantom
  //   Phase 3: Phantom browser → Solana sign + verify
  //
  // When the page reloads in a new browser context, all React state is
  // lost. We use URL params (?wl=1 or ?wl=2&...) to detect which phase
  // we're in and auto-resume the EXACT SAME desktop flow.
  //
  // A ref guard prevents double-execution (React StrictMode runs
  // effects twice in dev).
  const mobileResumeStartedRef = useRef(false)

  useEffect(() => {
    if (mobileResumeStartedRef.current) return
    const mobilePhase = getMobileWalletLinkPhase()
    if (!mobilePhase) return

    // ---- Phase 2: inside MetaMask Mobile's in-app browser ----
    //
    // CRITICAL: MetaMask Mobile's injected provider (`window.ethereum`)
    // may NOT be available on the very first React render/effect. The
    // deep-link opens the page, but the provider injection happens
    // asynchronously. If we check `window.ethereum?.isMetaMask`
    // synchronously on first render, it will be false → we'd clear
    // the mobile params and abort the flow.
    //
    // FIX: Wait for the provider with a BOUNDED retry (up to ~5s).
    // We poll every 250ms for the MetaMask provider. If it appears,
    // we proceed with the EXACT SAME desktop flow. If it genuinely
    // doesn't appear after the timeout, we show an error instead of
    // silently clearing state.
    if (mobilePhase.phase === '1') {
      const phaseSolanaWallet = mobilePhase.solanaWallet

      // Detect MetaMask provider at a single point in time.
      const detectMetaMaskNow = () => Boolean(
        (typeof window !== 'undefined' && window.ethereum?.isMetaMask && !window.ethereum?.isPhantom) ||
        (Array.isArray(window.ethereum?.providers) && window.ethereum.providers.some((p) => p?.isMetaMask && !p?.isPhantom))
      )

      // If already available, proceed immediately.
      // Otherwise poll every 250ms for up to 5 seconds (20 attempts).
      const MAX_WAIT_ATTEMPTS = 20
      const ATTEMPT_INTERVAL_MS = 250

      const startPhase2 = () => {
        mobileResumeStartedRef.current = true
        console.info('[WalletLinkMobile] MetaMask provider detected')
        setStep(STEP_REQUESTING_CHALLENGE)
        setError('')
        setErrorCode('')
        ;(async () => {
          try {
            console.info('[WalletLinkMobile] eth_requestAccounts started')
            const evm = await ensureMetaMaskAccount()
            if (evm === EVM_REDIRECTING_TO_METAMASK_MOBILE) {
              throw new Error('MetaMask provider became unavailable.')
            }
            console.info('[WalletLinkMobile] MetaMask account received', {
              evmShort: evm.slice(0, 6) + '...' + evm.slice(-4),
            })
            setEvmAddress(evm)
            console.info('[WalletLinkMobile] challenge creation started')
            const challenge = await createWalletLinkChallenge({
              solanaWallet: phaseSolanaWallet,
              evmWallet: evm,
            })
            console.info('[WalletLinkMobile] challenge created', {
              challengeId: challenge.challengeId,
            })
            setActiveLink({
              solanaWallet: challenge.solanaWallet,
              evmWallet: challenge.evmWallet,
              challengeId: challenge.challengeId,
              messageEvm: challenge.messageEvm,
              messageSolana: challenge.messageSolana,
            })
            // Sign with MetaMask (personal_sign). Same as desktop.
            setStep(STEP_SIGNING_EVM)
            console.info('[WalletLinkMobile] personal_sign started')
            const evmSig = await signLinkMessageWithMetaMask({
              address: challenge.evmWallet,
              message: challenge.messageEvm,
            })
            console.info('[WalletLinkMobile] personal_sign completed', {
              sigLen: evmSig?.length,
            })
            // EVM signature obtained. On desktop, we'd continue to
            // signSolana. On mobile, window.solana is NOT available
            // inside MetaMask Mobile's browser — we need to deep-link
            // BACK to Phantom so the user can sign the Solana message.
            setStep(STEP_RETURNING_TO_PHANTOM)
            console.info('[WalletLinkMobile] Phase 2 deep-link generation started')
            const phantomOk = openPhantomForSolanaSign({
              challengeId: challenge.challengeId,
              evmWallet: challenge.evmWallet,
              evmSignature: evmSig,
              messageSolana: challenge.messageSolana,
            })
            if (!phantomOk) {
              console.error('[WalletLinkMobile] Phantom handoff failed — openPhantomForSolanaSign returned false')
              clearMobileWalletLinkParams()
              setError('Phantom handoff could not be started. Please try again.')
              setErrorCode('PHANTOM_HANDOFF_FAILED')
              setStep(STEP_ERROR)
              return
            }
            console.info('[WalletLinkMobile] navigation to Phantom started')
          } catch (e) {
            const msg = e?.message || 'Mobile EVM signing failed.'
            console.error('[WalletLinkMobile] Phase 2 failed', { message: msg })
            clearMobileWalletLinkParams()
            setError(msg)
            setErrorCode(String(e?.code || 'MOBILE_EVM_FAILED'))
            setStep(STEP_ERROR)
          }
        })()
      }

      if (detectMetaMaskNow()) {
        startPhase2()
        return
      }

      // Provider not yet injected — wait with a bounded retry.
      // Show a "Connecting to MetaMask…" state while we wait.
      setStep(STEP_REQUESTING_CHALLENGE)
      setError('')
      setErrorCode('')
      let attempts = 0
      let cancelled = false
      const pollTimer = setInterval(() => {
        if (cancelled) return
        attempts += 1
        if (detectMetaMaskNow()) {
          clearInterval(pollTimer)
          startPhase2()
          return
        }
        if (attempts >= MAX_WAIT_ATTEMPTS) {
          clearInterval(pollTimer)
          // MetaMask genuinely didn't appear after ~5s. Show an error
          // instead of silently clearing state — the user should know
          // the flow failed and why.
          if (!mobileResumeStartedRef.current) {
            mobileResumeStartedRef.current = true
            clearMobileWalletLinkParams()
            setError('MetaMask Mobile provider was not detected. Please open the link inside MetaMask Mobile and try again.')
            setErrorCode('METAMASK_PROVIDER_TIMEOUT')
            setStep(STEP_ERROR)
          }
        }
      }, ATTEMPT_INTERVAL_MS)

      // Cleanup on unmount (e.g. user navigates away while waiting)
      return () => { cancelled = true; clearInterval(pollTimer) }
    }

    // ---- Phase 3: back in Phantom's in-app browser ----
    //
    // CRITICAL: Same provider race condition as Phase 2.
    // When Phantom opens the Ronin page via the deep-link,
    // window.solana (Phantom provider) may NOT be injected yet on
    // the first React render tick. The PREVIOUS implementation did
    // a synchronous check:
    //   const hasPhantomNow = Boolean(getPhantomProvider())
    //   if (!hasPhantomNow) { clearMobileWalletLinkParams(); return }
    //
    // This was the EXACT same bug that caused Phase 2 to fail for
    // MetaMask — the sync check returned false → clearMobileWalletLinkParams()
    // fired → Phase 2 state destroyed → flow could NEVER resume.
    //
    // FIX: Same bounded retry as Phase 2 — poll every 250ms for up
    // to 5 seconds. Do NOT clear URL params until Phantom provider
    // is confirmed available.
    if (mobilePhase.phase === '2') {
      const { challengeId, evmWallet, evmSignature, messageSolana } = mobilePhase
      console.info('[WalletLinkMobile] wl=2 detected', {
        challengeId,
        evmWalletShort: evmWallet.slice(0, 6) + '...' + evmWallet.slice(-4),
        sigLen: evmSignature?.length,
        msLen: messageSolana?.length,
      })

      // Detect Phantom provider at a single point in time.
      const detectPhantomNow = () => Boolean(getPhantomProvider())

      const startPhase3 = () => {
        mobileResumeStartedRef.current = true
        console.info('[WalletLinkMobile] Phantom provider detected')
        console.info('[WalletLinkMobile] challengeId detected', { challengeId })
        console.info('[WalletLinkMobile] EVM wallet detected', {
          evmWalletShort: evmWallet.slice(0, 6) + '...' + evmWallet.slice(-4),
        })
        console.info('[WalletLinkMobile] EVM signature detected', { sigLen: evmSignature?.length })
        console.info('[WalletLinkMobile] Solana message decoded', { msLen: messageSolana?.length })

        setEvmAddress(evmWallet)
        setActiveLink({
          solanaWallet: solanaWallet || '',
          evmWallet,
          challengeId,
          messageEvm: '',
          messageSolana,
        })
        // Clear the URL params NOW — we've confirmed Phantom is available
        // and read all values into local variables. It's safe to clear.
        clearMobileWalletLinkParams()
        // Sign with Phantom (signMessage). Same as desktop.
        setStep(STEP_SIGNING_SOLANA)
        setError('')
        setErrorCode('')
        ;(async () => {
          try {
            console.info('[WalletLinkMobile] Phantom signMessage started')
            const solanaSig = await signLinkMessageWithPhantom({ message: messageSolana })
            console.info('[WalletLinkMobile] Phantom signMessage completed', {
              sigLen: solanaSig?.length,
            })
            // Verify with backend. Same endpoint, same payload as desktop.
            setStep(STEP_VERIFYING)
            console.info('[WalletLinkMobile] verify request started', { challengeId })
            const result = await verifyWalletLink({
              challengeId,
              evmSignature,
              solanaSignature: solanaSig,
            })
            console.info('[WalletLinkMobile] verify request completed', {
              success: result?.success,
              solanaWalletShort: result?.solanaWallet ? result.solanaWallet.slice(0, 4) + '...' + result.solanaWallet.slice(-4) : null,
              evmWalletShort: result?.evmWallet ? result.evmWallet.slice(0, 6) + '...' + result.evmWallet.slice(-4) : null,
            })

            // CRITICAL: refreshLinkedWallets() uses wallet?.address from
            // React state, but after the mobile deep-link return, the
            // closure captured wallet?.address=null (Phantom hadn't
            // connected yet). This causes refreshLinkedWallets to return
            // early with setVerifiedEvmWallets([]), so the linked EVM
            // wallet never appears in the UI.
            //
            // FIX: After verify succeeds:
            // 1. Call refreshLinkedWalletsRef.current() immediately (might
            //    return early if wallet.address is null)
            // 2. ALSO fetch verified identity using result.solanaWallet
            //    directly (bypasses wallet.address dependency entirely)
            // 3. If wallet.address was null, poll for it to become available
            //    (bounded, ~5s) then call refreshLinkedWalletsRef.current()
            //    again — this time it will succeed and update verifiedEvmWallets
            console.info('[WalletLinkMobile] refreshLinkedWallets started')
            await refreshLinkedWalletsRef.current()
            console.info('[WalletLinkMobile] refreshLinkedWallets completed')

            // ALSO fetch verified identity using the solana wallet from
            // the verify response — this is the authoritative address.
            // If refreshLinkedWallets returned early (stale wallet.address),
            // this fetch ensures the UI still shows the linked EVM wallet.
            if (result?.solanaWallet) {
              try {
                console.info('[WalletLinkMobile] fetching verified identity using result.solanaWallet')
                const identity = await getVerifiedRewardIdentity(result.solanaWallet)
                console.info('[WalletLinkMobile] verified identity fetched', {
                  linkedEvmCount: identity?.linked_evm_wallets?.length || 0,
                })
                if (identity?.linked_evm_wallets) {
                  setAggregatedPoints(identity)
                }
              } catch (aggErr) {
                console.warn('[WalletLinkMobile] could not fetch aggregated balance', aggErr?.message)
              }
            }

            // If wallet.address was null when we called refreshLinkedWallets,
            // poll for Phantom to connect, then call again. This ensures
            // verifiedEvmWallets in WalletContext is updated even if Phantom
            // reconnects after our first call.
            //
            // We check the Phantom provider's publicKey directly (not React
            // state) because the closure captured wallet=null at the time
            // startPhase3 was created. React state won't update inside this
            // async closure.
            if (!wallet?.address) {
              console.info('[WalletLinkMobile] wallet.address still null — polling for Phantom reconnect')
              let reconnectAttempts = 0
              const MAX_RECONNECT_ATTEMPTS = 20  // 5 seconds at 250ms
              await new Promise((resolve) => {
                const reconnectTimer = setInterval(() => {
                  reconnectAttempts += 1
                  // Check the Phantom provider's publicKey directly —
                  // this reflects the actual connection state, not React state
                  const phantomProvider = getPhantomProvider()
                  const phantomConnected = Boolean(
                    phantomProvider?.isConnected ||
                    phantomProvider?.publicKey
                  )
                  if (phantomConnected) {
                    clearInterval(reconnectTimer)
                    console.info('[WalletLinkMobile] Phantom reconnected (provider publicKey detected)')
                    resolve()
                    return
                  }
                  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    clearInterval(reconnectTimer)
                    console.warn('[WalletLinkMobile] Phantom reconnect wait timed out after 5s')
                    resolve()
                  }
                }, 250)
              })
              // Give React a tick to process the wallet state update from
              // Phantom's connect event, then call refreshLinkedWallets again
              await new Promise((resolve) => setTimeout(resolve, 500))
              console.info('[WalletLinkMobile] re-calling refreshLinkedWallets after reconnect wait')
              await refreshLinkedWalletsRef.current()
              console.info('[WalletLinkMobile] refreshLinkedWallets re-call completed')
            }
            console.info('[WalletLinkMobile] LINK SUCCESS')
            setStep(STEP_SUCCESS)
            onLinkedChange?.(result)
          } catch (e) {
            const msg = e?.message || 'Mobile Solana signing or verification failed.'
            console.error('[WalletLinkMobile] Phase 3 failed', {
              message: msg,
              code: e?.code,
              challengeId,
            })
            setError(msg)
            setErrorCode(String(e?.code || 'MOBILE_SOLANA_FAILED'))
            setStep(STEP_ERROR)
          }
        })()
      }

      if (detectPhantomNow()) {
        startPhase3()
        return
      }

      // Provider not yet injected — wait with a bounded retry.
      // Show the signing state while we wait.
      setStep(STEP_SIGNING_SOLANA)
      setError('')
      setErrorCode('')
      const MAX_WAIT_ATTEMPTS = 20
      const ATTEMPT_INTERVAL_MS = 250
      let attempts = 0
      let cancelled = false
      const pollTimer = setInterval(() => {
        if (cancelled) return
        attempts += 1
        if (detectPhantomNow()) {
          clearInterval(pollTimer)
          startPhase3()
          return
        }
        if (attempts >= MAX_WAIT_ATTEMPTS) {
          clearInterval(pollTimer)
          if (!mobileResumeStartedRef.current) {
            mobileResumeStartedRef.current = true
            clearMobileWalletLinkParams()
            console.error('[WalletLinkMobile] Phantom provider timeout after 5s')
            setError('Phantom provider was not detected. Please open the link inside Phantom and try again.')
            setErrorCode('PHANTOM_PROVIDER_TIMEOUT')
            setStep(STEP_ERROR)
          }
        }
      }, ATTEMPT_INTERVAL_MS)

      // Cleanup on unmount
      return () => { cancelled = true; clearInterval(pollTimer) }
    }
  }, [solanaWallet, refreshLinkedWallets, onLinkedChange])

  // --- Step 1: Connect MetaMask + create challenge ---
  //
  // DESKTOP (unchanged): window.ethereum is injected → ensureMetaMaskAccount()
  // returns the address → createWalletLinkChallenge → signLinkMessageWithMetaMask
  // → signLinkMessageWithPhantom → verifyWalletLink. This is the canonical
  // desktop flow and is byte-for-byte preserved.
  //
  // MOBILE Phase 1: window.ethereum is NOT injected (Phantom browser).
  // ensureMetaMaskAccount() returns the EVM_REDIRECTING_TO_METAMASK_MOBILE
  // sentinel. We:
  //   1. setStep(STEP_OPENING_METAMASK_MOBILE) FIRST — React renders the
  //      "Opening MetaMask…" waiting state
  //   2. setShouldOpenMetaMaskMobile(true) to schedule the deep-link
  //      navigation on the NEXT useEffect tick (after React commits)
  //   3. The deep-link uses openMetaMaskMobileForWalletLink(solanaWallet)
  //      which appends ?wl=1&sw=<solanaWallet> to the Ronin URL. When
  //      MetaMask Mobile opens the page, the mobile auto-resume useEffect
  //      (above) detects ?wl=1 and auto-starts Phase 2 (EVM connect +
  //      sign). This is the SAME createWalletLinkChallenge + personal_sign
  //      that desktop uses — no separate mobile signing protocol.
  const [shouldOpenMetaMaskMobile, setShouldOpenMetaMaskMobile] = useState(false)
  const pendingSolanaWalletRef = useRef(null)

  useEffect(() => {
    if (!shouldOpenMetaMaskMobile) return
    setShouldOpenMetaMaskMobile(false)
    // Use the wallet-link-specific deep-link that appends ?wl=1&sw=<solanaWallet>
    // so MetaMask Mobile can auto-resume the EVM signing flow.
    const sw = pendingSolanaWalletRef.current
    if (sw) {
      openMetaMaskMobileForWalletLink(sw)
    } else {
      openMetaMaskMobile()
    }
  }, [shouldOpenMetaMaskMobile])

  const startLink = useCallback(async () => {
    if (!solanaWallet) {
      setError('Connect your Solana wallet first.')
      setErrorCode('NO_SOLANA_WALLET')
      setStep(STEP_ERROR)
      return
    }
    setStep(STEP_REQUESTING_CHALLENGE)
    setError('')
    setErrorCode('')
    setAggregatedPoints(null)
    try {
      const evm = await ensureMetaMaskAccount()

      // Mobile Phase 1: no injected MetaMask provider. Schedule the
      // deep-link to MetaMask Mobile with ?wl=1&sw=<solanaWallet> so
      // the flow auto-resumes when MetaMask Mobile opens the page.
      if (evm === EVM_REDIRECTING_TO_METAMASK_MOBILE) {
        pendingSolanaWalletRef.current = solanaWallet
        setStep(STEP_OPENING_METAMASK_MOBILE)
        setShouldOpenMetaMaskMobile(true)
        return
      }

      // DESKTOP: window.ethereum was available, so ensureMetaMaskAccount()
      // returned the EVM address. Continue with the normal desktop flow.

      setEvmAddress(evm)
      const challenge = await createWalletLinkChallenge({
        solanaWallet,
        evmWallet: evm,
      })
      setActiveLink({
        solanaWallet: challenge.solanaWallet,
        evmWallet: challenge.evmWallet,
        challengeId: challenge.challengeId,
        messageEvm: challenge.messageEvm,
        messageSolana: challenge.messageSolana,
      })
      await signEvm(challenge)
    } catch (e) {
      const msg = e?.message || 'Could not start the link flow.'
      console.error('[WalletLinkPanel] startLink failed', { code: e?.code, message: msg })
      setError(msg)
      setErrorCode(String(e?.code || 'START_FAILED'))
      setStep(STEP_ERROR)
    }
  }, [solanaWallet])

  // --- Step 2: Sign with MetaMask ---
  const signEvm = useCallback(async (challenge) => {
    setStep(STEP_SIGNING_EVM)
    setError('')
    setErrorCode('')
    try {
      const evmSig = await signLinkMessageWithMetaMask({
        address: challenge.evmWallet,
        message: challenge.messageEvm,
      })
      await signSolana({ ...challenge, evmSignature: evmSig })
    } catch (e) {
      const msg = e?.message || 'MetaMask signature failed.'
      console.error('[WalletLinkPanel] EVM signature failed', { code: e?.code, message: msg })
      if (/reject|denied|4001/i.test(msg)) {
        setError('You cancelled the MetaMask signature. The link was not created.')
        setErrorCode('EVM_REJECTED')
      } else {
        setError(msg)
        setErrorCode(String(e?.code || 'EVM_SIGN_FAILED'))
      }
      setStep(STEP_ERROR)
    }
  }, [])

  // --- Step 3: Sign with Phantom ---
  const signSolana = useCallback(async ({ challengeId, solanaWallet, messageSolana, evmSignature }) => {
    setStep(STEP_SIGNING_SOLANA)
    setError('')
    setErrorCode('')
    try {
      const solanaSig = await signLinkMessageWithPhantom({ message: messageSolana })
      await verify({ challengeId, evmSignature, solanaSignature: solanaSig })
    } catch (e) {
      const msg = e?.message || 'Phantom signature failed.'
      console.error('[WalletLinkPanel] Solana signature failed', { code: e?.code, message: msg })
      if (/reject|denied|cancelled/i.test(msg)) {
        setError('You cancelled the Phantom signature. The link was not created.')
        setErrorCode('SOLANA_REJECTED')
      } else {
        setError(msg)
        setErrorCode(String(e?.code || 'SOLANA_SIGN_FAILED'))
      }
      setStep(STEP_ERROR)
    }
  }, [])

  // --- Step 4 + 5: Backend verifies both signatures + links identity ---
  const verify = useCallback(async ({ challengeId, evmSignature, solanaSignature }) => {
    setStep(STEP_VERIFYING)
    setError('')
    setErrorCode('')
    try {
      const result = await verifyWalletLink({ challengeId, evmSignature, solanaSignature })
      // Refresh the verified identity in WalletContext so the rest of
      // the UI sees the new link.
      await refreshLinkedWallets()
      // Fetch the aggregated balance so we can show the user their
      // total linked points (from the backend — NEVER hardcoded).
      try {
        const identity = await getVerifiedRewardIdentity(solanaWallet)
        if (identity?.linked_evm_wallets) {
          setAggregatedPoints(identity)
        }
      } catch (aggErr) {
        // Non-fatal — the link succeeded, we just couldn't fetch the
        // aggregated balance for display.
        console.warn('[WalletLinkPanel] could not fetch aggregated balance', aggErr?.message)
      }
      setStep(STEP_SUCCESS)
      onLinkedChange?.(result)
    } catch (e) {
      const msg = e?.message || 'The wallet link could not be verified.'
      // Log the full backend error code to the console for debugging
      // (without exposing secrets — the code is just an enum string
      // like EVM_ALREADY_LINKED_ELSEWHERE).
      console.error('[WalletLinkPanel] verify failed', {
        code: e?.code,
        message: msg,
        challengeId,
      })
      setError(msg)
      setErrorCode(String(e?.code || 'VERIFY_FAILED'))
      setStep(STEP_ERROR)
    }
  }, [refreshLinkedWallets, onLinkedChange, solanaWallet])

  // --- Unlink flow: only the Solana wallet owner can revoke ---
  const unlink = useCallback(async (evmWallet) => {
    if (!solanaWallet) return
    if (!window.confirm(`Unlink ${shortAddr(evmWallet)} from your Solana reward identity? Future Samurai Points earned by this EVM wallet will no longer be aggregated into your reward balance.`)) return
    setUnlinkingEvm(evmWallet)
    setError('')
    setErrorCode('')
    try {
      const challenge = await createRevokeChallenge({ solanaWallet, evmWallet })
      const sig = await signRevokeMessageWithPhantom({ message: challenge.message })
      await revokeWalletLink({
        solanaWallet,
        evmWallet,
        solanaSignature: sig,
        message: challenge.message,
      })
      await refreshLinkedWallets()
    } catch (e) {
      const msg = e?.message || 'Could not unlink the wallet.'
      console.error('[WalletLinkPanel] unlink failed', { code: e?.code, message: msg })
      if (/reject|denied|cancelled/i.test(msg)) {
        setError('You cancelled the Phantom signature. The link was not revoked.')
        setErrorCode('SOLANA_REJECTED')
      } else {
        setError(msg)
        setErrorCode(String(e?.code || 'UNLINK_FAILED'))
      }
    } finally {
      setUnlinkingEvm(null)
    }
  }, [solanaWallet, refreshLinkedWallets])

  const resetFlow = () => {
    // Reset the mobile resume guard so a new flow can start after
    // a failure or manual cancel.
    mobileResumeStartedRef.current = false
    setStep(STEP_IDLE)
    setError('')
    setErrorCode('')
    setActiveLink(null)
    setEvmAddress('')
    setAggregatedPoints(null)
  }

  // -- Render -------------------------------------------------------

  // Detect mobile wallet-link phase from URL params. On mobile, the
  // EVM wallet-link flow spans two browser contexts:
  //   Phase 1: Phantom browser → deep-link to MetaMask Mobile
  //   Phase 2: MetaMask Mobile browser → EVM connect + sign (NO Phantom here)
  //   Phase 3: Back in Phantom browser → Solana sign + verify
  //
  // During Phase 2, window.solana (Phantom) is NOT available inside
  // MetaMask Mobile's in-app browser. So both `solanaWallet` AND
  // `hasPhantom` will be null/false. Without bypassing the guards
  // below, the panel would render the "Connect Solana first" empty
  // state — blocking the auto-resume useEffect from firing.
  //
  // When a mobile phase IS active, we skip the early-returns and
  // render the main panel body so the auto-resume useEffect (defined
  // above) can detect the phase and run the EVM signing flow.
  const mobileWalletLinkPhase = getMobileWalletLinkPhase()

  if (!solanaWallet && !mobileWalletLinkPhase) {
    return (
      <section className="profile-panel profile-wallet-link-panel">
        <SectionHeading
          eyebrow="WALLET LINK"
          title="Link your EVM wallet"
          text="Connect a Solana wallet to begin. EVM wallets can only be linked after a Solana payout wallet is connected."
        />
        <div className="ronin-wallet-link-empty">
          <Icon name="wallet" size={22} />
          <p>Connect your Solana wallet to start the link flow.</p>
        </div>
      </section>
    )
  }

  if (!hasPhantom && !mobileWalletLinkPhase) {
    return (
      <section className="profile-panel profile-wallet-link-panel">
        <SectionHeading
          eyebrow="WALLET LINK"
          title="Link your EVM wallet"
        />
        <div className="ronin-wallet-link-empty">
          <Icon name="info" size={22} />
          <p>Phantom is required to link an EVM wallet. Install Phantom and reconnect.</p>
        </div>
      </section>
    )
  }

  const progressIndex = stepToProgressIndex(step)

  return (
    <section className="profile-panel profile-wallet-link-panel">
      <SectionHeading
        eyebrow="WALLET LINK"
        title="Verified reward identity"
        text="Link the EVM wallet you used for your swaps to associate your eligible Samurai Points with your Solana reward identity. You will sign a message with both wallets to prove ownership. This signature does not authorize transactions or token transfers."
      />

      {/* Solana payout wallet summary — uses the same profile-rewards-stat styling */}
      <div className="ronin-wallet-link-grid">
        <div className="ronin-wallet-link-stat">
          <span className="profile-data-label">SOLANA PAYOUT WALLET</span>
          <strong className="ronin-wallet-link-addr">{shortAddr(solanaWallet) || '—'}</strong>
          <small>SOL rewards are paid to this wallet</small>
        </div>
        <div className="ronin-wallet-link-stat">
          <span className="profile-data-label">LINKED EVM WALLETS</span>
          <strong>{linkedList.length}</strong>
          <small>Verified EVM wallets</small>
        </div>
      </div>

      {/* Existing linked wallets list */}
      {linkedList.length > 0 && (
        <ul className="ronin-wallet-link-list">
          {linkedList.map((evm) => (
            <li key={evm}>
              <div>
                <strong className="ronin-wallet-link-addr">{shortAddr(evm)}</strong>
                <small>Verified · cryptographically proven ownership</small>
              </div>
              <Tag tone="green">LINKED</Tag>
              <Button
                variant="outline"
                icon="close"
                disabled={unlinkingEvm === evm || step !== STEP_IDLE}
                onClick={() => unlink(evm)}
              >
                {unlinkingEvm === evm ? 'Unlinking…' : 'Unlink'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* =================================================================
          STATE: IDLE — before linking
          =================================================================
          Shows the "Link EVM Wallet" CTA + the explanation copy.
          ================================================================= */}
      {step === STEP_IDLE && (
        <div className="ronin-wallet-link-idle">
          <div className="ronin-wallet-link-idle-copy">
            <strong>Link EVM Wallet</strong>
            <p>
              Connect the wallet you used for your EVM swaps to associate your
              eligible Samurai Points with your Solana reward identity.
            </p>
            <small className="ronin-wallet-link-note">
              <Icon name="info" size={12} /> Message signatures only — no blockchain transactions are triggered by linking.
            </small>
          </div>
          <Button variant="primary" icon="link" onClick={startLink}>
            Link EVM Wallet
          </Button>
        </div>
      )}

      {/* =================================================================
          STATE: OPENING_METAMASK_MOBILE — mobile-only redirect
          =================================================================
          MetaMask was not injected in this mobile browser. We've
          deep-linked into MetaMask Mobile — it will reopen this site
          in its in-app browser, where window.ethereum is injected.

          No challenge has been created yet. The user clicks "Link EVM
          Wallet" again after the site reloads inside MetaMask Mobile.

          This is a waiting state, not an error — the user just needs
          to follow the redirect.
          ================================================================= */}
      {step === STEP_OPENING_METAMASK_MOBILE && (
        <div className="ronin-wallet-link-flow">
          <div className="ronin-wallet-link-flow-header">
            <strong>Opening MetaMask…</strong>
            <small>The EVM signing flow will continue automatically once MetaMask opens.</small>
          </div>
          <div className="ronin-wallet-link-mobile-waiting">
            <span className="ronin-wallet-link-spinner" aria-label="Loading" />
            <p>
              MetaMask Mobile will reopen this page in its in-app browser and
              automatically continue the EVM wallet-link flow. You'll be asked
              to approve the MetaMask connection and sign the linking message.
            </p>
            <Button variant="outline" icon="refresh" onClick={() => {
              const sw = pendingSolanaWalletRef.current
              if (sw) openMetaMaskMobileForWalletLink(sw)
              else openMetaMaskMobile()
            }}>
              Open MetaMask
            </Button>
            <Button variant="outline" onClick={resetFlow}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* =================================================================
          STATE: RETURNING_TO_PHANTOM — mobile Phase 2→3 transition
          =================================================================
          EVM signature was obtained inside MetaMask Mobile. We're
          deep-linking BACK to Phantom so the user can sign the Solana
          message. The page is about to navigate away — this is a brief
          redirect state with no user action required.
          ================================================================= */}
      {step === STEP_RETURNING_TO_PHANTOM && (
        <div className="ronin-wallet-link-flow">
          <div className="ronin-wallet-link-flow-header">
            <strong>✓ EVM signed — returning to Phantom…</strong>
            <small>The Solana signing step will continue automatically once Phantom opens.</small>
          </div>
          <div className="ronin-wallet-link-mobile-waiting">
            <span className="ronin-wallet-link-spinner" aria-label="Loading" />
            <p>
              Your EVM wallet signature was obtained in MetaMask. We're now
              reopening this page in Phantom so you can sign the Solana linking
              message to complete the wallet link.
            </p>
          </div>
        </div>
      )}

      {/* =================================================================
          STATE: FLOW (requesting challenge + signing + verifying)
          =================================================================
          Shows the 4-step progress. Each step shows:
            ✓  → completed
            ◯  → active (spinner)
            •  → pending
          The copy explicitly says "Message signatures only — no
          transactions are being sent."
          ================================================================= */}
      {(step === STEP_REQUESTING_CHALLENGE ||
        step === STEP_SIGNING_EVM ||
        step === STEP_SIGNING_SOLANA ||
        step === STEP_VERIFYING) && (
        <div className="ronin-wallet-link-flow">
          <div className="ronin-wallet-link-flow-header">
            <strong>Linking your wallets…</strong>
            <small>Message signatures only — no blockchain transactions are being sent.</small>
          </div>
          <ol className="ronin-wallet-link-progress">
            {PROGRESS_STEPS.map((progStep, index) => {
              const isComplete = index < progressIndex
              const isActive = index === progressIndex
              const isPending = index > progressIndex
              return (
                <li
                  key={progStep.id}
                  className={
                    isComplete ? 'is-complete' :
                    isActive ? 'is-active' :
                    'is-pending'
                  }
                >
                  <span className="ronin-wallet-link-progress-mark">
                    {isComplete ? (
                      <Icon name="check" size={16} />
                    ) : isActive ? (
                      <span className="ronin-wallet-link-spinner" aria-label="Loading" />
                    ) : (
                      <span className="ronin-wallet-link-progress-dot" />
                    )}
                  </span>
                  <div className="ronin-wallet-link-progress-text">
                    <strong>{progStep.label}</strong>
                    {isActive && progStep.id === 'evm-sig' && (
                      <small>Approve the personal_sign popup in MetaMask{evmAddress ? ` (${shortAddr(evmAddress)})` : ''}.</small>
                    )}
                    {isActive && progStep.id === 'solana-sig' && (
                      <small>Approve the signMessage popup in Phantom.</small>
                    )}
                    {isActive && progStep.id === 'verify' && (
                      <small>Backend is verifying both signatures.</small>
                    )}
                    {isActive && progStep.id === 'link' && (
                      <small>Associating EVM points with your Solana reward identity.</small>
                    )}
                    {!isActive && <small>{progStep.sub}</small>}
                  </div>
                </li>
              )
            })}
          </ol>
          {step === STEP_REQUESTING_CHALLENGE && (
            <p className="ronin-wallet-link-flow-status">Creating challenge…</p>
          )}
        </div>
      )}

      {/* =================================================================
          STATE: SUCCESS — after successful linking
          =================================================================
          Shows ✓ success message + aggregated points (from backend,
          NEVER hardcoded). The user's existing Solana points are NOT
          reset — the copy makes this clear.
          ================================================================= */}
      {step === STEP_SUCCESS && (
        <div className="ronin-wallet-link-success">
          <div className="ronin-wallet-link-success-mark">
            <Icon name="check" size={22} />
          </div>
          <div>
            <strong>EVM Wallet Linked</strong>
            <p>
              Your eligible EVM Samurai Points are now associated with your Solana reward identity.
            </p>
            {aggregatedPoints?.solana_wallet && (
              <small className="ronin-wallet-link-points">
                Linked to: <code>{shortAddr(aggregatedPoints.solana_wallet)}</code>
              </small>
            )}
            <small className="ronin-wallet-link-note">
              <Icon name="info" size={12} /> Your existing Solana points are not replaced or reset. Payouts remain through the existing Solana reward system.
            </small>
          </div>
        </div>
      )}

      {/* =================================================================
          STATE: ERROR — verify endpoint failed
          =================================================================
          Shows a friendly error + the specific backend error code
          (for debugging) + a "Try again" button. The actual backend
          error is also logged to the browser console via
          console.error in the verify() function above.
          ================================================================= */}
      {step === STEP_ERROR && (
        <div className="ronin-wallet-link-error">
          <div className="ronin-wallet-link-error-mark">
            <Icon name="info" size={22} />
          </div>
          <div>
            <strong>Wallet linking could not be completed</strong>
            <p>{error || 'Please try again.'}</p>
            {errorCode && errorCode !== 'VERIFY_FAILED' && (
              <code className="ronin-wallet-link-error-code">{errorCode}</code>
            )}
            {/* Actionable hints per error code */}
            {errorCode === 'EVM_ALREADY_LINKED_ELSEWHERE' && (
              <div className="ronin-wallet-link-hint">
                <small>
                  Your EVM wallet was previously linked to a different Solana wallet. To fix:
                </small>
                <ol>
                  <li>Connect that previous Solana wallet in Phantom and use <strong>Unlink</strong> on the existing link.</li>
                  <li>Or run this SQL on Supabase to clear all your existing ACTIVE links:<br />
                    <code>
                      UPDATE public.wallet_links SET status='REVOKED', revoked_at=now() WHERE evm_wallet='{evmAddress || '0xYOUR_EVM_ADDRESS'}' AND status='ACTIVE';
                    </code>
                  </li>
                </ol>
              </div>
            )}
            {errorCode === 'EVM_REJECTED' && (
              <div className="ronin-wallet-link-hint">
                <small>You cancelled the MetaMask popup. Click <strong>Try again</strong> and approve both popups to complete the link.</small>
              </div>
            )}
            {errorCode === 'SOLANA_REJECTED' && (
              <div className="ronin-wallet-link-hint">
                <small>You cancelled the Phantom popup. Click <strong>Try again</strong> and approve both popups to complete the link.</small>
              </div>
            )}
            {errorCode === 'CHALLENGE_NOT_PENDING' && (
              <div className="ronin-wallet-link-hint">
                <small>This challenge was already used. Click <strong>Try again</strong> to start a fresh link with a new challenge.</small>
              </div>
            )}
            {errorCode === 'CHALLENGE_EXPIRED' && (
              <div className="ronin-wallet-link-hint">
                <small>The signatures took longer than 5 minutes. Click <strong>Try again</strong> and approve both popups faster.</small>
              </div>
            )}
          </div>
          <Button variant="outline" icon="refresh" onClick={resetFlow}>Try again</Button>
        </div>
      )}

      {/* Footer note — always visible */}
      <p className="ronin-wallet-link-footer-note">
        <Icon name="shield" size={12} /> Wallet linking proves ownership only. It does not authorize token transfers, transactions, spending, or access to funds. Existing Solana points are never reset.
      </p>
    </section>
  )
}
