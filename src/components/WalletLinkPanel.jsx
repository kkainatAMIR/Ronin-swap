import { useCallback, useEffect, useState } from 'react'
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
  return -1
}

function shortAddr(addr) {
  if (!addr) return ''
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function WalletLinkPanel({ onLinkedChange }) {
  const { wallet, linkedEvmWallets, refreshLinkedWallets, solanaPayoutWallet } = useWallet()
  const [step, setStep] = useState(STEP_IDLE)
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [evmAddress, setEvmAddress] = useState('')
  const [activeLink, setActiveLink] = useState(null)
  const [unlinkingEvm, setUnlinkingEvm] = useState(null)
  const [aggregatedPoints, setAggregatedPoints] = useState(null)

  // Reset state if the user switches Phantom wallet.
  useEffect(() => {
    setStep(STEP_IDLE)
    setError('')
    setErrorCode('')
    setActiveLink(null)
    setEvmAddress('')
    setAggregatedPoints(null)
  }, [wallet?.address])

  const solanaWallet = solanaPayoutWallet || (wallet?.address && !wallet?.isDemo ? wallet.address : null)
  const hasPhantom = Boolean(getPhantomProvider())
  const linkedList = linkedEvmWallets || []

  // --- Step 1: Connect MetaMask + create challenge ---
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
    setStep(STEP_IDLE)
    setError('')
    setErrorCode('')
    setActiveLink(null)
    setEvmAddress('')
    setAggregatedPoints(null)
  }

  // -- Render -------------------------------------------------------

  if (!solanaWallet) {
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

  if (!hasPhantom) {
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
          <strong className="ronin-wallet-link-addr">{shortAddr(solanaWallet)}</strong>
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
