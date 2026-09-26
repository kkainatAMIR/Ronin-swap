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
// WalletLinkPanel — the UI flow for cryptographically linking an EVM
// wallet to the user's verified Solana payout wallet.
// =====================================================================
//
// The user must explicitly click LINK WALLET. Nothing is auto-linked.
// The flow is:
//
//   1. (Precondition) Phantom connected — otherwise we tell the user
//      to connect Phantom first.
//   2. User clicks LINK EVM WALLET.
//   3. Backend creates a challenge (server-generated nonce + signed
//      messages for both wallets).
//   4. Frontend asks MetaMask to sign the EVM message (personal_sign).
//   5. Frontend asks Phantom to sign the Solana message (signMessage).
//   6. Frontend POSTs both signatures to /api/wallet-link/verify.
//   7. Backend verifies EIP-191 + ed25519, atomically marks challenge
//      USED, inserts the wallet_links row.
//   8. WalletContext.refreshLinkedWallets() is called so the rest of
//      the UI (RewardClaimPanel, Profile) sees the new link.
//
// The user can also UNLINK an EVM wallet by signing a fresh revocation
// message with Phantom (only the Solana wallet's owner can revoke).
// =====================================================================

const STEP_IDLE = 'idle'
const STEP_REQUESTING_CHALLENGE = 'requesting-challenge'
const STEP_SIGNING_EVM = 'signing-evm'
const STEP_SIGNING_SOLANA = 'signing-solana'
const STEP_VERIFYING = 'verifying'
const STEP_SUCCESS = 'success'
const STEP_ERROR = 'error'

export default function WalletLinkPanel({ onLinkedChange }) {
  const { wallet, linkedEvmWallets, refreshLinkedWallets } = useWallet()
  const [step, setStep] = useState(STEP_IDLE)
  const [error, setError] = useState('')
  const [evmAddress, setEvmAddress] = useState('')
  const [activeLink, setActiveLink] = useState(null)  // {solanaWallet, evmWallet, challengeId, messageEvm, messageSolana}
  const [unlinkingEvm, setUnlinkingEvm] = useState(null) // address being unlinked

  // Reset state if the user switches Phantom wallet.
  useEffect(() => {
    setStep(STEP_IDLE)
    setError('')
    setActiveLink(null)
    setEvmAddress('')
  }, [wallet?.address])

  const solanaWallet = wallet?.address && !wallet?.isDemo ? wallet.address : null
  const hasPhantom = Boolean(getPhantomProvider())
  const linkedList = linkedEvmWallets || []

  // --- Step 1: Connect MetaMask + create challenge ---
  const startLink = useCallback(async () => {
    if (!solanaWallet) {
      setError('Connect your Solana wallet first.')
      setStep(STEP_ERROR)
      return
    }
    setStep(STEP_REQUESTING_CHALLENGE)
    setError('')
    try {
      // Connect MetaMask + fetch the user's EVM address.
      const evm = await ensureMetaMaskAccount()
      setEvmAddress(evm)
      // Backend creates the challenge (server-generated nonce + both
      // signing messages).
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
      // Proceed to step 2 (sign with MetaMask).
      await signEvm(challenge)
    } catch (e) {
      setError(e?.message || 'Could not start the link flow.')
      setStep(STEP_ERROR)
    }
  }, [solanaWallet])

  // --- Step 2: Sign with MetaMask ---
  const signEvm = useCallback(async (challenge) => {
    setStep(STEP_SIGNING_EVM)
    setError('')
    try {
      const evmSig = await signLinkMessageWithMetaMask({
        address: challenge.evmWallet,
        message: challenge.messageEvm,
      })
      await signSolana({ ...challenge, evmSignature: evmSig })
    } catch (e) {
      // User rejected the MetaMask popup OR MetaMask unavailable.
      const msg = e?.message || 'MetaMask signature failed.'
      if (/reject|denied|4001/i.test(msg)) {
        setError('You cancelled the MetaMask signature. The link was not created.')
      } else {
        setError(msg)
      }
      setStep(STEP_ERROR)
    }
  }, [])

  // --- Step 3: Sign with Phantom ---
  const signSolana = useCallback(async ({ challengeId, solanaWallet, messageSolana, evmSignature }) => {
    setStep(STEP_SIGNING_SOLANA)
    setError('')
    try {
      const solanaSig = await signLinkMessageWithPhantom({ message: messageSolana })
      await verify({ challengeId, evmSignature, solanaSignature: solanaSig })
    } catch (e) {
      const msg = e?.message || 'Phantom signature failed.'
      if (/reject|denied|cancelled/i.test(msg)) {
        setError('You cancelled the Phantom signature. The link was not created.')
      } else {
        setError(msg)
      }
      setStep(STEP_ERROR)
    }
  }, [])

  // --- Step 4: Submit both signatures to the backend ---
  const verify = useCallback(async ({ challengeId, evmSignature, solanaSignature }) => {
    setStep(STEP_VERIFYING)
    setError('')
    try {
      const result = await verifyWalletLink({ challengeId, evmSignature, solanaSignature })
      setStep(STEP_SUCCESS)
      // Refresh the verified identity in WalletContext so the rest of
      // the UI sees the new link.
      await refreshLinkedWallets()
      onLinkedChange?.(result)
      // Auto-reset after a few seconds so the user can link another
      // wallet if they want.
      setTimeout(() => {
        setStep(STEP_IDLE)
        setActiveLink(null)
        setEvmAddress('')
      }, 3500)
    } catch (e) {
      setError(e?.message || 'The wallet link could not be verified.')
      setStep(STEP_ERROR)
    }
  }, [refreshLinkedWallets, onLinkedChange])

  // --- Unlink flow: only the Solana wallet owner can revoke ---
  const unlink = useCallback(async (evmWallet) => {
    if (!solanaWallet) return
    if (!window.confirm(`Unlink ${evmWallet} from your Solana reward identity? Future Samurai Points earned by this EVM wallet will no longer be aggregated into your reward balance.`)) return
    setUnlinkingEvm(evmWallet)
    setError('')
    try {
      // Backend builds the revocation message + nonce.
      const challenge = await createRevokeChallenge({ solanaWallet, evmWallet })
      // Phantom signs.
      const sig = await signRevokeMessageWithPhantom({ message: challenge.message })
      // Backend verifies + revokes.
      await revokeWalletLink({
        solanaWallet,
        evmWallet,
        solanaSignature: sig,
        message: challenge.message,
      })
      await refreshLinkedWallets()
    } catch (e) {
      const msg = e?.message || 'Could not unlink the wallet.'
      if (/reject|denied|cancelled/i.test(msg)) {
        setError('You cancelled the Phantom signature. The link was not revoked.')
      } else {
        setError(msg)
      }
    } finally {
      setUnlinkingEvm(null)
    }
  }, [solanaWallet, refreshLinkedWallets])

  const resetFlow = () => {
    setStep(STEP_IDLE)
    setError('')
    setActiveLink(null)
    setEvmAddress('')
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
        <div className="profile-wallet-link-empty">
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
        <div className="profile-wallet-link-empty">
          <Icon name="info" size={22} />
          <p>Phantom is required to link an EVM wallet. Install Phantom and reconnect.</p>
        </div>
      </section>
    )
  }

  return (
    <section className="profile-panel profile-wallet-link-panel">
      <SectionHeading
        eyebrow="WALLET LINK"
        title="Verified reward identity"
        text="Link your EVM wallets to include their Samurai Points in your Solana reward balance. Signatures are used only to prove wallet ownership — no transactions or token transfers are authorized."
      />

      <div className="profile-wallet-link-grid">
        <div className="profile-wallet-link-stat">
          <span className="profile-data-label">SOLANA PAYOUT WALLET</span>
          <strong className="profile-wallet-link-addr">
            {shortAddr(solanaWallet)}
          </strong>
          <small>SOL rewards are paid to this wallet</small>
        </div>
        <div className="profile-wallet-link-stat">
          <span className="profile-data-label">LINKED EVM WALLETS</span>
          <strong>{linkedList.length}</strong>
          <small>Verified EVM wallets</small>
        </div>
      </div>

      {linkedList.length > 0 && (
        <ul className="profile-wallet-link-list">
          {linkedList.map((evm) => (
            <li key={evm}>
              <div>
                <strong className="profile-wallet-link-addr">{shortAddr(evm)}</strong>
                <small>Linked · cryptographically verified</small>
              </div>
              <Tag tone="green">VERIFIED</Tag>
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

      {/* Flow state UI */}
      <div className="profile-wallet-link-flow">
        {step === STEP_IDLE && (
          <Button variant="primary" icon="link" onClick={startLink}>
            Link EVM wallet
          </Button>
        )}
        {step === STEP_REQUESTING_CHALLENGE && <FlowStep icon="refresh" label="Creating challenge…" />}
        {step === STEP_SIGNING_EVM && (
          <FlowStep icon="wallet" label={`Sign with MetaMask (${shortAddr(evmAddress)})…`} sub="Approve the personal_sign popup in MetaMask." />
        )}
        {step === STEP_SIGNING_SOLANA && (
          <FlowStep icon="wallet" label="Sign with Phantom…" sub="Approve the signMessage popup in Phantom." />
        )}
        {step === STEP_VERIFYING && <FlowStep icon="refresh" label="Verifying signatures…" sub="Backend is verifying both signatures." />}
        {step === STEP_SUCCESS && (
          <div className="profile-wallet-link-success">
            <Icon name="check" size={18} />
            <strong>Wallet linked!</strong>
            <small>Your Samurai Points from this EVM wallet are now included in your Solana reward balance.</small>
          </div>
        )}
        {step === STEP_ERROR && (
          <div className="profile-wallet-link-error">
            <Icon name="info" size={18} />
            <strong>Link failed</strong>
            <small>{error}</small>
            <Button variant="outline" icon="refresh" onClick={resetFlow}>Try again</Button>
          </div>
        )}
      </div>

      {error && step !== STEP_ERROR && (
        <div className="profile-wallet-link-error-text">
          <Icon name="info" size={14} /> {error}
        </div>
      )}

      <p className="profile-wallet-link-note">
        <Icon name="info" size={12} /> Both signatures are verified by the backend. localStorage wallet tracking is not used for ownership proof.
      </p>
    </section>
  )
}

function shortAddr(addr) {
  if (!addr) return ''
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function FlowStep({ icon, label, sub }) {
  return (
    <div className="profile-wallet-link-step">
      <Icon name={icon || 'refresh'} size={18} />
      <div>
        <strong>{label}</strong>
        {sub && <small>{sub}</small>}
      </div>
    </div>
  )
}
