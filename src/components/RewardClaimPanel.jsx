import { useCallback, useEffect, useState } from 'react'
import { Button, SectionHeading, Tag } from '../components/Layout'
import Icon from '../components/Icon'
import { getSolanaProvider, useWallet } from '../context/WalletContext'
import { confirmRewardClaim, cancelRewardClaim, claimReward, formatRewardAmount, getRewardBalance, prepareRewardClaim, solanaTxExplorerUrl } from '../services/rewardsService'
import WalletLinkPanel from './WalletLinkPanel'
import { sendSignedSolanaTransaction, confirmSolanaTransaction } from '../services/roninService'
import { Transaction } from '@solana/web3.js'

// RewardClaimPanel — shows the user's earned / claimed / claimable Samurai
// points balance and lets them claim available rewards.
//
// USER-PAYS-FEE FLOW (default):
//   1. prepareRewardClaim() → backend creates ENTITLED row + returns
//      partially-signed tx (admin signs instruction, user is fee payer)
//   2. Phantom signs the tx (user adds fee-payer signature)
//   3. Frontend submits the tx to Solana via sendSignedSolanaTransaction
//   4. confirmRewardClaim(claimId, signature) → backend verifies tx landed
//      + marks COMPLETED
//
// If the user rejects the Phantom popup:
//   cancelRewardClaim(claimId) → backend reverts ENTITLED row + restores points
//
// FALLBACK (admin-pays-fee): if a Phantom provider is not detected (e.g.
// mobile browser without Phantom, or admin testing), the panel falls back
// to the legacy /api/rewards/claim endpoint which uses the admin wallet
// as the fee payer.
export default function RewardClaimPanel({ wallet }) {
  const { solanaPayoutWallet, verifiedEvmWallets, verifiedIdentityLoaded, refreshLinkedWallets } = useWallet()
  const [balance, setBalance] = useState(null)
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

  // The wallet passed in by Profile.jsx may be either:
  //   * the Phantom Solana address (preferred — that's the payout wallet)
  //   * an EVM address (legacy behavior when no Phantom connected)
  // Prefer solanaPayoutWallet if it's been loaded from the backend
  // (so claims always go to the verified Solana payout wallet).
  const effectiveWallet = solanaPayoutWallet || wallet

  const load = useCallback(async () => {
    if (!effectiveWallet) return
    setState('loading')
    setError('')
    try {
      const bal = await getRewardBalance(effectiveWallet)
      setBalance(bal)
      setState('idle')
    } catch (e) {
      setError(e?.message || 'Unable to load reward balance.')
      setState('error')
    }
  }, [effectiveWallet])

  useEffect(() => { load() }, [load])

  // Reload balance when the verified identity changes (e.g. after
  // linking a new EVM wallet — the backend now aggregates more points).
  useEffect(() => {
    if (verifiedIdentityLoaded) load()
  }, [verifiedIdentityLoaded, verifiedEvmWallets?.length, load])

  const claimable = Number(balance?.claimable_points || 0)
  const rewardsEnabled = Boolean(balance?.rewards_enabled)
  const hasActiveSeason = Boolean(balance?.has_active_season)
  const rewardAsset = balance?.reward_asset || 'SOL'
  const rate = Number(balance?.reward_points_per_unit || 1000)
  const network = balance?.network || 'mainnet-beta'  // backend tells us which network
  const estimatedReward = claimable > 0 && rate > 0 ? claimable / rate : 0

  const handleClaim = async () => {
    if (!effectiveWallet || claimable <= 0 || state !== 'idle') return

    // SECURITY: claims must always go to the verified Solana payout
    // wallet. If effectiveWallet is an EVM address (legacy fallback
    // when no Phantom connected), reject — the backend would reject
    // it anyway (claim_reward raises EVM_CLAIM_NOT_ALLOWED), but we
    // surface a clearer message here.
    if (/^0x[a-fA-F0-9]{40}$/.test(effectiveWallet)) {
      setError('Connect a Solana wallet to claim your SOL rewards. EVM wallets cannot be Solana payout recipients.')
      setState('error')
      return
    }

    // Confirmation dialog — warn the user they will pay the network fee.
    const hasPhantom = Boolean(getSolanaProvider())
    const confirmMsg = hasPhantom
      ? `Claim ${claimable.toLocaleString('en-US', { maximumFractionDigits: 2 })} Samurai Points for ${formatRewardAmount(estimatedReward, rewardAsset)}?\n\n` +
        `This is a REAL on-chain Solana transaction.\n` +
        `• You will sign the transaction in your wallet.\n` +
        `• You will pay the network fee (~0.000005 SOL).\n` +
        `• The reward SOL will be transferred to your wallet.`
      : `Claim ${claimable.toLocaleString('en-US', { maximumFractionDigits: 2 })} Samurai Points for ${formatRewardAmount(estimatedReward, rewardAsset)}?\n\n` +
        `This will use the backend admin-pays flow (no Phantom wallet detected).\n` +
        `The payout will be signed by the backend admin and sent to your connected wallet.`
    if (!window.confirm(confirmMsg)) return

    // Fallback path: no Phantom → use legacy admin-pays custodial flow.
    if (!hasPhantom) {
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
    setError('')

    try {
      // --- STEP 1: prepare ---
      setState('preparing')
      console.info('[RewardClaimPanel] STEP 1: prepareRewardClaim', { wallet: effectiveWallet })
      const prepared = await prepareRewardClaim(effectiveWallet)
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

      // --- STEP 3: submit to Solana ---
      setState('submitting')
      console.info('[RewardClaimPanel] STEP 3: sendSignedSolanaTransaction')
      const signedBytes = signedTx.serialize()
      let signature
      try {
        signature = await sendSignedSolanaTransaction(signedBytes)
        console.info('[RewardClaimPanel] STEP 3 done: submitted', { signature })
      } catch (submitError) {
        // The tx was signed but NOT submitted to Solana. The claim
        // stays ENTITLED — the user can retry with the signature
        // once they find it in Phantom's activity history.
        console.error('[RewardClaimPanel] STEP 3 FAILED: tx not submitted', {
          claimId,
          message: submitError?.message,
        })
        setError(`Transaction was signed but could not be submitted to Solana: ${submitError?.message || 'unknown error'}. Your claim is ENTITLED — find the tx signature in Phantom's activity history and use "Retry confirm" below.`)
        setActiveClaimId(null)
        setState('idle')
        await load()
        return
      }

      // --- STEP 4: wait for confirmation (frontend polls) ---
      setState('confirming')
      console.info('[RewardClaimPanel] STEP 4: confirmSolanaTransaction (polling)', { signature })
      try {
        await confirmSolanaTransaction(signature, 90_000)
        console.info('[RewardClaimPanel] STEP 4 done: confirmed on-chain')
      } catch (confirmError) {
        // The tx may still land — leave the claim ENTITLED and let the
        // user retry /claim-confirm later.
        console.warn('[RewardClaimPanel] STEP 4 timed out — backend will reconcile', {
          signature,
          message: confirmError?.message,
        })
        setLastClaim({
          claim_tx_signature: signature,
          claim: prepared.claim,
          pending_confirmation: true,
          message: 'Transaction submitted but confirmation timed out. Click "Retry confirm" below to verify it now, or wait for the backend to reconcile.',
        })
        // Best-effort: call /claim-confirm in the background.
        try {
          await confirmRewardClaim(claimId, signature, effectiveWallet)
          console.info('[RewardClaimPanel] background /claim-confirm succeeded')
        } catch (confirmRetryErr) {
          console.warn('[RewardClaimPanel] background /claim-confirm failed (will need manual retry)', {
            message: confirmRetryErr?.message,
            claimId,
            signature,
          })
        }
        await load()
        setActiveClaimId(null)
        setState('idle')
        return
      }

      // --- STEP 5: backend verifies + marks COMPLETED ---
      console.info('[RewardClaimPanel] STEP 5: confirmRewardClaim (backend verify)', { claimId, signature })
      const confirmed = await confirmRewardClaim(claimId, signature, effectiveWallet)
      console.info('[RewardClaimPanel] STEP 5 done: confirmed', {
        success: confirmed.success,
        payoutSucceeded: confirmed.payout_succeeded,
      })
      setLastClaim({
        claim_tx_signature: signature,
        claim: confirmed.claim || prepared.claim,
        message: confirmed.message,
        payout_succeeded: confirmed.success,
      })

      // Refresh the balance so the new claimable_points shows.
      await load()
      setActiveClaimId(null)
      setState('idle')
    } catch (e) {
      console.error('[RewardClaimPanel] claim flow FAILED', {
        claimId,
        message: e?.message,
        code: e?.code,
      })
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
  // RETRY CONFIRM — for ENTITLED claims that got stuck
  // =====================================================================
  // When the user signs in Phantom but the frontend's submit/confirm
  // flow doesn't complete (network glitch, RPC timeout, browser
  // refresh), the claim stays ENTITLED in the DB. The user can:
  //   1. Find the tx signature in Phantom's activity history
  //   2. Paste it here
  //   3. Click "Retry confirm" — calls /api/rewards/claim-confirm
  //      which verifies the tx landed on Solana + marks the claim
  //      COMPLETED
  // =====================================================================
  const handleRetryConfirm = async (claimId) => {
    // Strip whitespace + surrounding quotes from the pasted signature.
    // When users copy a signature from the browser console, it often
    // includes extra quotes: '"2sqFToS1...sNp"' — which the backend
    // rejects as INVALID_SIGNATURE because " is not valid base58.
    const rawSignature = retrySignatureInput.trim()
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
        claim: result.claim,
        message: result.message,
        payout_succeeded: result.success,
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

  if (state === 'loading' && !balance) {
    return (
      <section className="profile-panel profile-rewards-panel">
        <SectionHeading eyebrow="REWARD ACCOUNTING" title="Your reward balance" />
        <div className="profile-rewards-skeleton" aria-label="Loading reward balance">
          <span /><span /><span />
        </div>
      </section>
    )
  }

  if (state === 'error' && !balance) {
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
        text={`Earned points convert to ${rewardAsset} at ${rate.toLocaleString('en-US')} points per ${rewardAsset}. You pay the network fee when claiming.`}
      />

      <div className="profile-rewards-status-row">
        <Tag tone={rewardsEnabled ? 'green' : 'neutral'}>{rewardsEnabled ? 'REWARDS ACTIVE' : 'REWARDS OFF'}</Tag>
        <Tag tone={hasActiveSeason ? 'green' : 'neutral'}>{hasActiveSeason ? 'SEASON ACTIVE' : 'NO ACTIVE SEASON'}</Tag>
        {/* Verified-identity awareness tags. The backend determines
            linked wallets from the database; this is just a visual
            indicator. */}
        {balance?.is_verified_identity ? (
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
      {effectiveWallet && /^0x[a-fA-F0-9]{40}$/.test(effectiveWallet) && (
        <div className="profile-rewards-notice profile-rewards-notice-warn">
          <Icon name="info" size={16} />
          <div>
            <strong>You have Samurai Points from an EVM wallet.</strong>
            <small>Connect a Solana wallet (Phantom) and link it to this EVM wallet to receive SOL rewards. EVM addresses cannot be Solana payout recipients.</small>
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
        <WalletLinkPanel onLinkedChange={() => { refreshLinkedWallets(); setShowLinkPanel(false) }} />
      )}
      {/* End verified-identity UX states ------------------------------ */}

      <div className="profile-rewards-grid">
        <div className="profile-rewards-stat">
          <span className="profile-data-label">EARNED POINTS</span>
          <strong>{Number(balance?.earned_points || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>
          <small>Lifetime verified swap points</small>
        </div>
        <div className="profile-rewards-stat">
          <span className="profile-data-label">CLAIMED POINTS</span>
          <strong>{Number(balance?.claimed_points || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>
          <small>Already redeemed for rewards</small>
        </div>
        <div className="profile-rewards-stat profile-rewards-stat-highlight">
          <span className="profile-data-label">CLAIMABLE POINTS</span>
          <strong>{claimable.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong>
          <small>≈ {formatRewardAmount(estimatedReward, rewardAsset)}</small>
        </div>
      </div>

      <div className="profile-rewards-action-row">
        <Button
          variant="primary"
          icon="gift"
          onClick={handleClaim}
          disabled={claimable <= 0 || !rewardsEnabled || state !== 'idle'}
        >
          {state !== 'idle' ? stateLabel : `Claim all claimable points`}
        </Button>
        <Button variant="outline" icon="refresh" onClick={load} disabled={state === 'loading' || state !== 'idle'}>Refresh</Button>
      </div>

      <p className="profile-rewards-fee-note">
        <Icon name="info" size={12} /> You pay the Solana network fee (~0.000005 SOL). Make sure your wallet has enough SOL for gas.
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
              {Number(lastClaim.claim?.points_claimed || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} points →{' '}
              {formatRewardAmount(lastClaim.claim?.reward_amount, lastClaim.claim?.reward_asset)} ({lastClaim.claim?.status || 'COMPLETED'})
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

      {Array.isArray(balance?.recent_claims) && balance.recent_claims.length > 0 && (
        <div className="profile-rewards-history">
          <span className="profile-data-label">RECENT CLAIMS</span>
          <ul className="profile-reclaims-list">
            {balance.recent_claims.slice(0, 5).map((claim) => (
              <li key={claim.claim_id} className={claim.status === 'ENTITLED' ? 'profile-reclaim-entitled' : ''}>
                <div>
                  <strong>{Number(claim.points_claimed).toLocaleString('en-US', { maximumFractionDigits: 2 })} SP</strong>
                  <span>→ {formatRewardAmount(claim.reward_amount, claim.reward_asset)}</span>
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
                {/* Retry/Cancel actions for ENTITLED claims that got stuck */}
                {claim.status === 'ENTITLED' && (
                  <div className="profile-reclaim-actions">
                    <input
                      type="text"
                      className="profile-reclaim-sig-input"
                      placeholder="Paste tx signature from Phantom activity history"
                      value={retryingClaimId === claim.claim_id ? retrySignatureInput : ''}
                      onChange={(e) => setRetrySignatureInput(e.target.value)}
                      disabled={retryingClaimId === claim.claim_id || cancellingClaimId === claim.claim_id}
                    />
                    <Button
                      variant="primary"
                      icon="refresh"
                      disabled={retryingClaimId === claim.claim_id || cancellingClaimId === claim.claim_id}
                      onClick={() => handleRetryConfirm(claim.claim_id)}
                    >
                      {retryingClaimId === claim.claim_id ? 'Verifying…' : 'Retry confirm'}
                    </Button>
                    <Button
                      variant="outline"
                      icon="close"
                      disabled={retryingClaimId === claim.claim_id || cancellingClaimId === claim.claim_id}
                      onClick={() => handleCancelClaim(claim.claim_id)}
                    >
                      {cancellingClaimId === claim.claim_id ? 'Cancelling…' : 'Cancel claim'}
                    </Button>
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
          {balance.recent_claims.some((c) => c.status === 'ENTITLED') && (
            <p className="profile-reclaim-help-text">
              <Icon name="info" size={12} /> ENTITLED means the claim was created but not yet completed. If you signed in Phantom but nothing happened, find the transaction in Phantom's activity history, paste the signature above, and click "Retry confirm". If the transaction never landed, click "Cancel claim" to restore your points.
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

