import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, SectionHeading, Tag } from '../components/Layout'
import Icon from '../components/Icon'
import { getSolanaProvider, useWallet } from '../context/WalletContext'
import { confirmRewardClaim, cancelRewardClaim, claimReward, formatRewardAmount, getRewardBalance, prepareRewardClaim, recordRewardClaimSubmission, solanaTxExplorerUrl } from '../services/rewardsService'
import WalletLinkPanel from './WalletLinkPanel'
import { sendSignedSolanaTransaction } from '../services/roninService'
import { Transaction } from '@solana/web3.js'
import bs58 from 'bs58'

function rewardDate(value) {
  if (!value) return 'Not available'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Not available'
    : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function SeasonRewardDialog({ seasonReward, network, claimDisabled, onClaim, onClose, closeButtonRef }) {
  const { season, participation = {}, allocation, claim } = seasonReward
  const claimStatus = claim?.status || allocation?.claim_status || 'AVAILABLE'
  const isClaimed = claimStatus === 'COMPLETED'
  const hasReward = Boolean(allocation?.has_reward)
  const canClaim = season.reward_pool_status === 'FINALIZED'
    && seasonReward.claim_window_open
    && hasReward
    && !['ENTITLED', 'PENDING_PAYOUT', 'COMPLETED'].includes(claimStatus)
  const now = Date.now()
  let rewardStatus = 'NO REWARD ALLOCATION'
  let rewardMessage = 'No reward allocation is available for this wallet in this season.'

  if (isClaimed) {
    rewardStatus = 'REWARD CLAIMED'
    rewardMessage = 'Your finalized season reward was successfully claimed.'
  } else if (['ENTITLED', 'PENDING_PAYOUT'].includes(claimStatus)) {
    rewardStatus = 'CLAIM PENDING'
    rewardMessage = 'Your claim is being processed. The SOL amount remains hidden until the claim is completed.'
  } else if (season.reward_pool_status === 'CONFIGURED') {
    rewardStatus = 'AWAITING FINALIZATION'
    rewardMessage = 'Your final reward will be available after the season is finalized.'
  } else if (hasReward && seasonReward.claim_window_open) {
    rewardStatus = 'REWARD NOT CLAIMED YET'
    rewardMessage = 'Your reward is available to claim during the active claim window.'
  } else if (hasReward && season.claim_window_start && now < Date.parse(season.claim_window_start)) {
    rewardStatus = 'CLAIMING OPENS SOON'
    rewardMessage = 'Your reward will become claimable when the claim window opens.'
  } else if (hasReward && season.claim_window_end && now >= Date.parse(season.claim_window_end)) {
    rewardStatus = 'CLAIM WINDOW CLOSED'
    rewardMessage = 'The claim window for this season has closed.'
  } else if (hasReward) {
    rewardStatus = 'CLAIM WINDOW NOT OPEN'
    rewardMessage = 'Your reward can be claimed when an eligible claim window opens.'
  }

  const campaigns = Array.isArray(participation.campaigns) ? participation.campaigns : []

  return (
    <div
      className="profile-season-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="profile-season-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-season-dialog-title"
      >
        <div className="profile-season-dialog-art" aria-hidden="true">
          <span>🌸</span>
          <span>🌸</span>
          <span>🌸</span>
        </div>
        <button ref={closeButtonRef} className="profile-season-dialog-close" type="button" onClick={onClose} aria-label="Close season details">
          <Icon name="close" size={16} />
        </button>
        <header className="profile-season-dialog-header">
          <span className="profile-season-dialog-kicker">🌸 YOUR SEASON ARCHIVE</span>
          <h2 id="profile-season-dialog-title">{season.name}</h2>
          {campaigns.length > 0 && (
            <p>Campaign{campaigns.length === 1 ? '' : 's'}: {campaigns.map((campaign) => campaign.name || campaign.id).join(', ')}</p>
          )}
          <Tag tone="neutral">{season.status || season.reward_pool_status}</Tag>
        </header>

        <div className="profile-season-dialog-content">
          <section className="profile-season-dialog-block">
            <h3>Your Participation</h3>
            <div className="profile-season-dialog-stats">
              <div><span>QUALIFYING SWAPS</span><strong>{Number(participation.qualifying_swaps || 0).toLocaleString('en-US')}</strong></div>
              <div><span>QUALIFYING VOLUME</span><strong>${Number(participation.qualifying_volume || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong></div>
              <div><span>SAMURAI POINTS</span><strong>{Number(participation.samurai_points || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} SP</strong></div>
              <div><span>YOUR RANK</span><strong>{participation.rank == null ? 'Not ranked' : `#${Number(participation.rank).toLocaleString('en-US')}`}</strong></div>
              <div><span>ELIGIBLE WALLETS</span><strong>{season.eligible_wallet_count == null ? 'Not available' : Number(season.eligible_wallet_count).toLocaleString('en-US')}</strong></div>
              <div><span>ELIGIBILITY</span><strong>{participation.eligibility_status || 'Qualified'}</strong></div>
            </div>
            <div className="profile-season-dialog-dates">
              <p><span>SEASON DURATION</span><strong>{rewardDate(season.start_at)} – {rewardDate(season.end_at)}</strong></p>
              <p><span>SEASON STATUS</span><strong>{season.status || 'Not available'}</strong></p>
            </div>
          </section>

          <section className="profile-season-dialog-block profile-season-dialog-reward">
            <h3>Your Reward</h3>
            <Tag tone={isClaimed ? 'green' : 'neutral'}>{rewardStatus}</Tag>
            <p>{rewardMessage}</p>
            {isClaimed && claim?.reward_amount != null && (
              <>
                <strong className="profile-season-dialog-claimed-amount">{formatRewardAmount(claim.reward_amount, claim.reward_asset || 'SOL')}</strong>
                <p><span>CLAIMED ON</span><strong>{rewardDate(claim.completed_at || claim.claimed_at)}</strong></p>
                {claim.claim_tx_signature && (
                  <a href={solanaTxExplorerUrl(claim.claim_tx_signature, network)} target="_blank" rel="noreferrer">
                    View Transaction <Icon name="arrowRight" size={13} />
                  </a>
                )}
              </>
            )}
            {season.reward_pool_status === 'FINALIZED' && (
              <p>
                <span>CLAIM WINDOW</span>
                <strong>{rewardDate(season.claim_window_start)} – {rewardDate(season.claim_window_end)}</strong>
              </p>
            )}
            {canClaim && (
              <>
                {seasonReward.claim_window_via?.id && seasonReward.claim_window_via.id !== season.id && (
                  <small>
                    This saved allocation can be claimed while {seasonReward.claim_window_via.name}&apos;s claim window is open.
                  </small>
                )}
                <Button variant="primary" icon="gift" onClick={onClaim} disabled={claimDisabled}>Claim Reward</Button>
              </>
            )}
          </section>
        </div>
      </section>
    </div>
  )
}

// RewardClaimPanel — shows the user's earned / claimed / claimable Samurai
// points balance and lets them claim available rewards.
//
// USER-PAYS-FEE FLOW (default):
//   1. prepareRewardClaim() → backend creates ENTITLED row + returns
//      partially-signed tx (admin signs instruction, user is fee payer)
//   2. Phantom signs the tx (user adds fee-payer signature)
//   3. Persist the transaction signature before broadcasting
//   4. Submit the tx via sendSignedSolanaTransaction
//   5. confirmRewardClaim(claimId, signature) → backend verifies tx landed
//      + marks COMPLETED
//
// If the user rejects the Phantom popup before signing:
//   cancelRewardClaim(claimId) → backend reverts ENTITLED row + restores points
//
// FALLBACK (admin-pays-fee): if a Phantom provider is not detected (e.g.
// mobile browser without Phantom, or admin testing), the panel falls back
// to the legacy /api/rewards/claim endpoint which uses the admin wallet
// as the fee payer.
export default function RewardClaimPanel({ wallet, expectedEvmWallet }) {
  const { solanaPayoutWallet, verifiedEvmWallets, verifiedIdentityLoaded, refreshLinkedWallets } = useWallet()
  const [balance, setBalance] = useState(null)
  const [loadedBalanceIdentity, setLoadedBalanceIdentity] = useState(null)
  const [selectedSeasonId, setSelectedSeasonId] = useState(null)
  const seasonTriggerRef = useRef(null)
  const seasonDialogCloseRef = useRef(null)
  // state: idle | loading | preparing | signing | submitting | confirming | success | error
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')
  const [lastClaim, setLastClaim] = useState(null)
  const [activeClaimId, setActiveClaimId] = useState(null)
  const [showLinkPanel, setShowLinkPanel] = useState(false)
  // Track retry/cancel operations on ENTITLED claims that got stuck
  // (Phantom signed the tx but the confirm flow didn't complete).
  const [retryingClaimId, setRetryingClaimId] = useState(null)
  const [cancellingClaimId, setCancellingClaimId] = useState(null)
  // The tx signature the user pastes for a manual retry (for when
  // the frontend lost track of the signature after a Phantom sign).
  const [retrySignatureInput, setRetrySignatureInput] = useState('')
  const [retryError, setRetryError] = useState('')

  const profileWalletIsEvm = Boolean(wallet && /^0x[a-fA-F0-9]{40}$/.test(wallet))
  const profileEvmIsLinked = profileWalletIsEvm && Array.isArray(verifiedEvmWallets)
    && verifiedEvmWallets.some((address) => address.toLowerCase() === wallet.toLowerCase())
  const requiresPhantomClaimGuard = profileWalletIsEvm && (!profileEvmIsLinked || !solanaPayoutWallet)
  // Keep the selected unlinked EVM address as the balance query target so
  // its existing points are visible. Once it is verified, use the canonical
  // Solana payout identity for the existing aggregate balance and claim flow.
  const effectiveWallet = profileWalletIsEvm && !profileEvmIsLinked ? wallet : (solanaPayoutWallet || wallet)
  const balanceIdentity = `${String(effectiveWallet || '').toLowerCase()}:${(Array.isArray(verifiedEvmWallets) ? verifiedEvmWallets : []).map((address) => address.toLowerCase()).sort().join(',')}`

  const load = useCallback(async () => {
    if (!effectiveWallet) return
    setState('loading')
    setError('')
    try {
      const bal = await getRewardBalance(effectiveWallet)
      setBalance(bal)
      setLoadedBalanceIdentity(balanceIdentity)
      setState('idle')
    } catch (e) {
      setError(e?.message || 'Unable to load reward balance.')
      setState('error')
    }
  }, [balanceIdentity, effectiveWallet])

  // Wait until linked-wallet resolution finishes so we fetch the canonical
  // reward identity once, rather than fetching once before and once after it.
  useEffect(() => {
    if (verifiedIdentityLoaded) void load()
  }, [verifiedIdentityLoaded, load])

  const isEvmWallet = Boolean(effectiveWallet && /^0x[a-fA-F0-9]{40}$/.test(effectiveWallet))
  const currentBalance = loadedBalanceIdentity === balanceIdentity ? balance : null
  const claimable = Number(currentBalance?.claimable_points || 0)
  const rewardsEnabled = Boolean(currentBalance?.rewards_enabled)
  const hasActiveSeason = Boolean(currentBalance?.has_active_season)
  const network = currentBalance?.network || 'mainnet-beta'  // backend tells us which network
  const showEvmClaimNotice = requiresPhantomClaimGuard && claimable > 0
  const seasonRewards = currentBalance?.season_reward?.season_rewards || []
  const selectedSeasonReward = seasonRewards.find((item) => item.season?.id === selectedSeasonId) || null
  const closeSeasonDetails = () => {
    setSelectedSeasonId(null)
    window.requestAnimationFrame(() => seasonTriggerRef.current?.focus())
  }

  useEffect(() => {
    setSelectedSeasonId(null)
  }, [balanceIdentity])

  useEffect(() => {
    if (!selectedSeasonId || !selectedSeasonReward) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    seasonDialogCloseRef.current?.focus()
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeSeasonDetails()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [selectedSeasonId, selectedSeasonReward])

  const handleClaim = async (seasonRewardRequest = null) => {
    const season = seasonRewardRequest?.season
    if (!effectiveWallet || (!seasonRewardRequest && claimable <= 0) || (seasonRewardRequest && !seasonRewardRequest.allocation?.has_reward) || state !== 'idle') return

    // SECURITY: claims must always go to the verified Solana payout
    // wallet. If the user is viewing a connected MetaMask wallet that
    // is not yet linked to the verified reward identity, do not start
    // a claim or allow an EVM fallback path.
    if (requiresPhantomClaimGuard) {
      setShowLinkPanel(true)
      setError(profileEvmIsLinked
        ? 'Connect Phantom to claim SOL rewards through your verified Solana payout wallet.'
        : 'Connect Phantom, then link this MetaMask wallet to your Solana reward identity before claiming SOL rewards.')
      return
    }

    if (/^0x[a-fA-F0-9]{40}$/.test(effectiveWallet)) {
      setError('Connect a Solana wallet to claim your SOL rewards. EVM wallets cannot be Solana payout recipients.')
      return
    }

    // Confirmation dialog — warn the user they will pay the network fee.
    const hasPhantom = Boolean(getSolanaProvider())
    if (seasonRewardRequest && !hasPhantom) {
      setError('Connect Phantom to claim a finalized season reward.')
      return
    }
    const confirmMsg = hasPhantom
      ? seasonRewardRequest
        ? `Claim your finalized ${season.name} reward?\n\n` +
          `This is a REAL on-chain Solana transaction.\n` +
          `• You will sign the transaction in your wallet.\n` +
          `• You will pay the network fee (~0.000005 SOL).\n` +
          `• The reward SOL will be transferred to your wallet.`
        : `Claim ${claimable.toLocaleString('en-US', { maximumFractionDigits: 2 })} Samurai Points for SOL rewards?\n\n` +
        `This is a REAL on-chain Solana transaction.\n` +
        `• You will sign the transaction in your wallet.\n` +
        `• You will pay the network fee (~0.000005 SOL).\n` +
        `• The reward SOL will be transferred to your wallet.`
      : `Claim ${claimable.toLocaleString('en-US', { maximumFractionDigits: 2 })} Samurai Points for SOL rewards?\n\n` +
        `This will use the backend admin-pays flow (no Phantom wallet detected).\n` +
        `The payout will be signed by the backend admin and sent to your connected wallet.`
    if (!window.confirm(confirmMsg)) return

    // Fallback path: no Phantom → use legacy admin-pays custodial flow.
    if (!hasPhantom && !seasonRewardRequest) {
      setState('preparing')
      setError('')
      try {
        const result = await claimReward(effectiveWallet)
        setLastClaim(result.claim ? { ...result, claim_tx_signature: result.claim_tx_signature, claim: result.claim, message: result.message, payout_succeeded: result.payout_succeeded, previously_failed: result.previously_failed, pending_payout: result.pending_payout, db_status_update_pending: result.db_status_update_pending, already_completed: result.already_completed } : result)
        await load()
        setState('idle')
      } catch (e) {
        setError(e?.message || 'The reward claim was rejected.')
        setState('error')
      }
      return
    }

    // USER-PAYS-FEE FLOW
    const provider = getSolanaProvider()
    let claimId = null
    let claimSignature = null
    let signaturePersisted = false
    let submittedSignature = null
    setError('')

    try {
      // --- STEP 1: prepare ---
      setState('preparing')
      console.info('[RewardClaimPanel] STEP 1: prepareRewardClaim', { wallet: effectiveWallet })
      const prepared = await prepareRewardClaim(effectiveWallet, seasonRewardRequest
        ? { seasonId: season.id }
        : {})
      claimId = prepared.claimId
      setActiveClaimId(claimId)
      console.info('[RewardClaimPanel] STEP 1 done: prepared', {
        claimId,
        hasPartiallySignedTx: Boolean(prepared.partiallySignedTx),
        pointsClaimed: prepared.pointsClaimed,
        rewardAmountLamports: prepared.rewardAmountLamports,
      })

      if (!prepared.partiallySignedTx) {
        throw new Error('The backend did not return a partially-signed transaction.')
      }

      // --- STEP 2: Phantom signs ---
      setState('signing')
      console.info('[RewardClaimPanel] STEP 2: Phantom signTransaction')
      const partialTxBytes = Uint8Array.from(atob(prepared.partiallySignedTx), (c) => c.charCodeAt(0))
      const partialTx = Transaction.from(partialTxBytes)
      let signedTx
      try {
        signedTx = await provider.signTransaction(partialTx)
        console.info('[RewardClaimPanel] STEP 2 done: signed', {
          hasSignature: Boolean(signedTx?.signatures),
          feePayer: signedTx?.feePayer?.toString?.(),
        })
      } catch (signError) {
        // User rejected the Phantom popup — cancel the claim.
        console.warn('[RewardClaimPanel] STEP 2 failed: user rejected', { message: signError?.message })
        if (claimId) {
          try { await cancelRewardClaim(claimId, `USER_REJECTED_SIGNATURE: ${signError?.message || ''}`) }
          catch (cancelErr) { console.warn('Failed to cancel rejected claim:', cancelErr?.message) }
        }
        setActiveClaimId(null)
        setState('idle')
        setError('Signature cancelled. Your points have been restored.')
        return
      }

      // The fee-payer signature is deterministic before broadcast. Persist
      // it first so cancellation and transaction submission serialize in DB.
      const feePayerSignature = signedTx.signatures?.find(
        (entry) => entry.publicKey.toString() === effectiveWallet
      )?.signature
      if (!feePayerSignature) {
        throw new Error('The signed transaction did not contain the claimant wallet signature.')
      }
      const signedBytes = signedTx.serialize()
      claimSignature = bs58.encode(feePayerSignature)
      setLastClaim({
        claim_tx_signature: claimSignature,
        claim: { ...prepared.claim, claim_id: claimId, status: 'PENDING_PAYOUT' },
        pending_confirmation: true,
        message: 'Recording the signed transaction before broadcast.',
      })
      console.info('[RewardClaimPanel] persisting signed transaction before broadcast', { claimId })
      await recordRewardClaimSubmission(claimId, claimSignature, effectiveWallet)
      signaturePersisted = true

      // --- STEP 3: submit the already-persisted transaction ---
      setState('submitting')
      console.info('[RewardClaimPanel] STEP 3: sendSignedSolanaTransaction')
      const signature = await sendSignedSolanaTransaction(signedBytes)
      submittedSignature = signature
      if (signature !== claimSignature) {
        throw new Error('Solana RPC returned a signature that does not match the persisted signed transaction.')
      }
      console.info('[RewardClaimPanel] STEP 3 done: submitted', { signature })

      // --- STEP 4: backend verifies the exact persisted signature ---
      setState('confirming')
      console.info('[RewardClaimPanel] STEP 4: confirmRewardClaim', { claimId, signature })
      const confirmed = await confirmRewardClaim(claimId, signature, effectiveWallet)
      console.info('[RewardClaimPanel] STEP 4 done: confirmed', {
        success: confirmed.success,
        payoutSucceeded: confirmed.payout_succeeded,
      })
      setLastClaim({
        claim_tx_signature: signature,
        claim: confirmed.claim || {
          ...prepared.claim,
          claim_id: claimId,
          status: confirmed.pending || confirmed.db_status_update_pending ? 'PENDING_PAYOUT' : 'COMPLETED',
        },
        message: confirmed.message,
        payout_succeeded: confirmed.pending ? undefined : confirmed.success,
        pending_confirmation: Boolean(confirmed.pending || confirmed.db_status_update_pending),
      })

      // Refresh the balance so the new claimable_points shows.
      await load()
      setActiveClaimId(null)
      setState('idle')
    } catch (e) {
      console.error('[RewardClaimPanel] claim flow FAILED', {
        claimId,
        signaturePersisted,
        transactionSubmitted: Boolean(submittedSignature),
        message: e?.message,
        code: e?.code,
      })
      if (claimSignature) {
        setLastClaim({
          claim_tx_signature: claimSignature,
          claim: { claim_id: claimId, status: 'PENDING_PAYOUT' },
          pending_confirmation: true,
          message: !signaturePersisted
            ? 'Signature recording did not return success, so this transaction was not broadcast. Do not broadcast it manually; refresh and recover the same claim before taking further action.'
            : submittedSignature
              ? 'The signed transaction was submitted, but confirmation failed. Retry confirmation for this same transaction; do not cancel or submit another payout.'
              : 'The signed transaction signature is safely recorded, but broadcast/confirmation did not finish. Retry confirmation for this same signature; do not cancel or submit another payout.',
        })
        setActiveClaimId(null)
        await load()
        setError(!signaturePersisted
          ? `${e?.message || 'The signed transaction could not be recorded.'} The transaction was not broadcast.`
          : `${e?.message || 'The reward claim could not be confirmed.'} The signature remains bound to this claim. Use Retry confirm; do not submit another payout.`)
        setState('idle')
        return
      }
      if (claimId) {
        try { await cancelRewardClaim(claimId, `FRONTEND_ERROR: ${e?.message || 'unknown'}`) }
        catch (cancelErr) { console.warn('Failed to cancel claim after error:', cancelErr?.message) }
      }
      setError(e?.message || 'The reward claim failed.')
      setState('error')
      setActiveClaimId(null)
    }
  }

  // =====================================================================
  // RETRY CONFIRM — for incomplete claims that got stuck
  // =====================================================================
  // When the user signs in Phantom but the frontend's submit/confirm
  // flow doesn't complete (network glitch, RPC timeout, browser
  // refresh), the claim remains recoverable in the DB. Prefer its saved
  // signature; legacy claims without one can use a signature from Phantom.
  // =====================================================================
  const handleRetryConfirm = async (claimId, storedSignature = null) => {
    // Strip whitespace + surrounding quotes from the pasted signature.
    // When users copy a signature from the browser console, it often
    // includes extra quotes: '"2sqFToS1...sNp"' — which the backend
    // rejects as INVALID_SIGNATURE because " is not valid base58.
    const rawSignature = String(storedSignature || retrySignatureInput).trim()
    const signature = rawSignature
      .replace(/^["'`]+/, '')   // strip leading quotes
      .replace(/["'`]+$/, '')   // strip trailing quotes
      .trim()
    if (!signature) {
      setRetryError('Paste the Solana transaction signature from Phantom\'s activity history. Make sure there are no extra quotes around it.')
      return
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
      setRetryError('The signature contains invalid characters. Make sure you copied ONLY the base58 string (no quotes, no spaces). It should be 64-88 characters of letters and numbers.')
      return
    }
    setRetryingClaimId(claimId)
    setRetryError('')
    try {
      console.info('[RewardClaimPanel] retry confirm', { claimId, signature })
      const result = await confirmRewardClaim(claimId, signature, effectiveWallet)
      console.info('[RewardClaimPanel] retry confirm done', { success: result.success, message: result.message })
      setLastClaim({
        claim_tx_signature: signature,
        claim: result.claim || { claim_id: claimId, status: 'PENDING_PAYOUT' },
        message: result.message,
        payout_succeeded: result.pending ? undefined : result.success,
        pending_confirmation: Boolean(result.pending || result.db_status_update_pending),
      })
      setRetrySignatureInput('')
      await load()
    } catch (e) {
      console.error('[RewardClaimPanel] retry confirm failed', { claimId, message: e?.message, code: e?.code })
      setRetryError(e?.message || 'Could not verify the transaction. Make sure the signature is correct and the transaction landed on Solana.')
    } finally {
      setRetryingClaimId(null)
    }
  }

  // =====================================================================
  // CANCEL CLAIM — revert an ENTITLED claim + restore claimed_points
  // =====================================================================
  // If the tx never landed on Solana (user closed Phantom, network
  // failed, etc.), the user can cancel the ENTITLED claim to restore
  // their claimed_points so they can try again.
  // =====================================================================
  const handleCancelClaim = async (claimId) => {
    if (!window.confirm('Cancel this claim? Your claimed points will be restored so you can claim again.')) return
    setCancellingClaimId(claimId)
    setRetryError('')
    try {
      console.info('[RewardClaimPanel] cancel claim', { claimId })
      await cancelRewardClaim(claimId, 'USER_MANUAL_CANCEL_FROM_UI')
      console.info('[RewardClaimPanel] cancel claim done')
      setRetrySignatureInput('')
      await load()
    } catch (e) {
      console.error('[RewardClaimPanel] cancel claim failed', { claimId, message: e?.message })
      setRetryError(e?.message || 'Could not cancel the claim.')
    } finally {
      setCancellingClaimId(null)
    }
  }

  if (state === 'loading' && !currentBalance) {
    return (
      <section className="profile-panel profile-rewards-panel">
        <SectionHeading eyebrow="REWARD ACCOUNTING" title="Your reward balance" />
        <div className="profile-rewards-skeleton" aria-label="Loading reward balance">
          <p>Loading your participated seasons...</p>
          <span /><span /><span />
        </div>
      </section>
    )
  }

  if (state === 'error' && !currentBalance) {
    return (
      <section className="profile-panel profile-rewards-panel">
        <SectionHeading eyebrow="REWARD ACCOUNTING" title="Your reward balance" />
        <div className="profile-rewards-error">
          <Icon name="info" size={20} />
          <p>{error}</p>
          <Button variant="outline" icon="refresh" onClick={load}>Retry</Button>
        </div>
      </section>
    )
  }

  const stateLabel = {
    preparing: 'Preparing claim…',
    signing: 'Sign in your wallet…',
    submitting: 'Submitting transaction…',
    confirming: 'Confirming on Solana…',
  }[state] || 'Claiming…'

  return (
    <section className="profile-panel profile-rewards-panel">
      <SectionHeading
        eyebrow="REWARD ACCOUNTING"
        title="Your reward balance"
        text="Claim your earned Samurai Points for rewards. You pay the network fee when claiming."
      />

      <div className="profile-rewards-status-row">
        <Tag tone={rewardsEnabled ? 'green' : 'neutral'}>{rewardsEnabled ? 'REWARDS ACTIVE' : 'REWARDS OFF'}</Tag>
        <Tag tone={hasActiveSeason ? 'green' : 'neutral'}>{hasActiveSeason ? 'SEASON ACTIVE' : 'NO ACTIVE SEASON'}</Tag>
        {/* Verified-identity awareness tags. The backend determines
            linked wallets from the database; this is just a visual
            indicator. */}
        {currentBalance?.is_verified_identity ? (
          <Tag tone="green">
            {verifiedEvmWallets?.length > 0
              ? `${verifiedEvmWallets.length} EVM WALLET${verifiedEvmWallets.length === 1 ? '' : 'S'} LINKED`
              : 'SOLANA-ONLY'}
          </Tag>
        ) : (
          <Tag tone="neutral">UNVERIFIED IDENTITY</Tag>
        )}
      </div>

      {/* Verified-identity UX states ---------------------------------- */}
      {/* Case 1: EVM wallet connected as the requested payout wallet,
          but no verified Solana link. The user must connect a Solana
          wallet to receive SOL. */}
      {showEvmClaimNotice && (
        <div className="profile-rewards-notice profile-rewards-notice-warn">
          <Icon name="info" size={16} />
          <div>
            <strong>{profileEvmIsLinked ? 'CONNECT PHANTOM TO CLAIM' : 'SWITCH TO PHANTOM TO CLAIM'}</strong>
            <small>{profileEvmIsLinked
              ? 'This MetaMask wallet is already linked. Connect its Solana reward wallet to claim the existing aggregated SOL balance.'
              : 'You earned these Samurai Points through this MetaMask wallet. SOL rewards are paid through your Solana reward wallet. Switch to Phantom and link this MetaMask wallet to your Solana reward identity. Once linked, its eligible points can be included in your SOL reward balance.'}</small>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {!profileEvmIsLinked && <Button variant="outline" icon="link" onClick={() => setShowLinkPanel(true)}>Link this MetaMask wallet</Button>}
          </div>
        </div>
      )}

      {/* Case 2: Solana wallet connected but no EVM wallets linked yet.
          Remind the user that points on other chains may exist. */}
      {effectiveWallet && !/^0x[a-fA-F0-9]{40}$/.test(effectiveWallet)
        && verifiedIdentityLoaded
        && (!verifiedEvmWallets || verifiedEvmWallets.length === 0) && (
        <div className="profile-rewards-notice">
          <Icon name="info" size={16} />
          <div>
            <strong>Some Samurai Points may exist on other wallets.</strong>
            <small>Link your EVM wallet to include those points in your reward balance.</small>
          </div>
          <Button variant="outline" icon="link" onClick={() => setShowLinkPanel((v) => !v)}>
            {showLinkPanel ? 'Hide link panel' : 'Link EVM wallet'}
          </Button>
        </div>
      )}

      {/* Case 3: Solana wallet + at least one verified EVM linked.
          Show the unified-identity banner. */}
      {effectiveWallet && !/^0x[a-fA-F0-9]{40}$/.test(effectiveWallet)
        && verifiedEvmWallets?.length > 0 && (
        <div className="profile-rewards-notice profile-rewards-notice-verified">
          <Icon name="check" size={16} />
          <div>
            <strong>Unified reward identity</strong>
            <small>
              {verifiedEvmWallets.length} EVM wallet{verifiedEvmWallets.length === 1 ? '' : 's'} linked — points from Solana + Ethereum + Robinhood Chain are aggregated.
            </small>
          </div>
          <Button variant="outline" icon="link" onClick={() => setShowLinkPanel((v) => !v)}>
            {showLinkPanel ? 'Hide link panel' : 'Manage links'}
          </Button>
        </div>
      )}

      {/* Inline wallet-link panel (toggled by the CTAs above) */}
      {showLinkPanel && (
        <WalletLinkPanel expectedEvmWallet={profileWalletIsEvm ? wallet : expectedEvmWallet} onLinkedChange={() => { refreshLinkedWallets(); setShowLinkPanel(false) }} />
      )}
      {/* End verified-identity UX states ------------------------------ */}

      <div className="profile-rewards-grid">
        <div className="profile-rewards-stat">
          <span className="profile-data-label">EARNED POINTS</span>
          <strong>{Number(currentBalance?.earned_points || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>
          <small>Lifetime verified swap points</small>
        </div>
        <div className="profile-rewards-stat">
          <span className="profile-data-label">CLAIMED POINTS</span>
          <strong>{Number(currentBalance?.claimed_points || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>
          <small>Already redeemed for rewards</small>
        </div>
        <div className="profile-rewards-stat profile-rewards-stat-highlight">
          <span className="profile-data-label">CLAIMABLE POINTS</span>
          <strong>{claimable.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>
          {/* SOL amount hidden per user request — keeping the claimable points number visible */}
        </div>
      </div>

      <div className="profile-rewards-action-row">
        <Button
          variant="primary"
          icon="gift"
          onClick={showEvmClaimNotice ? () => { setShowLinkPanel(true); setError('Connect Phantom, then link this MetaMask wallet to your Solana reward identity. After linking, claimable SOL rewards will be paid to your Solana wallet.') } : () => handleClaim()}
          disabled={showEvmClaimNotice ? false : claimable <= 0 || !rewardsEnabled || !hasActiveSeason || state !== 'idle'}
        >
          {showEvmClaimNotice ? 'Switch to Phantom to claim' : (state !== 'idle' ? stateLabel : hasActiveSeason ? 'Claim all claimable points' : 'No active season')}
        </Button>
        <Button variant="outline" icon="refresh" onClick={load} disabled={state === 'loading' || state !== 'idle'}>Refresh</Button>
      </div>
      {!hasActiveSeason && claimable > 0 && (
        <p className="profile-rewards-fee-note">
          General points claims require an active season. Claim finalized season rewards from that season&apos;s reward card below.
        </p>
      )}

      <section className="profile-participated-seasons">
        <SectionHeading
          eyebrow="YOUR REWARD ACTIVITY"
          title="Your Participated Seasons & Campaigns"
          text="A personal record of seasons where your verified reward identity earned eligible Samurai Points."
        />
        {seasonRewards.length === 0 ? (
          <div className="profile-season-empty">
            You haven&apos;t participated in any reward season or campaign yet.
          </div>
        ) : (
          <div className="profile-season-reward-list">
            {seasonRewards.map((seasonReward) => {
          const season = seasonReward.season
          const participation = seasonReward.participation || {}
          const campaigns = Array.isArray(participation.campaigns) ? participation.campaigns : []
          return (
            <button
              key={season.id}
              type="button"
              className="profile-season-reward-card"
              aria-haspopup="dialog"
              aria-label={`View details for ${season.name}`}
              onClick={(event) => {
                seasonTriggerRef.current = event.currentTarget
                setSelectedSeasonId(season.id)
              }}
            >
              <span className="profile-season-reward-mark" aria-hidden="true">🌸</span>
              <span className="profile-season-reward-copy">
                <strong>Season — {season.name}</strong>
                <small>{campaigns.length > 0
                  ? `Campaign${campaigns.length === 1 ? '' : 's'}: ${campaigns.map((campaign) => campaign.name || campaign.id).join(', ')}`
                  : 'Season participation recorded'}</small>
              </span>
              <span className="profile-season-reward-participated"><Icon name="check" size={13} /> PARTICIPATED</span>
              <span className="profile-season-view-details">View details <Icon name="arrowRight" size={14} /></span>
            </button>
            )
          })}
          </div>
        )}
      </section>

      {selectedSeasonReward && (
        <SeasonRewardDialog
          seasonReward={selectedSeasonReward}
          network={network}
          claimDisabled={!rewardsEnabled || state !== 'idle'}
          onClaim={() => handleClaim(selectedSeasonReward)}
          onClose={closeSeasonDetails}
          closeButtonRef={seasonDialogCloseRef}
        />
      )}

      <p className="profile-rewards-fee-note">
        <Icon name="info" size={12} /> You pay the network fee when claiming. Make sure your wallet has enough for gas.
      </p>

      {error && <div className="profile-rewards-error-text"><Icon name="info" size={14} /> {error}</div>}

      {lastClaim && (
        <div className={`profile-rewards-success ${lastClaim.payout_succeeded === false || lastClaim.pending_confirmation ? 'profile-rewards-success-warn' : ''}`}>
          <Icon name={lastClaim.payout_succeeded === false || lastClaim.pending_confirmation ? 'info' : 'check'} size={16} />
          <div>
            {lastClaim.pending_confirmation ? (
              <strong>Awaiting confirmation</strong>
            ) : lastClaim.payout_succeeded === false ? (
              <strong>Payout failed</strong>
            ) : (
              <strong>Claim paid!</strong>
            )}
            <small>
              {Number(lastClaim.claim?.points_claimed || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} points claimed ({lastClaim.claim?.status || 'COMPLETED'})
            </small>
            {lastClaim.claim_tx_signature && (
              <small className="profile-rewards-tx-sig">
                Solana tx:{' '}
                <a href={solanaTxExplorerUrl(lastClaim.claim_tx_signature, network)} target="_blank" rel="noreferrer">
                  {lastClaim.claim_tx_signature.slice(0, 8)}…{lastClaim.claim_tx_signature.slice(-6)}
                </a>
              </small>
            )}
            {lastClaim.claim?.claim_id && (
              <small className="profile-rewards-claim-id">Claim ID: <code>{lastClaim.claim.claim_id}</code></small>
            )}
            {lastClaim.message && <small className="profile-rewards-message">{lastClaim.message}</small>}
          </div>
        </div>
      )}

      {Array.isArray(currentBalance?.recent_claims) && currentBalance.recent_claims.length > 0 && (
        <div className="profile-rewards-history">
          <span className="profile-data-label">RECENT CLAIMS</span>
          <ul className="profile-reclaims-list">
            {currentBalance.recent_claims.slice(0, 5).map((claim) => (
              <li key={claim.claim_id} className={claim.status === 'ENTITLED' ? 'profile-reclaim-entitled' : ''}>
                <div>
                  <strong>{Number(claim.points_claimed).toLocaleString('en-US', { maximumFractionDigits: 2 })} SP</strong>
                  {claim.status === 'COMPLETED' && claim.reward_amount != null && (
                    <span>→ {formatRewardAmount(claim.reward_amount, claim.reward_asset)}</span>
                  )}
                  {claim.status === 'COMPLETED' && claim.claim_tx_signature && (
                    <a className="profile-rewards-tx-link" href={solanaTxExplorerUrl(claim.claim_tx_signature, network)} target="_blank" rel="noreferrer">
                      tx ↗
                    </a>
                  )}
                </div>
                <div className="profile-rewards-claim-meta">
                  <Tag tone={claim.status === 'COMPLETED' ? 'green' : claim.status === 'FAILED' ? 'red' : 'neutral'}>
                    {claim.status}
                  </Tag>
                  <small>{new Date(claim.claimed_at || claim.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</small>
                </div>
                {/* Recover signed claims from the durable DB signature after reload. */}
                {['ENTITLED', 'PENDING_PAYOUT'].includes(claim.status) && (
                  <div className="profile-reclaim-actions">
                    {!claim.claim_tx_signature && (
                      <input
                        type="text"
                        className="profile-reclaim-sig-input"
                        placeholder="Paste tx signature from Phantom activity history"
                        value={retryingClaimId === claim.claim_id ? retrySignatureInput : ''}
                        onChange={(e) => setRetrySignatureInput(e.target.value)}
                        disabled={retryingClaimId === claim.claim_id || cancellingClaimId === claim.claim_id}
                      />
                    )}
                    <Button
                      variant="primary"
                      icon="refresh"
                      disabled={retryingClaimId === claim.claim_id || cancellingClaimId === claim.claim_id}
                      onClick={() => handleRetryConfirm(claim.claim_id, claim.claim_tx_signature)}
                    >
                      {retryingClaimId === claim.claim_id ? 'Verifying…' : 'Retry confirm'}
                    </Button>
                    {claim.status === 'ENTITLED' && !claim.claim_tx_signature && (
                      <Button
                        variant="outline"
                        icon="close"
                        disabled={retryingClaimId === claim.claim_id
                          || cancellingClaimId === claim.claim_id
                          || (lastClaim?.pending_confirmation
                            && lastClaim.claim_tx_signature
                            && lastClaim.claim?.claim_id === claim.claim_id)}
                        onClick={() => handleCancelClaim(claim.claim_id)}
                      >
                        {cancellingClaimId === claim.claim_id
                          ? 'Cancelling…'
                          : lastClaim?.pending_confirmation
                            && lastClaim.claim_tx_signature
                            && lastClaim.claim?.claim_id === claim.claim_id
                            ? 'Signature recorded'
                            : 'Cancel claim'}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {retryError && (
            <p className="profile-reclaim-error-text">
              <Icon name="info" size={14} /> {retryError}
            </p>
          )}
          {currentBalance.recent_claims.some((c) => ['ENTITLED', 'PENDING_PAYOUT'].includes(c.status)) && (
            <p className="profile-reclaim-help-text">
              <Icon name="info" size={12} /> Claims awaiting payout remain recoverable. Retry confirmation to verify the saved transaction signature; claims with a saved signature cannot be cancelled because the transaction may have paid on-chain.
            </p>
          )}
        </div>
      )}

      {!rewardsEnabled && (
        <p className="profile-rewards-muted-note">
          Rewards are currently disabled by the admin. Your earned points and claim history remain safe.
        </p>
      )}
      {rewardsEnabled && !hasActiveSeason && (
        <p className="profile-rewards-muted-note">
          There is no active reward season right now. New points cannot be earned until a season is active,
          but your existing claimable points can still be claimed.
        </p>
      )}
    </section>
  )
}
