import { useCallback, useEffect, useState } from 'react'
import { Button, SectionHeading, Tag } from '../components/Layout'
import Icon from '../components/Icon'
import { claimReward, formatRewardAmount, getRewardBalance } from '../services/rewardsService'

// RewardClaimPanel — shows the user's earned / claimed / claimable Samurai
// points balance and lets them claim available rewards. The claim is
// recorded by the backend (service_role) calling the public.claim_reward
// Postgres RPC. This panel never sends earned_points or reward_amount to
// the backend — those values are derived server-side.
//
// Status flow:
//   ENTITLED       → claim recorded, awaiting future on-chain payout
//   PENDING_PAYOUT → backend has signed authorization for the Solana program
//   COMPLETED      → on-chain payout confirmed
//   FAILED         → on-chain payout failed (points remain claimed; admin resolves)
//   CANCELLED      → admin voided the claim
export default function RewardClaimPanel({ wallet }) {
  const [balance, setBalance] = useState(null)
  const [state, setState] = useState('idle') // idle | loading | claiming | error
  const [error, setError] = useState('')
  const [lastClaim, setLastClaim] = useState(null)

  const load = useCallback(async () => {
    if (!wallet) return
    setState('loading')
    setError('')
    try {
      const bal = await getRewardBalance(wallet)
      setBalance(bal)
      setState('idle')
    } catch (e) {
      setError(e?.message || 'Unable to load reward balance.')
      setState('error')
    }
  }, [wallet])

  useEffect(() => { load() }, [load])

  const claimable = Number(balance?.claimable_points || 0)
  const rewardsEnabled = Boolean(balance?.rewards_enabled)
  const hasActiveSeason = Boolean(balance?.has_active_season)
  const rewardAsset = balance?.reward_asset || 'SOL'
  const rate = Number(balance?.reward_points_per_unit || 1000)
  const estimatedReward = claimable > 0 && rate > 0 ? claimable / rate : 0

  const handleClaim = async () => {
    if (!wallet || claimable <= 0 || state === 'claiming') return
    setState('claiming')
    setError('')
    try {
      const result = await claimReward(wallet) // claim all available
      setLastClaim(result.claim)
      // Refresh the balance so the new claimable_points shows.
      await load()
    } catch (e) {
      setError(e?.message || 'The reward claim was rejected.')
      setState('error')
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

  return (
    <section className="profile-panel profile-rewards-panel">
      <SectionHeading
        eyebrow="REWARD ACCOUNTING"
        title="Your reward balance"
        text={`Earned points convert to ${rewardAsset} at ${rate.toLocaleString('en-US')} points per ${rewardAsset}.`}
      />

      <div className="profile-rewards-status-row">
        <Tag tone={rewardsEnabled ? 'green' : 'neutral'}>{rewardsEnabled ? 'REWARDS ACTIVE' : 'REWARDS OFF'}</Tag>
        <Tag tone={hasActiveSeason ? 'green' : 'neutral'}>{hasActiveSeason ? 'SEASON ACTIVE' : 'NO ACTIVE SEASON'}</Tag>
      </div>

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
          disabled={claimable <= 0 || !rewardsEnabled || state === 'claiming'}
        >
          {state === 'claiming' ? 'Claiming…' : `Claim all claimable points`}
        </Button>
        <Button variant="outline" icon="refresh" onClick={load} disabled={state === 'loading'}>Refresh</Button>
      </div>

      {error && <div className="profile-rewards-error-text"><Icon name="info" size={14} /> {error}</div>}

      {lastClaim && (
        <div className="profile-rewards-success">
          <Icon name="check" size={16} />
          <div>
            <strong>Claim recorded!</strong>
            <small>
              {Number(lastClaim.points_claimed).toLocaleString('en-US', { maximumFractionDigits: 2 })} points →{' '}
              {formatRewardAmount(lastClaim.reward_amount, lastClaim.reward_asset)} ({lastClaim.status})
            </small>
            <small className="profile-rewards-claim-id">Claim ID: <code>{lastClaim.claim_id}</code></small>
          </div>
        </div>
      )}

      {Array.isArray(balance?.recent_claims) && balance.recent_claims.length > 0 && (
        <div className="profile-rewards-history">
          <span className="profile-data-label">RECENT CLAIMS</span>
          <ul className="profile-reclaims-list">
            {balance.recent_claims.slice(0, 5).map((claim) => (
              <li key={claim.claim_id}>
                <div>
                  <strong>{Number(claim.points_claimed).toLocaleString('en-US', { maximumFractionDigits: 2 })} SP</strong>
                  <span>→ {formatRewardAmount(claim.reward_amount, claim.reward_asset)}</span>
                </div>
                <div className="profile-rewards-claim-meta">
                  <Tag tone={claim.status === 'COMPLETED' ? 'green' : claim.status === 'FAILED' ? 'red' : 'neutral'}>
                    {claim.status}
                  </Tag>
                  <small>{new Date(claim.claimed_at || claim.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</small>
                </div>
              </li>
            ))}
          </ul>
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
