import { useEffect, useMemo, useState } from 'react'
import { formatCompact, formatNumber, getCurrentRank, getNextRank, getRankProgress } from '../data'
import { useWallet } from '../context/WalletContext'
import { getAggregatedProfileData } from '../services/profileService'
import { Button, ProgressBar, Sakura, SectionHeading, StatCard, Tag } from '../components/Layout'
import Icon from '../components/Icon'
import RewardClaimPanel from '../components/RewardClaimPanel'
import WalletLinkPanel from '../components/WalletLinkPanel'
import './profile.css'

const chainNames = { 101: 'Solana', 1: 'Ethereum', 4663: 'Robinhood Chain' }
const explorers = {
  101: (signature) => `https://solscan.io/tx/${signature}`,
  1: (signature) => `https://etherscan.io/tx/${signature}`,
  4663: (signature) => `https://robinhoodchain.blockscout.com/tx/${signature}`,
}

function short(value) {
  // Null-safe: when value is null/undefined (e.g. solanaPayoutWallet
  // is null on mobile inside MetaMask Mobile's browser where Phantom
  // is not injected), return an empty string instead of crashing on
  // `value.length`. The default param `= ''` only catches undefined,
  // NOT null — so we need an explicit guard.
  if (value == null) return ''
  const str = String(value)
  return str.length > 18 ? `${str.slice(0, 8)}...${str.slice(-6)}` : str
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

function NotConnected({ onConnectPhantom, onConnectMetaMask, disabled, error }) {
  return (
    <section className="profile-empty-state">
      <div className="profile-avatar profile-avatar-muted">侍</div>
      <h1>CONNECT YOUR WALLET</h1>
      <p>Connect Phantom for Solana rewards, or MetaMask to view EVM points.</p>
      <div className="profile-wallet-connect-buttons">
        <Button icon="wallet" onClick={onConnectPhantom} disabled={disabled}>Connect Phantom</Button>
        <Button variant="outline" icon="wallet" onClick={onConnectMetaMask} disabled={disabled}>Connect MetaMask</Button>
      </div>
      {error && <div className="error-box" role="alert"><Icon name="info" size={16} /><span>{error}</span></div>}
    </section>
  )
}

export default function Profile() {
  const { wallet, profile, walletDataState, openWalletModal, allWalletAddresses, verifiedEvmWallets, solanaPayoutWallet, verifiedIdentityLoaded, connectedEvmWallet, activeProfileWallet, connectionState, error: walletError, connectWallet, connectMetaMaskWallet } = useWallet()
  const [data, setData] = useState(null)
  const [state, setState] = useState('idle')
  const [visibleActivityCount, setVisibleActivityCount] = useState(3)
  const expectedLinkEvmWallet = (() => {
    if (typeof window === 'undefined') return null
    const address = new URLSearchParams(window.location.search).get('profileEvm')
    return /^0x[a-fA-F0-9]{40}$/.test(address || '') ? address : null
  })()

  // Detect mobile wallet-link phase from URL. On mobile, the EVM
  // wallet-link flow spans two browser contexts (Phantom → MetaMask
  // Mobile → back to Phantom). When the page loads inside MetaMask
  // Mobile's in-app browser, Phantom is NOT injected, so
  // solanaPayoutWallet is null. Without this check, the entire
  // "VERIFIED REWARD WALLETS" section (which contains WalletLinkPanel)
  // would be hidden on mobile during Phase 2 — the user would see no
  // "Link EVM Wallet" button and the auto-resume couldn't fire.
  //
  // We render the section whenever EITHER solanaPayoutWallet is
  // available (normal desktop + mobile Phantom) OR we're in a mobile
  // wallet-link phase (auto-resume in progress).
  //
  // Params can be in window.location.search (?wl=1) OR in the hash
  // (#profile?wl=1) because the app uses hash routing.
  const mobileWalletLinkPhase = (() => {
    if (typeof window === 'undefined') return false
    const sp = new URLSearchParams(window.location.search)
    if (sp.get('wl')) return true
    const hash = window.location.hash || ''
    const qIdx = hash.indexOf('?')
    if (qIdx >= 0) {
      const hp = new URLSearchParams(hash.slice(qIdx + 1))
      if (hp.get('wl')) return true
    }
    return false
  })()
  const [error, setError] = useState('')
  // Dismissible wallet-link explanation banner. Persisted to localStorage
  // so a user who has already acknowledged it doesn't see it again on
  // every page load. The previous version of this banner described the
  // OLD multi-wallet aggregation model (localStorage-based). The
  // current version reflects the cryptographic wallet-link flow:
  // users sign with both wallets to prove ownership, no on-chain
  // transactions are triggered, points are not transferred on-chain
  // to Solana, and existing Solana points are not reset.
  const [disclaimerDismissed, setDisclaimerDismissed] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return window.localStorage.getItem('ronin.profileWalletLinkDisclaimerV2') === '1' }
    catch { return false }
  })
  const dismissDisclaimer = () => {
    setDisclaimerDismissed(true)
    try { window.localStorage.setItem('ronin.profileWalletLinkDisclaimerV2', '1') } catch {}
  }

  useEffect(() => {
    if (!expectedLinkEvmWallet || !verifiedEvmWallets.some((address) => address.toLowerCase() === expectedLinkEvmWallet.toLowerCase())) return
    const url = new URL(window.location.href)
    url.searchParams.delete('profileEvm')
    window.history.replaceState(window.history.state, '', url.toString())
  }, [expectedLinkEvmWallet, verifiedEvmWallets])

  // Fetch aggregated profile data across ALL connected wallets (Phantom
  // + any MetaMask addresses tracked in localStorage). The list of
  // wallets comes from WalletContext.allWalletAddresses — the Phantom
  // address (if connected) is first, followed by any EVM addresses
  // the user has ever connected.
  //
  // If only the Phantom wallet is connected (no EVM activity), the
  // aggregated fetch degrades to a single-wallet fetch — equivalent to
  // the previous behavior.
  useEffect(() => {
    let cancelled = false
    // Don't fetch if we have no wallets at all OR if the only "wallet"
    // is a demo profile (no real address).
    if (!allWalletAddresses || allWalletAddresses.length === 0) {
      setData(null)
      setVisibleActivityCount(3)
      setState(wallet?.isDemo ? 'demo' : 'idle')
      setError('')
      return undefined
    }
    if (wallet?.isDemo) {
      setData(null)
      setVisibleActivityCount(3)
      setState('demo')
      setError('')
      return undefined
    }
    setVisibleActivityCount(3)
    setState('loading')
    setError('')
    getAggregatedProfileData(allWalletAddresses)
      .then((result) => { if (!cancelled) { setData(result); setState('ready') } })
      .catch((loadError) => { if (!cancelled) { setData(null); setState('error'); setError(loadError?.message || 'Your profile could not be loaded.') } })
    return () => { cancelled = true }
  }, [allWalletAddresses.join(','), wallet?.isDemo])

  const retry = () => {
    if (!allWalletAddresses || allWalletAddresses.length === 0) return
    setVisibleActivityCount(3)
    setState('loading')
    setError('')
    getAggregatedProfileData(allWalletAddresses)
      .then(setData)
      .then(() => setState('ready'))
      .catch((loadError) => { setState('error'); setError(loadError?.message || 'Your profile could not be loaded.') })
  }

  // Derived purely from the live swap history fetched above — no hardcoding.
  const frequentPairs = useMemo(() => buildFrequentPairs(data?.swaps || []), [data?.swaps])

  // The user is "connected" if EITHER a Phantom wallet is connected OR
  // at least one EVM wallet is tracked (i.e. the user has previously
  // swapped on Ethereum or Robinhood Chain via MetaMask). This lets
  // users view their multi-chain profile even if they don't have Phantom
  // installed.
  const hasAnyWallet = Boolean(activeProfileWallet || wallet) || (allWalletAddresses && allWalletAddresses.length > 0)
  if (!hasAnyWallet) return <NotConnected onConnectPhantom={connectWallet} onConnectMetaMask={connectMetaMaskWallet} disabled={connectionState === 'connecting'} error={walletError} />
  if (wallet?.isDemo) return <section className="profile-empty-state"><div className="profile-avatar">侍</div><Tag tone="red">UI PREVIEW</Tag><h1>SAMURAI PROFILE</h1><p>Connect a real wallet to load personal points, verified swaps, rank position, and live balance data.</p><Button variant="outline" icon="wallet" onClick={openWalletModal}>Connect real wallet</Button></section>
  if (state === 'loading' || walletDataState === 'loading') return <main className="profile-page"><ProfileSkeleton /></main>
  if (state === 'error') return <section className="profile-empty-state profile-error-state"><div className="profile-avatar profile-avatar-muted"><Icon name="info" size={24} /></div><h1>PROFILE UNAVAILABLE</h1><p>{error}</p><Button icon="refresh" onClick={retry}>Retry</Button></section>

  const stats = data?.walletStats || {}
  const rankProfile = profile || {}
  const currentRank = getCurrentRank(rankProfile)
  const nextRank = getNextRank(rankProfile)
  const rankProgress = getRankProgress(rankProfile, nextRank)
  // Aggregated stats: the new getAggregatedProfileData sums these
  // across all of the user's wallets (Phantom + MetaMask). The fields
  // fall back to the single-wallet leaderboard shape for backward
  // compatibility.
  const points = Number(stats.samuraiPoints || stats.lifetimePoints || 0)
  const volume = Number(stats.lifetimeVolume || 0)
  const swaps = Number(stats.swapsCount || stats.lifetimeSwaps || 0)
  const hasActivity = data?.swaps?.length > 0
  const neighborEntries = data?.neighbors || []
  const noStats = !data || (!points && !volume && !swaps && !hasActivity)
  // The per-wallet breakdown — used to render the multi-chain balance
  // display. Empty when only one wallet is tracked (the previous
  // single-wallet behavior).
  const perWallet = Array.isArray(stats.perWallet) ? stats.perWallet : []
  const trackedWalletCount = (data?.allWalletAddresses || []).length

  // Display wallet address — the connected Phantom Solana wallet ONLY.
  //
  // IMPORTANT (requirement #6): The Solana/Phantom wallet is the user's
  // reward/payout wallet. An EVM address is ONLY a linked identity
  // wallet — it must NEVER be displayed as the user's Solana reward
  // address, even when Phantom is not connected.
  //
  // Previously this fell back to `allWalletAddresses?.[0]` which mixes
  // Phantom + EVM addresses — when Phantom wasn't connected but an EVM
  // wallet was tracked, the EVM address would appear in the profile
  // header as if it were the Solana reward wallet. That's wrong.
  //
  // Now: display the Phantom Solana wallet address ONLY. When Phantom
  // is not connected (mobile inside MetaMask Mobile's browser, or
  // user hasn't connected Phantom yet), show '—' instead of falling
  // back to an EVM address. The EVM wallet link still appears in the
  // VERIFIED REWARD WALLETS section below — it's never confused with
  // the Solana reward wallet.
  const displayWalletAddress = (activeProfileWallet && !activeProfileWallet.isDemo) ? activeProfileWallet.address : (solanaPayoutWallet || connectedEvmWallet?.address || '')

  return (
    <main className="profile-page">
      {!disclaimerDismissed && (
        <div className="profile-wallet-disclaimer" role="alert">
          <div className="profile-wallet-disclaimer-content">
            <Icon name="info" size={18} />
            <div>
              <strong>Swapped on Ethereum or another EVM chain?</strong>
              <p>
                Your Samurai Points are associated with the wallet you used for those swaps. Link that EVM wallet to your main Solana reward wallet to make your eligible EVM points available through your Solana reward identity. You will sign a message with both wallets to prove ownership. This signature does not authorize transactions or token transfers. Your existing Solana points are not replaced or reset.
              </p>
            </div>
          </div>
          <button type="button" className="profile-wallet-disclaimer-close" onClick={dismissDisclaimer} aria-label="Dismiss disclaimer">×</button>
        </div>
      )}
      <section className="profile-hero-wrap">
        <div className="profile-hero-bg" aria-hidden="true">
          <img src="/images/profile-hero-blossoms.jpg" alt="" />
          <div className="profile-hero-overlay" />
        </div>
        <Sakura count={14} className="profile-hero-petals" />
        <div className="profile-hero-content">
          <section className="profile-header-section">
            <div className="profile-header-mark"><div className="profile-avatar">侍</div><span className="profile-mark-line" /></div>
            <div className="profile-header-copy"><span className="eyebrow">MY SAMURAI IDENTITY</span><h1>SAMURAI PROFILE</h1><p className="profile-wallet-address">{displayWalletAddress || '—'}</p><button className="profile-copy-button" onClick={() => navigator.clipboard?.writeText(displayWalletAddress)}><Icon name="copy" size={13} /> Copy wallet address</button></div>
            <div className="profile-header-rank"><span className="profile-data-label">CURRENT RANK</span><div className="profile-current-rank">{currentRank?.image && <img src={currentRank.image} alt="" />}<strong>{currentRank?.name || 'UNRANKED'}</strong></div><small>{profile?.balance != null ? `${formatCompact(profile.balance)} RONIN` : 'RONIN balance unavailable'}</small></div>
          </section>
          <div className="profile-wallet-connect-actions">
            <div className="profile-wallet-connect-status">
              <span className="profile-data-label">PROFILE WALLETS</span>
              <div className="profile-wallet-connect-tags">
                {wallet?.address && !wallet.isDemo && <Tag tone="green">PHANTOM · {short(wallet.address)}</Tag>}
                {connectedEvmWallet?.address && <Tag tone="green">METAMASK · {short(connectedEvmWallet.address)}</Tag>}
              </div>
            </div>
            <div className="profile-wallet-connect-buttons">
              <Button variant="outline" icon="wallet" onClick={() => connectWallet(connectedEvmWallet?.address || expectedLinkEvmWallet || undefined)} disabled={connectionState === 'connecting'}>
                {connectionState === 'connecting' ? 'Connecting…' : 'Connect Phantom'}
              </Button>
              <Button variant="outline" icon="wallet" onClick={connectMetaMaskWallet} disabled={connectionState === 'connecting'}>
                {connectionState === 'connecting' ? 'Connecting…' : 'Connect MetaMask'}
              </Button>
            </div>
            {walletError && <div className="error-box profile-wallet-connect-error" role="alert"><Icon name="info" size={16} /><span>{walletError}</span></div>}
          </div>
        </div>
      </section>

      {noStats && <div className="profile-notice"><Icon name="info" size={16} /> No Samurai activity yet. Make your first verified swap to begin your journey.</div>}

      <section className="profile-stats-grid">
        <StatCard stat={{ icon: 'coins', label: 'RONIN BALANCE', value: profile?.balance == null ? '—' : formatCompact(profile.balance), detail: walletDataState === 'error' ? 'Balance unavailable' : (trackedWalletCount > 1 ? `Solana mainnet · ${trackedWalletCount} wallets` : 'Solana mainnet') }} />
        <StatCard stat={{ icon: 'award', label: 'SAMURAI POINTS', value: formatNumber(points), detail: trackedWalletCount > 1 ? `Aggregated across ${trackedWalletCount} wallets` : 'Lifetime awarded points' }} />
        <StatCard stat={{ icon: 'chart', label: 'TOTAL VOLUME', value: volume ? `$${formatCompact(volume)}` : '$0', detail: 'Qualifying swap volume' }} />
        <StatCard stat={{ icon: 'swapVertical', label: 'TOTAL SWAPS', value: formatNumber(swaps), detail: 'Qualifying swaps' }} />
      </section>

      {/* RewardClaimPanel — always pass the verified Solana payout
          wallet (not the localStorage-derived EVM list). The backend
          resolves linked wallets from the database; the frontend never
          supplies a list. */}
      <RewardClaimPanel wallet={activeProfileWallet?.address || solanaPayoutWallet || wallet?.address || null} expectedEvmWallet={expectedLinkEvmWallet} />

      {/* Verified Reward Wallets section --------------------------------- */}
      {/* Clearly separates "Connected wallets" (UI convenience from
          localStorage + Phantom) from "Verified reward wallets"
          (cryptographically linked via /api/wallet-link/*). The
          difference matters: only the verified set is consulted by
          the backend for reward aggregation. */}
      {(solanaPayoutWallet || mobileWalletLinkPhase) && (
        <section className="profile-panel profile-verified-wallets-panel">
          <SectionHeading
            eyebrow="VERIFIED REWARD WALLETS"
            title="Cryptographically linked wallets"
            text="These wallets are part of your verified reward identity. Samurai Points earned by all of them are aggregated into your unified Solana reward balance."
          />
          <div className="profile-verified-wallets-list">
            <div className="profile-verified-wallet-row profile-verified-wallet-solana">
              <div className="profile-verified-wallet-label">
                <Tag tone="green">SOLANA · PAYOUT</Tag>
                <strong className="profile-wallet-addr">{short(solanaPayoutWallet) || '—'}</strong>
              </div>
              <small>SOL rewards are paid to this wallet</small>
            </div>
            {verifiedEvmWallets?.length > 0 ? (
              verifiedEvmWallets.map((evm) => (
                <div key={evm} className="profile-verified-wallet-row">
                  <div className="profile-verified-wallet-label">
                    <Tag tone="green">EVM · LINKED</Tag>
                    <strong className="profile-wallet-addr">{short(evm)}</strong>
                  </div>
                  <small>Earns Samurai Points on Ethereum + Robinhood Chain</small>
                </div>
              ))
            ) : (
              <p className="profile-muted">No EVM wallets linked yet. Link an EVM wallet to include its points in your reward balance.</p>
            )}
          </div>
          <WalletLinkPanel expectedEvmWallet={connectedEvmWallet?.address || expectedLinkEvmWallet || undefined} />
        </section>
      )}

      <section className="profile-main-grid">
        <div className="profile-panel profile-rank-panel"><SectionHeading eyebrow="THE WAY FORWARD" title="Rank progress" text={nextRank ? `${formatNumber(Math.max(0, Number(nextRank.minBalance || 0) - Number(profile?.balance || 0)))} RONIN until ${nextRank.name}.` : 'You hold the highest configured rank.'} /><div className="profile-rank-line"><span className="profile-rank-current">{currentRank?.image && <img src={currentRank.image} alt="" />}<strong>{currentRank?.name || 'Unranked'}</strong></span><span>{nextRank?.name || 'MAX RANK'}</span></div><ProgressBar value={rankProgress} rightLabel={`${rankProgress}%`} /><small className="profile-muted">Rank is calculated from the existing RONIN holding system.</small></div>
        <div className="profile-panel"><SectionHeading eyebrow="YOUR POSITION" title="Leaderboard" /><div className="profile-leaderboard-position">{stats.currentRank ? `#${formatNumber(Number(stats.currentRank))}` : '—'}<span>YOUR LEADERBOARD POSITION</span></div><div className="profile-neighbors">{neighborEntries.length ? neighborEntries.map((entry) => <div className={(entry.wallet && allWalletAddresses.some((addr) => addr.toLowerCase() === entry.wallet.toLowerCase())) ? 'is-you' : ''} key={`${entry.rank}-${entry.wallet}`}><span>#{entry.rank}</span><span>{(entry.wallet && allWalletAddresses.some((addr) => addr.toLowerCase() === entry.wallet.toLowerCase())) ? 'YOU' : short(entry.wallet)}</span><strong>{formatNumber(entry.samuraiPoints)} SP</strong></div>) : <p className="profile-muted">Your position will appear after your first qualifying swap.</p>}</div></div>
      </section>

      <section className="profile-panel profile-journey-panel"><SectionHeading eyebrow="PERSONAL PROGRESS" title="Your Samurai journey" /><div className="profile-journey-grid"><div><span className="profile-data-label">POINTS</span><strong>{formatNumber(points)} SP</strong></div><div><span className="profile-data-label">VOLUME</span><strong>${volume.toLocaleString('en-US', { maximumFractionDigits: 2 })}</strong></div><div><span className="profile-data-label">RANK</span><span className="profile-journey-rank">{currentRank?.image && <img src={currentRank.image} alt="" />}<strong>{currentRank?.name || 'UNRANKED'}</strong></span></div><div><span className="profile-data-label">REWARDS</span><strong>—</strong><small>Not configured</small></div></div></section>

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

      <section className="profile-activity-section"><SectionHeading eyebrow="VERIFIED ON-CHAIN" title="Your recent activity" text="Only verified swaps belonging to this connected wallet are shown." />{hasActivity ? <><div className="profile-activity-list">{data.swaps.slice(0, visibleActivityCount).map((swap) => <ActivityRow key={`${swap.chain_id}-${swap.signature}`} swap={swap} />)}</div>{visibleActivityCount < data.swaps.length && <button type="button" className="profile-activity-more" onClick={() => setVisibleActivityCount((count) => count + 10)}>View More</button>}</> : <div className="profile-activity-empty"><Icon name="swapVertical" size={22} /><p>No Samurai activity yet.</p><small>Make your first swap to begin your journey.</small></div>}</section>

      <section className="profile-shield-panel"><div><span className="eyebrow">WALLET PROTECTION</span><h2>Shield status</h2><p>Personal Shield scan history is not currently indexed for this wallet. The existing Shield scanner remains available from the Shield page.</p></div><Button variant="outline" icon="arrowUpRight" href="#shield">Open Shield</Button></section>
    </main>
  )
}
