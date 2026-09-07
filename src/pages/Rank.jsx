import { useEffect, useMemo, useState } from 'react'
import { formatCompact, formatNumber, getCurrentRank, getNextRank, getRankProgress, ranks } from '../data'
import { useWallet } from '../context/WalletContext'
import Icon from '../components/Icon'
import { Button, Eyebrow, PageHero, ProgressBar, SectionHeading, Tag } from '../components/Layout'

const iconForRank = (id) => {
  if (id === 'gashira') return 'crown'
  if (id === 'ronin-legend') return 'award'
  if (id === 'shogun') return 'trophy'
  if (id === 'ashigaru') return 'mountain'
  return 'shield'
}

function RequirementRow({ icon, label, target, current, complete, pending, walletConnected, primary = false, thresholdPending = false }) {
  const pendingMessage = thresholdPending ? 'Official threshold is still being finalized' : walletConnected ? (primary ? 'Live balance read unavailable' : 'Not indexed in this phase') : 'Connect wallet to read progress'
  const completeMessage = primary ? `${target} · rank gate met` : `${target} · tracked separately`
  const statusLabel = thresholdPending ? 'TBA' : complete ? 'Met' : pending ? 'Pending' : primary ? 'In progress' : 'Optional'
  return <div className={`requirement-row ${complete ? 'complete' : ''} ${primary ? 'primary' : 'secondary'}`}><span className="requirement-icon"><Icon name={complete ? 'check' : icon} size={14} /></span><div><strong>{label}</strong><span>{pending ? pendingMessage : complete ? completeMessage : `${current} of ${target}`}</span></div><span className={`requirement-status ${complete ? 'done' : ''}`}>{statusLabel}</span></div>
}

const holdingRequirement = (rank) => typeof rank.minBalance === 'number' ? `${formatNumber(rank.minBalance)} $RONIN` : 'Threshold TBA'

export default function Rank() {
  const { wallet, profile, walletDataState, walletDataError, openWalletModal } = useWallet()
  const isGashiraWallet = wallet?.address === '3xfHXYiPMJQUYqF23cHJUMPkQEjoQ6W2f9L5i1XPXb7r'
  const currentRank = isGashiraWallet ? ranks.find((rank) => rank.id === 'gashira') : getCurrentRank(profile)
  const nextRank = isGashiraWallet ? null : getNextRank(profile)
  const currentProgress = getRankProgress(profile, nextRank)
  const [selectedId, setSelectedId] = useState(currentRank?.id || 'ronin-legend')
  const [isPortraitFlipped, setIsPortraitFlipped] = useState(false)

  useEffect(() => {
    if (currentRank) setSelectedId(currentRank.id)
    else if (profile && nextRank) setSelectedId(nextRank.id)
  }, [currentRank?.id, nextRank?.id, profile])

  useEffect(() => {
    setIsPortraitFlipped(false)
  }, [selectedId])

  const selectedRank = useMemo(() => ranks.find((rank) => rank.id === selectedId) || ranks[1], [selectedId])
  const isSelectedCurrent = currentRank?.id === selectedRank.id
  const hasNextThreshold = typeof nextRank?.minBalance === 'number'
  const hasValue = (key) => typeof profile?.[key] === 'number'
  const requirements = [
    { icon: 'coins', label: '$RONIN holding requirement', target: holdingRequirement(selectedRank), current: hasValue('balance') ? `${formatNumber(profile.balance)} $RONIN` : '', complete: hasValue('balance') && typeof selectedRank.minBalance === 'number' && profile.balance >= selectedRank.minBalance, pending: !hasValue('balance') || typeof selectedRank.minBalance !== 'number', thresholdPending: typeof selectedRank.minBalance !== 'number', primary: true },
    { icon: 'image', label: 'NFT / ecosystem signal', target: selectedRank.minNfts ? `${selectedRank.minNfts} ${selectedRank.minNfts === 1 ? 'NFT' : 'NFTs'}` : 'Not required', current: hasValue('nfts') ? `${profile.nfts} ${profile.nfts === 1 ? 'NFT' : 'NFTs'}` : '', complete: selectedRank.minNfts === 0 || (hasValue('nfts') && profile.nfts >= selectedRank.minNfts), pending: selectedRank.minNfts > 0 && !hasValue('nfts') },
    { icon: 'gamepad', label: 'Game XP / ecosystem signal', target: selectedRank.minXp ? `${formatNumber(selectedRank.minXp)} XP` : 'Not required', current: hasValue('xp') ? `${formatNumber(profile.xp)} XP` : '', complete: selectedRank.minXp === 0 || (hasValue('xp') && profile.xp >= selectedRank.minXp), pending: selectedRank.minXp > 0 && !hasValue('xp') },
    { icon: 'lock', label: 'Yield / ecosystem signal', target: selectedRank.minYield ? `${formatNumber(selectedRank.minYield)} $RONIN locked` : 'Not required', current: hasValue('yieldLocked') ? `${formatNumber(profile.yieldLocked)} $RONIN` : '', complete: selectedRank.minYield === 0 || (hasValue('yieldLocked') && profile.yieldLocked >= selectedRank.minYield), pending: selectedRank.minYield > 0 && !hasValue('yieldLocked') },
  ]

  return (
    <>
      <PageHero eyebrow="Rank system / 06" title="Climb the ranks." titleAccent="Become legendary." text="Your rank defines your power, your voice, and your place in the Ronin clan." image="/images/rank-warrior.jpg" className="rank-hero" petals={false}>
        <div className="page-hero-ref-actions"><Button onClick={wallet ? () => document.getElementById('rank-system')?.scrollIntoView({ behavior: 'smooth' }) : openWalletModal} icon={wallet ? 'award' : 'wallet'}>{wallet ? 'View my rank' : 'Connect to reveal rank'}</Button><Tag tone="light">On-chain profile layer</Tag></div>
      </PageHero>

      <section className="section rank-section" id="rank-system">
        <div className="section-row rank-intro-row"><SectionHeading eyebrow="The hierarchy" title="Every rank is earned." text="Progress is designed to be legible: holdings, participation, and proof of contribution. Connect a wallet to turn this map into your personal climb." /><div className="rank-total"><strong>08</strong><span>ranks in<br />the clan</span></div></div>
        <div className="rank-layout">
          <aside className="rank-ladder surface-card" aria-label="Ronin ranks"><div className="ladder-top"><span className="data-label">CLAN HIERARCHY</span><span className="ladder-line" /></div>{ranks.map((rank, index) => <button key={rank.id} className={`rank-ladder-item ${selectedId === rank.id ? 'active' : ''} ${currentRank?.id === rank.id ? 'current' : ''}`} onClick={() => setSelectedId(rank.id)}><span className="ladder-index">0{index + 1}</span><span className="rank-sigil"><Icon name={iconForRank(rank.id)} size={14} /></span><span className="rank-ladder-name"><strong>{rank.name}</strong><small>{rank.subtitle}</small></span>{currentRank?.id === rank.id && <Tag tone="red">You</Tag>}<Icon name="chevronRight" size={14} /></button>)}</aside>
          <div className="rank-detail-column">
            <div className="rank-identity surface-card"><div className="identity-mark large">{currentRank ? currentRank.kanji : '刃'}</div><div className="identity-copy"><Eyebrow>{profile ? (profile.isLive ? 'Live holding rank' : 'Demo holding rank') : 'Current rank'}</Eyebrow><h3>{currentRank ? currentRank.name : profile ? 'Unranked' : walletDataState === 'loading' ? 'Reading wallet' : 'Connect to reveal'}</h3><p>{currentRank ? currentRank.subtitle : profile ? `Hold ${holdingRequirement(nextRank)} to enter the clan.` : walletDataError || 'Your rank is calculated from your $RONIN holding.'}</p></div><div className="rank-progress-summary"><span>PROGRESS TO {nextRank ? nextRank.name.toUpperCase() : 'THE SUMMIT'}</span><strong>{profile ? (hasNextThreshold ? `${currentProgress}%` : 'TBA') : walletDataState === 'loading' ? '…' : '—'}</strong><ProgressBar value={profile && hasNextThreshold ? currentProgress : 0} /></div></div>
            <div className="rank-detail-grid">
              <div className="rank-requirements surface-card">
                <div className="panel-heading"><div><Eyebrow>{isSelectedCurrent ? 'Your next threshold' : 'Rank gate & signals'}</Eyebrow><h3>{selectedRank.name} requirements</h3></div><Tag tone={isSelectedCurrent ? 'red' : 'neutral'}>{isSelectedCurrent ? 'CURRENT' : selectedRank.subtitle}</Tag></div>
                <div className="requirements-list">{requirements.map((item) => <RequirementRow key={item.label} {...item} pending={item.pending || !profile || walletDataState === 'loading'} walletConnected={Boolean(wallet)} />)}</div>
                <div className="requirements-foot"><Icon name="info" size={14} /><span>$RONIN holding is the only rank gate in option 1. NFT, XP, and yield are tracked separately until their programs are indexed.</span></div>
              </div>
              <div className={`rank-unlocks surface-card ${isPortraitFlipped ? 'is-flipped' : ''}`}>
                <div className="panel-heading"><div><Eyebrow>Rank portrait</Eyebrow><h3>{selectedRank.name}.</h3></div><span className="unlock-seal">{selectedRank.kanji}</span></div>
                <div className="rank-card-flip" aria-live="polite">
                  <div className="rank-card-face rank-card-front"><div className="rank-card-art"><img src={selectedRank.image} alt={`${selectedRank.name} rank artwork`} /><div className="rank-card-art-shade" /><span>{selectedRank.role}</span><strong>{selectedRank.kanji}</strong></div><button className="rank-flip-button" type="button" onClick={() => setIsPortraitFlipped(true)} aria-label={`Show ${selectedRank.name} rank details`}><span>View rank details</span><Icon name="arrowRight" size={14} /></button></div>
                  <div className="rank-card-face rank-card-back"><button className="rank-flip-button rank-flip-button-back" type="button" onClick={() => setIsPortraitFlipped(false)} aria-label={`Show ${selectedRank.name} rank portrait`}><Icon name="arrowRight" size={14} /><span>View portrait</span></button><div className="rank-brief"><strong>{selectedRank.holdingNote}</strong><p>{selectedRank.statement}</p></div><div className="duties-label"><Icon name="sword" size={12} /> Duties / role in the clan</div><ul className="rank-duties">{selectedRank.duties.map((duty) => <li key={duty.title}><Icon name="arrowRight" size={11} /><div><strong>{duty.title}</strong><span>{duty.text}</span></div></li>)}</ul><div className="unlock-divider"><Eyebrow>{selectedRank.unlockLabel || 'What you unlock'}</Eyebrow></div><ul className="unlock-list">{selectedRank.unlocks.map((unlock) => <li key={unlock.title}><Icon name="check" size={13} /><div><strong>{unlock.title}</strong><span>{unlock.text}</span></div></li>)}</ul><div className="unlock-next"><span>Next on the path</span><strong>{nextRank && isSelectedCurrent ? nextRank.name : selectedRank.id === 'gashira' ? 'The summit' : 'Select a rank to explore'}</strong></div></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section section-cream rank-progress-section">
        <div className="progress-quote"><span className="quote-mark">“</span><blockquote>The blade is not made by one strike.<br /><em>Neither is a legend.</em></blockquote><span className="quote-attribution">— the Ronin code</span></div>
        <div className="progress-card surface-card"><div className="panel-heading"><div><Eyebrow>{profile ? 'Your live preview' : 'Your future profile'}</Eyebrow><h3>{profile ? 'The next mark is in sight.' : 'Your place is waiting.'}</h3></div><Icon name="trend" size={18} /></div>{profile ? <><div className="next-rank-head"><span>{currentRank?.name || 'Unranked'}</span><Icon name="arrowRight" size={14} /><strong>{nextRank?.name || 'Gashira'}</strong></div><ProgressBar value={hasNextThreshold ? currentProgress : 0} label="Progress to next rank" rightLabel={hasNextThreshold ? `${currentProgress}%` : 'TBA'} /><div className="remaining-grid"><div><span>Holding gap</span><strong>{nextRank && hasNextThreshold ? formatCompact(Math.max(0, nextRank.minBalance - profile.balance)) : '—'}</strong><small>{hasNextThreshold ? '$RONIN' : 'Threshold TBA'}</small></div><div><span>XP gap</span><strong>{nextRank && hasValue('xp') ? formatNumber(Math.max(0, nextRank.minXp - profile.xp)) : '—'}</strong><small>{hasValue('xp') ? 'XP' : 'Indexer pending'}</small></div><div><span>NFT gap</span><strong>{nextRank && hasValue('nfts') ? Math.max(0, nextRank.minNfts - profile.nfts) : '—'}</strong><small>{hasValue('nfts') ? 'NFTs' : 'Indexer pending'}</small></div></div></> : <><p className="progress-empty">Connect a wallet to see exactly what remains between you and the next rank.</p><Button onClick={openWalletModal} icon="wallet">Connect wallet</Button></>}</div>
      </section>
    </>
  )
}
