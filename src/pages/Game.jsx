import { useState } from 'react'
import { gameFeatures, formatCompact, formatNumber } from '../data'
import { useWallet } from '../context/WalletContext'
import Icon from '../components/Icon'
import { Button, Eyebrow, PageHero, ProgressBar, SectionHeading, Tag } from '../components/Layout'

export default function Game() {
  const { wallet, profile, walletDataState, openWalletModal } = useWallet()
  const isDemoProfile = Boolean(profile && !profile.isLive)
  const hasGameData = typeof profile?.level === 'number'
  const [activeFeature, setActiveFeature] = useState(gameFeatures[0])
  const [notice, setNotice] = useState('')

  const play = () => {
    if (!wallet) {
      openWalletModal()
      return
    }
    setNotice('The game portal is being forged. Your connected profile is ready for season one.')
  }

  return (
    <>
      <PageHero eyebrow="Game / 04" title="Enter the world" titleAccent="of Ronin." text="A living progression layer for the people who choose to keep walking." image="/images/game-landscape.jpg" className="game-hero">
        <div className="page-hero-ref-actions"><Button onClick={play} icon={wallet ? 'gamepad' : 'wallet'}>{wallet ? 'Play now' : 'Connect to play'}</Button><Button href="#game-profile" variant="outline" icon="arrowDown">View profile</Button></div>
      </PageHero>

      <section className="game-nav-section enhanced-nav" style={{ padding: '0' }}>
        <div className="container"><div className="game-feature-nav" role="tablist" aria-label="Game features">{gameFeatures.map((feature) => <button key={feature.id} role="tab" aria-selected={activeFeature.id === feature.id} className={activeFeature.id === feature.id ? 'active' : ''} onClick={() => { setActiveFeature(feature); setNotice('') }}><Icon name={feature.icon} size={16} /><span>{feature.label}</span><Icon name="arrowUpRight" size={12} /></button>)}</div></div>
      </section>

      <section className="section game-feature-section enhanced-section">
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/game-landscape.jpg')" }} />
        <div className="enhanced-ink">遊戯</div>
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="feature-showcase enhanced-card">
            <div className="feature-visual"><img src="/images/game-landscape.jpg" alt="Misty Japanese mountain path leading to a temple" /><div className="feature-visual-overlay" /><div className="feature-index">0{gameFeatures.findIndex((feature) => feature.id === activeFeature.id) + 1} / 06</div><div className="feature-kanji">{activeFeature.id === 'earn' ? '稼' : activeFeature.id === 'play' ? '遊' : activeFeature.id === 'leaderboard' ? '誉' : activeFeature.id === 'achievements' ? '証' : activeFeature.id === 'gear' ? '具' : '道'}</div></div>
            <div className="feature-copy"><Eyebrow>{activeFeature.label}</Eyebrow><h2 className="display-heading">{activeFeature.title}</h2><p>{activeFeature.text}</p><div className="feature-rule"><span /> season one / in preparation</div><Button onClick={play} variant="outline" icon={wallet ? 'arrowUpRight' : 'wallet'}>{wallet ? 'Open game portal' : 'Connect wallet'}</Button>{notice && <div className="inline-message"><Icon name="info" size={16} />{notice}</div>}</div>
          </div>
        </div>
      </section>

      <section className="section game-profile-section" id="game-profile" style={{ background: 'var(--paper)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <div className="container">
          <div className="section-row"><SectionHeading eyebrow="Your game profile" title="Carry your progress." text="Connect a wallet to make your rank, XP, and achievements personal. Demo values are clearly marked until reads are live." /><div className="profile-state" style={{ color: 'var(--muted)' }}><span className={`status-dot ${wallet ? 'connected' : ''}`} /> {wallet ? (wallet.isDemo ? 'Demo profile' : walletDataState === 'loading' ? 'Reading mainnet…' : walletDataState === 'error' ? 'Live read unavailable' : 'Wallet synced') : 'No wallet connected'}</div></div>
          {!wallet ? <div className="empty-profile surface-card" style={{ marginTop: '32px', borderColor: 'var(--line)', background: 'var(--cream)' }}><div className="empty-profile-icon" style={{ borderColor: 'var(--line)', color: 'var(--red)' }}><Icon name="wallet" size={20} /></div><div><h3 style={{ color: 'var(--ink)' }}>Your story starts with a wallet.</h3><p style={{ color: 'var(--muted)' }}>Connect to view holdings, NFTs owned, level, XP, and seasonal position.</p></div><Button onClick={openWalletModal} icon="wallet">Connect wallet</Button></div> : <>
            <div className="identity-banner surface-card" style={{ marginTop: '32px', borderColor: 'var(--line)', background: 'var(--paper)' }}><div className="identity-mark">刃</div><div className="identity-copy"><span className="data-label">RONIN HOLDINGS / {wallet.isDemo ? 'DEMO' : 'CONNECTED'}</span><strong style={{ color: 'var(--ink)' }}>{wallet.shortAddress}</strong><small>{wallet.isDemo ? 'Profile values are UI fallback data, not a chain read.' : 'Live wallet connected · indexed data pending.'}</small></div><Tag tone={wallet.isDemo ? 'red' : 'green'}>{wallet.isDemo ? 'PREVIEW MODE' : 'CONNECTED'}</Tag></div>
            <div className="profile-stat-grid" style={{ borderColor: 'var(--line)' }}>
              <div className="profile-stat" style={{ background: 'var(--paper)', borderColor: 'var(--line)' }}><span>RONIN HOLDINGS</span><strong style={{ color: 'var(--ink)' }}>{typeof profile?.balance === 'number' ? formatCompact(profile.balance) : '2,450,000'}</strong><small>{profile?.isLive ? 'live Solana balance' : profile ? '$RONIN demo data' : 'awaiting read'}</small></div>
              <div className="profile-stat" style={{ background: 'var(--paper)', borderColor: 'var(--line)' }}><span>NFTS OWNED</span><strong style={{ color: 'var(--ink)' }}>{typeof profile?.nfts === 'number' ? profile.nfts : '4'}</strong><small>collectibles</small></div>
              <div className="profile-stat" style={{ background: 'var(--paper)', borderColor: 'var(--line)' }}><span>GAME LEVEL</span><strong style={{ color: 'var(--ink)' }}>{typeof profile?.level === 'number' ? profile.level : '28'}</strong><small>season one</small></div>
              <div className="profile-stat" style={{ background: 'var(--paper)', borderColor: 'var(--line)' }}><span>XP</span><strong style={{ color: 'var(--ink)' }}>{typeof profile?.xp === 'number' ? formatNumber(profile.xp) : '12,450'}</strong><small>total earned</small></div>
            </div>
            <div className="profile-bottom-grid">
              <div className="profile-panel" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}><div className="profile-panel-head"><div><Eyebrow>Achievements</Eyebrow><h3 style={{ color: 'var(--ink)' }}>{isDemoProfile ? `${profile.achievements} unlocked` : '12 unlocked'}</h3></div><Icon name="award" size={20} /></div><div className="achievement-row">{['First blood', 'Road walker', 'Forge keeper', 'Silent watch', 'Clan builder'].map((item, index) => <div className={`achievement ${index < 4 ? 'unlocked' : ''}`} key={item} style={{ color: 'var(--muted)' }}><span>{index < 4 ? <Icon name="check" size={12} /> : <Icon name="lock" size={11} />}</span><small>{item}</small></div>)}</div>
                <div style={{ marginTop: '20px', display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px', borderTop: '1px solid var(--line)', paddingTop: '14px' }}>
                  <div><span className="data-label">ACHIEVEMENTS</span><strong style={{ fontFamily: 'var(--display)', fontSize: '20px', display: 'block', marginTop: '6px', color: 'var(--ink)' }}>12</strong></div>
                  <div><span className="data-label">GLOBAL RANK</span><strong style={{ fontFamily: 'var(--display)', fontSize: '20px', display: 'block', marginTop: '6px', color: 'var(--ink)' }}>#241</strong></div>
                  <div><span className="data-label">SEASON RANK</span><strong style={{ fontFamily: 'var(--display)', fontSize: '20px', display: 'block', marginTop: '6px', color: 'var(--ink)' }}>#112</strong></div>
                </div>
              </div>
              <div className="profile-panel rank-panel" style={{ borderColor: 'var(--line)', background: 'var(--paper)' }}><div className="profile-panel-head"><div><Eyebrow>Season rank</Eyebrow><h3 style={{ color: 'var(--ink)' }}>{hasGameData ? `#${profile.seasonRank}` : '#184'}</h3></div><Icon name="trophy" size={20} /></div><ProgressBar value={hasGameData ? 64 : 64} label="Season progress" rightLabel="64%" tone="red" /><div className="rank-panel-foot" style={{ borderColor: 'var(--line)', color: 'var(--muted)' }}><span>Global <strong style={{ color: 'var(--ink)' }}>{hasGameData ? `#${profile.globalRank}` : '#742'}</strong></span><a href="#rank" style={{ color: 'var(--red)' }}>View rank system <Icon name="arrowRight" size={12} /></a></div></div>
            </div>
          </>}
        </div>
      </section>

      <section className="section updates-section enhanced-section">
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/hero-ronin.jpg')" }} />
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="section-row"><SectionHeading eyebrow="From the road" title="Keep your blade ready." text="Small releases. Public notes. No mystery about what is still being built." /><Button href="#transparency" variant="text" icon="arrowUpRight">Read the ledger</Button></div>
          <div className="updates-grid"><article className="update-card enhanced-card"><span className="update-date">SEASON 01 / PLANNING</span><h3>The first map is taking shape.</h3><p>Game systems are being designed around contribution, not extraction. More details will be shared before launch.</p><a href="#game-profile">Track your profile <Icon name="arrowRight" size={14} /></a></article><article className="update-card featured enhanced-card"><div className="update-image"><img src="/images/rank-warrior.jpg" alt="Ronin warrior portrait" /></div><div className="update-content"><span className="update-date">NOW / OPEN TO ALL</span><h3>Your rank starts here.</h3><p>Connect a wallet and see the data surfaces the clan is building toward.</p><a href="#rank">Enter the rank system <Icon name="arrowRight" size={14} /></a></div></article></div>
        </div>
      </section>
    </>
  )
}
