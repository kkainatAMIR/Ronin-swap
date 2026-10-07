import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatNumber } from '../data'
import { getCampaignOverview } from '../services/campaignService'
import { Button, SectionHeading, Tag } from './Layout'
import Icon from './Icon'

const chainNames = { 101: 'Solana', 1: 'Ethereum', 4663: 'Robinhood Chain' }

function dateTime(value) {
  if (!value) return 'Not specified'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Not specified'
    : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function durationLabel(startAt, endAt) {
  if (!startAt || !endAt) return 'Open-ended duration'
  const durationMs = Date.parse(endAt) - Date.parse(startAt)
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 'Duration unavailable'
  const hours = Math.ceil(durationMs / (60 * 60 * 1000))
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.ceil(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

function routeDescription(campaign) {
  const source = String(campaign.source || '').toUpperCase()
  const direction = String(campaign.direction || 'any').toLowerCase()
  const tokenLabel = (field, metadataField) => campaign[metadataField]?.symbol
    || campaign[field]
    || 'any token'

  if (source === 'RONIN_BUY') {
    return `Buy RONIN with ${tokenLabel('inputMint', 'inputTokenMetadata')}`
  }
  if (source === 'RONIN_SELL') {
    return `Sell RONIN for ${tokenLabel('outputMint', 'outputTokenMetadata')}`
  }
  if (campaign.inputMint || campaign.outputMint) {
    return `${tokenLabel('inputMint', 'inputTokenMetadata')} → ${tokenLabel('outputMint', 'outputTokenMetadata')}`
  }
  if (direction === 'buy') return `Buy ${tokenLabel('outputMint', 'outputTokenMetadata')}`
  if (direction === 'sell') return `Sell ${tokenLabel('inputMint', 'inputTokenMetadata')}`
  return source === 'SWAP' ? 'Eligible swaps' : 'All eligible swap routes'
}

function CampaignCard({ campaign, onSelect }) {
  return (
    <button
      type="button"
      className="profile-campaign-card"
      onClick={(event) => onSelect(campaign, event.currentTarget)}
      aria-haspopup="dialog"
      aria-label={`View ${campaign.name || campaign.id} campaign details`}
    >
      <span className="profile-campaign-summary">
        <span className="profile-campaign-summary-copy">
          <Tag tone={campaign.status === 'ACTIVE' ? 'green' : 'neutral'}>{campaign.status}</Tag>
          <strong>{campaign.name || campaign.id}</strong>
          <small>{durationLabel(campaign.startAt, campaign.endAt)} · {formatNumber(Number(campaign.participantCount || 0))} participants</small>
        </span>
        <span className="profile-campaign-summary-reward">
          <span className="profile-data-label">MULTIPLIER</span>
          <strong>×{formatNumber(campaign.multiplier)}</strong>
          <span className="profile-campaign-view">View campaign <Icon name="arrowRight" size={14} /></span>
        </span>
      </span>
    </button>
  )
}

function CampaignDetailsDialog({ campaign, closeButtonRef, onClose }) {
  if (!campaign) return null
  const chainId = Number(campaign.chainId)
  const chain = chainNames[chainId] || (campaign.chainId ? `Chain ${campaign.chainId}` : 'All chains')

  return createPortal((
    <div className="modal-backdrop profile-campaign-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="modal profile-campaign-dialog" role="dialog" aria-modal="true" aria-labelledby="campaign-dialog-title">
        <button ref={closeButtonRef} className="modal-close" onClick={onClose} aria-label="Close campaign details">
          <Icon name="close" size={16} />
        </button>
        <div className="modal-kicker"><span className="status-dot" /> RONIN CAMPAIGNS / {campaign.id}</div>
        <div className="profile-campaign-dialog-heading">
          <div>
            <Tag tone={campaign.status === 'ACTIVE' ? 'green' : 'neutral'}>{campaign.status}</Tag>
            <h2 id="campaign-dialog-title">{campaign.name || campaign.id}</h2>
          </div>
          <div className="profile-campaign-dialog-multiplier">
            <span className="profile-data-label">CAMPAIGN MULTIPLIER</span>
            <strong>×{formatNumber(campaign.multiplier)}</strong>
          </div>
        </div>
        {campaign.description && <p className="profile-campaign-description">{campaign.description}</p>}
        <div className="profile-campaign-details">
          <div>
            <span className="profile-data-label">CAMPAIGN DURATION</span>
            <strong>{durationLabel(campaign.startAt, campaign.endAt)}</strong>
            <small>{dateTime(campaign.startAt)} – {dateTime(campaign.endAt)}</small>
          </div>
          <div>
            <span className="profile-data-label">PARTICIPANTS</span>
            <strong>{formatNumber(Number(campaign.participantCount || 0))} users</strong>
            <small>Verified wallets with eligible points; verified linked wallets count as one identity.</small>
          </div>
          <div>
            <span className="profile-data-label">PROMO CODE</span>
            <strong>{campaign.promoCode || 'No promo code'}</strong>
          </div>
          <div>
            <span className="profile-data-label">ELIGIBLE ROUTE</span>
            <strong>{routeDescription(campaign)}</strong>
            <small>{chain}{campaign.source ? ` · ${campaign.source}` : ''}</small>
          </div>
        </div>
      </section>
    </div>
  ), document.body)
}

function ClaimWindowCard({ season }) {
  const now = Date.now()
  const status = Date.parse(season.claimWindowStart) <= now ? 'OPEN' : 'UPCOMING'
  return (
    <article className="profile-campaign-window">
      <div>
        <Tag tone={status === 'OPEN' ? 'green' : 'neutral'}>{status}</Tag>
        <strong>{season.name}</strong>
        <small>{season.rewardPoolStatus === 'FINALIZED' ? 'Finalized reward allocation' : 'Configured season reward pool'}</small>
      </div>
      <div>
        <span className="profile-data-label">CLAIM WINDOW</span>
        <strong>{dateTime(season.claimWindowStart)} – {dateTime(season.claimWindowEnd)}</strong>
      </div>
    </article>
  )
}

export default function ProfileCampaigns() {
  const [overview, setOverview] = useState({ campaigns: [], claimWindows: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedCampaign, setSelectedCampaign] = useState(null)
  const campaignTriggerRef = useRef(null)
  const closeButtonRef = useRef(null)

  const refresh = useCallback(async () => {
    setError('')
    try {
      setOverview(await getCampaignOverview())
    } catch (loadError) {
      setError(loadError?.message || 'Unable to load campaigns.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setError('')
      try {
        const result = await getCampaignOverview()
        if (!cancelled) setOverview(result)
      } catch (loadError) {
        if (!cancelled) setError(loadError?.message || 'Unable to load campaigns.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const openCampaign = (campaign, trigger) => {
    campaignTriggerRef.current = trigger
    setSelectedCampaign(campaign)
  }
  const closeCampaign = () => {
    setSelectedCampaign(null)
    window.requestAnimationFrame(() => campaignTriggerRef.current?.focus())
  }

  useEffect(() => {
    if (!selectedCampaign) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeCampaign()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [selectedCampaign])

  return (
    <section className="profile-campaigns-section">
      <SectionHeading
        eyebrow="LIVE SAMURAI CAMPAIGNS"
        title="Earn with active campaigns."
        text="Campaign terms and participant totals come from current admin settings and verified point activity."
      />
      {loading ? (
        <div className="profile-campaign-empty" role="status">Loading live campaigns…</div>
      ) : error ? (
        <div className="profile-campaign-empty profile-campaign-error" role="alert">
          <span>{error}</span>
          <Button variant="outline" icon="refresh" onClick={refresh}>Retry</Button>
        </div>
      ) : (
        <>
          {overview.campaigns.length ? (
            <div className="profile-campaign-list">
              {overview.campaigns.map((campaign) => <CampaignCard key={campaign.id} campaign={campaign} onSelect={openCampaign} />)}
            </div>
          ) : (
            <div className="profile-campaign-empty">
              <Icon name="info" size={18} />
              <span>There are no enabled upcoming or ongoing campaigns right now.</span>
            </div>
          )}
          <div className="profile-campaign-windows">
            <SectionHeading
              eyebrow="SEASON REWARDS"
              title="Claim windows."
              text="Samurai Point reward claims use the season windows configured by the admin; promo campaigns boost eligible earning and do not create separate reward pools."
            />
            {overview.claimWindows.length ? overview.claimWindows.map((season) => (
              <ClaimWindowCard key={season.id} season={season} />
            )) : <p className="profile-muted">No upcoming or open season reward claim windows are configured.</p>}
          </div>
        </>
      )}
      <CampaignDetailsDialog campaign={selectedCampaign} closeButtonRef={closeButtonRef} onClose={closeCampaign} />
    </section>
  )
}
