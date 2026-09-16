import { useEffect, useMemo, useState } from 'react'
import { formatCompact, formatNumber, getCurrentRank, getNextRank, getRankProgress } from '../data'
import { useWallet } from '../context/WalletContext'
import { getProfileData } from '../services/profileService'
import { Button, ProgressBar, Sakura, SectionHeading, StatCard, Tag } from '../components/Layout'
import Icon from '../components/Icon'
import RewardClaimPanel from '../components/RewardClaimPanel'
import './profile.css'

const chainNames = { 101: 'Solana', 1: 'Ethereum', 4663: 'Robinhood Chain' }
const explorers = {
  101: (signature) => `https://solscan.io/tx/${signature}`,
  1: (signature) => `https://etherscan.io/tx/${signature}`,
  4663: (signature) => `https://robinhoodchain.blockscout.com/tx/${signature}`,
}

function short(value = '') {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value
}

function tokenName(value, chainId) {
  if (!value) return 'Unknown'
  const normalized = String(value).toLowerCase()
  if (normalized === 'native') return chainId === 101 ? 'SOL' : 'ETH'
  if (normalized.endsWith('2jvevxor') || normalized.includes('2jvevx')) return 'RONIN'
  return short(value)
}

function dateLabel(value) {
  if (!value) return 'Date unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

function ProfileSkeleton() {
  return <div className="profile-skeleton" aria-label="Loading profile"><span /><span /><span /><span /></div>
}

function ActivityRow({ swap }) {
  const chainId = Number(swap.chain_id)
  const signature = swap.transaction_hash || swap.signature
  const explorer = explorers[chainId]?.(signature)
  return (
    <article className="profile-activity-row">
      <div className="profile-activity-pair"><strong>{tokenName(swap.input_mint, chainId)} <span>→</span> {tokenName(swap.output_mint, chainId)}</strong><small>{chainNames[chainId] || `Chain ${chainId}`}</small></div>
      <div><span className="profile-data-label">USD VALUE</span><strong>{swap.volume_usd == null && !swap.qualifying_volume_usd ? '—' : `$${Number(swap.volume_usd || swap.qualifying_volume_usd).toLocaleString('en-US', { maximumFractionDigits: 2 })}`}</strong></div>
      <div><span className="profile-data-label">POINTS</span><strong className="profile-red">+{formatNumber(Number(swap.points_awarded || 0))} SP</strong></div>
      <div><Tag tone={swap.eligibility_status === 'qualified' ? 'green' : 'neutral'}>{swap.status || 'CONFIRMED'}</Tag><small>{dateLabel(swap.timestamp || swap.created_at)}</small></div>
      {explorer && <a className="profile-explorer-link" href={explorer} target="_blank" rel="noreferrer" aria-label="Open transaction in explorer"><Icon name="external" size={14} /></a>}
    </article>
  )
}

// Computes the user's most frequent swap pairs from the live swap history.
// Pure UI helper — does not call any API or mutate any state. The pair key is
// direction-sensitive (ETH->USDC is counted separately from USDC->ETH) so the
// list reflects the user's actual signing pattern.
function buildFrequentPairs(swaps) {
  if (!Array.isArray(swaps) || swaps.length === 0) return []
  const buckets = new Map()
  for (const swap of swaps) {
    const chainId = Number(swap.chain_id)
    const fromMint = String(swap.input_mint || '').toLowerCase()
    const toMint = String(swap.output_mint || '').toLowerCase()
    if (!fromMint || !toMint) continue
    const key = `${chainId}:${fromMint}>${toMint}`
    const existing = buckets.get(key)
    const volumeUsd = Number(swap.volume_usd || swap.qualifying_volume_usd || 0)
    const timestamp = swap.timestamp || swap.created_at
    if (existing) {
      existing.count += 1
      existing.totalVolume += volumeUsd
      if (timestamp && (!existing.lastTimestamp || new Date(timestamp) > new Date(existing.lastTimestamp))) {
        existing.lastTimestamp = timestamp
      }
    } else {
      buckets.set(key, {
        key,
        chainId,
        fromMint: swap.input_mint,
        toMint: swap.output_mint,
        count: 1,
        totalVolume: volumeUsd,
        lastTimestamp: timestamp || null,
      })
    }
  }
  return [...buckets.values()]
    .sort((left, right) => right.count - left.count || right.totalVolume - left.totalVolume)
    .slice(0, 5)
}

function FrequentSwapRow({ pair, rank }) {
  const fromName = tokenName(pair.fromMint, pair.chainId)
  const toName = tokenName(pair.toMint, pair.chainId)
  const chainName = chainNames[pair.chainId] || `Chain ${pair.chainId}`
  return (
    <article className="profile-frequent-row">
      <span className="profile-frequent-rank">#{rank}</span>
      <div className="profile-frequent-pair">
        <strong>{fromName} <span aria-hidden="true">→</span> {toName}</strong>
        <small>{chainName}</small>
      </div>
      <div className="profile-frequent-stat"><span className="profile-data-label">SWAPS</span><strong>{formatNumber(pair.count)}</strong></div>
      <div className="profile-frequent-stat"><span className="profile-data-label">VOLUME</span><strong>{pair.totalVolume > 0 ? `$${formatCompact(pair.totalVolume)}` : '—'}</strong></div>
      <div className="profile-frequent-stat"><span className="profile-data-label">LAST SWAP</span><small>{dateLabel(pair.lastTimestamp)}</small></div>
    </article>
  )
}

function NotConnected({ onConnect }) {
  return <section className="profile-empty-state"><div className="profile-avatar profile-avatar-muted">侍</div><h1>CONNECT YOUR WALLET</h1><p>Connect your wallet to enter your Samurai profile.</p><Button icon="wallet" onClick={onConnect}>Connect wallet</Button></section>
}

export default function Profile() {
  const { wallet, profile, walletDataState, openWalletModal } = useWallet()
  const [data, setData] = useState(null)
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!wallet || wallet.isDemo) {
      setData(null)
      setState(wallet?.isDemo ? 'demo' : 'idle')
      setError('')
      return undefined
    }
    setState('loading')
    setError('')
    getProfileData(wallet.address)
      .then((result) => { if (!cancelled) { setData(result); setState('ready') } })
      .catch((loadError) => { if (!cancelled) { setData(null); setState('error'); setError(loadError?.message || 'Your profile could not be loaded.') } })
    return () => { cancelled = true }
  }, [wallet?.address, wallet?.isDemo])

  const retry = () => {
    if (!wallet || wallet.isDemo) return
    setState('loading')
    setError('')
    getProfileData(wallet.address)
      .then(setData)
      .then(() => setState('ready'))
      .catch((loadError) => { setState('error'); setError(loadError?.message || 'Your profile could not be loaded.') })
  }

  // Derived purely from the live swap history fetched above — no hardcoding.
  const frequentPairs = useMemo(() => buildFrequentPairs(data?.swaps || []), [data?.swaps])

  if (!wallet) return <NotConnected onConnect={openWalletModal} />
  if (wallet.isDemo) return <section className="profile-empty-state"><div className="profile-avatar">侍</div><Tag tone="red">UI PREVIEW</Tag><h1>SAMURAI PROFILE</h1><p>Connect a real wallet to load personal points, verified swaps, rank position, and live balance data.</p><Button variant="outline" icon="wallet" onClick={openWalletModal}>Connect real wallet</Button></section>
  if (state === 'loading' || walletDataState === 'loading') return <main className="profile-page"><ProfileSkeleton /></main>
  if (state === 'error') return <section className="profile-empty-state profile-error-state"><div className="profile-avatar profile-avatar-muted"><Icon name="info" size={24} /></div><h1>PROFILE UNAVAILABLE</h1><p>{error}</p><Button icon="refresh" onClick={retry}>Retry</Button></section>

  const stats = data?.walletStats || {}
  const rankProfile = profile || {}
  const currentRank = getCurrentRank(rankProfile)
  const nextRank = getNextRank(rankProfile)
  const rankProgress = getRankProgress(rankProfile, nextRank)
  const points = Number(stats.lifetimePoints || 0)
  const volume = Number(stats.lifetimeVolume || 0)
  const swaps = Number(stats.lifetimeSwaps || 0)
  const hasActivity = data?.swaps?.length > 0
  const neighborEntries = data?.neighbors || []
  const noStats = !data || (!points && !volume && !swaps && !hasActivity)

  return (
    <main className="profile-page">
      <section className="profile-hero-wrap">
        <div className="profile-hero-bg" aria-hidden="true">
          <img src="/images/profile-hero-blossoms.jpg" alt="" />
          <div className="profile-hero-overlay" />
        </div>
        <Sakura count={14} className="profile-hero-petals" />
        <div className="profile-hero-content">
          <section className="profile-header-section">
            <div className="profile-header-mark"><div className="profile-avatar">侍</div><span className="profile-mark-line" /></div>
            <div className="profile-header-copy"><span className="eyebrow">MY SAMURAI IDENTITY</span><h1>SAMURAI PROFILE</h1><p className="profile-wallet-address">{wallet.address}</p><button className="profile-copy-button" onClick={() => navigator.clipboard?.writeText(wallet.address)}><Icon name="copy" size={13} /> Copy wallet address</button></div>
            <div className="profile-header-rank"><span className="profile-data-label">CURRENT RANK</span><strong>{currentRank?.name || 'UNRANKED'}</strong><small>{profile?.balance != null ? `${formatCompact(profile.balance)} RONIN` : 'RONIN balance unavailable'}</small></div>
          </section>
        </div>
      </section>

      {noStats && <div className="profile-notice"><Icon name="info" size={16} /> No Samurai activity yet. Make your first verified swap to begin your journey.</div>}

      <section className="profile-stats-grid">
        <StatCard stat={{ icon: 'coins', label: 'RONIN BALANCE', value: profile?.balance == null ? '—' : formatCompact(profile.balance), detail: walletDataState === 'error' ? 'Balance unavailable' : 'Solana mainnet' }} />
        <StatCard stat={{ icon: 'award', label: 'SAMURAI POINTS', value: formatNumber(points), detail: 'Lifetime awarded points' }} />
        <StatCard stat={{ icon: 'chart', label: 'TOTAL VOLUME', value: volume ? `$${formatCompact(volume)}` : '$0', detail: 'Qualifying swap volume' }} />
        <StatCard stat={{ icon: 'swapVertical', label: 'TOTAL SWAPS', value: formatNumber(swaps), detail: 'Qualifying swaps' }} />
      </section>

      <RewardClaimPanel wallet={wallet.address} />

      <section className="profile-main-grid">
        <div className="profile-panel profile-rank-panel"><SectionHeading eyebrow="THE WAY FORWARD" title="Rank progress" text={nextRank ? `${formatNumber(Math.max(0, Number(nextRank.minBalance || 0) - Number(profile?.balance || 0)))} RONIN until ${nextRank.name}.` : 'You hold the highest configured rank.'} /><div className="profile-rank-line"><strong>{currentRank?.name || 'Unranked'}</strong><span>{nextRank?.name || 'MAX RANK'}</span></div><ProgressBar value={rankProgress} rightLabel={`${rankProgress}%`} /><small className="profile-muted">Rank is calculated from the existing RONIN holding system.</small></div>
        <div className="profile-panel"><SectionHeading eyebrow="YOUR POSITION" title="Leaderboard" /><div className="profile-leaderboard-position">{stats.currentRank ? `#${formatNumber(Number(stats.currentRank))}` : '—'}<span>YOUR LEADERBOARD POSITION</span></div><div className="profile-neighbors">{neighborEntries.length ? neighborEntries.map((entry) => <div className={entry.wallet?.toLowerCase() === wallet.address.toLowerCase() ? 'is-you' : ''} key={`${entry.rank}-${entry.wallet}`}><span>#{entry.rank}</span><span>{entry.wallet?.toLowerCase() === wallet.address.toLowerCase() ? 'YOU' : short(entry.wallet)}</span><strong>{formatNumber(entry.samuraiPoints)} SP</strong></div>) : <p className="profile-muted">Your position will appear after your first qualifying swap.</p>}</div></div>
      </section>

      <section className="profile-panel profile-journey-panel"><SectionHeading eyebrow="PERSONAL PROGRESS" title="Your Samurai journey" /><div className="profile-journey-grid"><div><span className="profile-data-label">POINTS</span><strong>{formatNumber(points)} SP</strong></div><div><span className="profile-data-label">VOLUME</span><strong>${volume.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong></div><div><span className="profile-data-label">RANK</span><strong>{currentRank?.name || 'UNRANKED'}</strong></div><div><span className="profile-data-label">REWARDS</span><strong>—</strong><small>Not configured</small></div></div></section>

      <section className="profile-frequent-section">
        <div className="profile-frequent-decor" aria-hidden="true">
          <img src="/images/profile-blossom-branch.jpg" alt="" />
        </div>
        <div className="profile-frequent-inner">
          <SectionHeading eyebrow="YOUR SIGNATURE MOVES" title="Most frequent swaps" text="The swap pairs you keep coming back to — computed live from your verified on-chain history." />
          {frequentPairs.length ? (
            <div className="profile-frequent-list">
              {frequentPairs.map((pair, index) => <FrequentSwapRow key={pair.key} pair={pair} rank={index + 1} />)}
            </div>
          ) : (
            <div className="profile-activity-empty"><Icon name="swapVertical" size={22} /><p>No frequent swaps yet.</p><small>Make a few swaps to see your favorite pairs here.</small></div>
          )}
        </div>
      </section>

      <section className="profile-activity-section"><SectionHeading eyebrow="VERIFIED ON-CHAIN" title="Your recent activity" text="Only verified swaps belonging to this connected wallet are shown." />{hasActivity ? <div className="profile-activity-list">{data.swaps.slice(0, 20).map((swap) => <ActivityRow key={`${swap.chain_id}-${swap.signature}`} swap={swap} />)}</div> : <div className="profile-activity-empty"><Icon name="swapVertical" size={22} /><p>No Samurai activity yet.</p><small>Make your first swap to begin your journey.</small></div>}</section>

      <section className="profile-shield-panel"><div><span className="eyebrow">WALLET PROTECTION</span><h2>Shield status</h2><p>Personal Shield scan history is not currently indexed for this wallet. The existing Shield scanner remains available from the Shield page.</p></div><Button variant="outline" icon="arrowUpRight" href="#shield">Open Shield</Button></section>
    </main>
  )
}
