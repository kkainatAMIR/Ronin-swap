import { timeline, formatCompact } from '../data'
import { useWallet } from '../context/WalletContext'
import Icon from '../components/Icon'
import { Button, Eyebrow, Sakura, SectionHeading } from '../components/Layout'
import { BuyRoninButton } from '../components/BuyRonin'

const ecosystemCards = [
  { number: '01', title: 'Put your Ronin to work.', label: 'Yield', text: 'Lock with intention. A yield mechanism with potential rewards as the clan grows.', route: 'yield', icon: 'lock', image: '/images/game-landscape.jpg' },
  { number: '02', title: 'Feed the forge.', label: 'Burn', text: 'Permanent scarcity, made visible. See every mark left on-chain.', route: 'burn', icon: 'flame', image: '/images/forge.jpg' },
  { number: '03', title: 'Make your name.', label: 'Game', text: 'Quests, XP, and seasonal proof for those who walk the road.', route: 'game', icon: 'sword', image: '/images/game-landscape.jpg' },
  { number: '04', title: 'Carry the legend.', label: 'NFT', text: 'Collect a visual identity for the warrior you choose to become.', route: 'nft', icon: 'shield', image: '/images/nft-legend.jpg' },
]

function formatUsd(num) {
  if (num == null || isNaN(num)) return '—'
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`
  return `$${Number(num).toFixed(2)}`
}

export default function Home() {
  const { openWalletModal, tokenSupply, liveStats, liveStatsState } = useWallet()

  const supplyVal = liveStats?.supply?.amount ?? tokenSupply?.amount
  const holdersVal = liveStats?.holdersCount
  const burnedVal = liveStats?.burned
  const dex = liveStats?.dex

  const refStats = [
    { label: 'TOTAL RONIN', value: supplyVal != null ? formatCompact(supplyVal) : liveStatsState === 'loading' ? '…' : '—', icon: 'coins', detail: 'live supply' },
    { label: 'HOLDERS', value: holdersVal != null ? formatCompact(holdersVal) : liveStatsState === 'loading' ? '…' : '—', icon: 'users', detail: holdersVal != null ? 'Indexed live' : 'RPC pending' },
    { label: '24H VOLUME', value: dex?.volume24h != null ? formatUsd(dex.volume24h) : liveStatsState === 'loading' ? '…' : '—', icon: 'activity', detail: dex ? 'DexScreener live' : 'pending' },
    { label: 'ACCUMULATED BURNED', value: burnedVal != null ? formatCompact(burnedVal) : liveStatsState === 'loading' ? '…' : '—', icon: 'flame', detail: burnedVal != null ? 'global on-chain' : liveStatsState === 'error' ? 'global data unavailable' : 'loading global data' },
    { label: 'MARKET CAP', value: dex?.marketCap != null ? formatUsd(dex.marketCap) : dex?.fdv != null ? formatUsd(dex.fdv) : liveStatsState === 'loading' ? '…' : '—', icon: 'orbit', detail: dex?.dexId ? `${dex.dexId} live` : dex ? 'dex live' : 'pending' },
  ]

  return (
    <>
      <section className="home-hero-ref">
        <div className="home-hero-ref-bg" aria-hidden="true">
          <img src="/images/hero-ronin.jpg" alt="" />
          <div className="home-hero-ref-overlay" />
        </div>
        <Sakura count={18} className="hero-ref-petals wind-strong" />
        <div className="home-hero-ref-inner">
          <h1 className="ref-title">
            <span className="ref-title-black">RUGGED.</span>
            <span className="ref-title-red">BUT WE RISE.</span>
          </h1>
          <p className="ref-subtitle">THE MASTERLESS SAMURAI.</p>
          <p className="ref-desc">
            Built by the community.<br />
            Backed by the ronin.
          </p>
          <div className="ref-actions">
            <BuyRoninButton className="btn btn-primary ref-btn-primary">BUY $RONIN</BuyRoninButton>
            <a className="btn btn-outline ref-btn-outline" href="#yield">EXPLORE ECOSYSTEM</a>
          </div>
          <p style={{ margin: '8px 0 0', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: '9px', lineHeight: 1.4, color: 'rgba(255,255,255,.58)', letterSpacing: '.03em' }}>
            0.5% protocol fee applies. This fee supports the RONIN protocol and ecosystem development.
          </p>
          <button className="ref-connect" onClick={openWalletModal}>CONNECT WALLET</button>
          {liveStatsState === 'ready' && liveStats?.updatedAt && (
            <div style={{ marginTop: '14px', fontFamily: 'var(--mono)', fontSize: '8px', color: '#6b6560', letterSpacing: '.08em' }}>
              LIVE • SUPPLY {supplyVal != null ? formatCompact(supplyVal) : ''} • {dex?.dexId ? `${(dex.dexId || '').toUpperCase()} $${dex.priceUsd?.toFixed(6) || ''}` : dex ? `DEX $${dex.priceUsd?.toFixed(6) || ''}` : 'DEX PENDING'} • {new Date(liveStats.updatedAt).toLocaleTimeString()}
            </div>
          )}
        </div>
        <div className="ref-stats-wrap">
          <div className="ref-stats-card">
            {refStats.map((stat) => (
              <div className="ref-stat" key={stat.label}>
                <span className="ref-stat-icon"><Icon name={stat.icon} size={16} /></span>
                <span className="ref-stat-label">{stat.label}</span>
                <span className="ref-stat-value">{stat.value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="story-ref-section" id="story">
        <Sakura count={12} className="story-bg-petals" />
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/game-landscape.jpg')", opacity: .04, position: 'absolute', inset: 0, backgroundSize: 'cover', pointerEvents: 'none' }} />
        <div className="story-ref-container">
          <div className="story-ref-grid">
            <div className="story-ref-card story-ref-story">
              <Sakura count={6} className="card-petals" />
              <h3 className="story-ref-heading">OUR STORY</h3>
              <div className="story-ref-text">
                <p><strong>$RONIN</strong> wasn't created in a boardroom.<br />It was forged by a community that believed in<br />respect on the road to glory.</p>
                <p>Born on promise. Built through real time.<br />Accountability in balance with strength.</p>
                <p>We believe that real change starts with action.<br />No insiders. No team pre-mine. No shortcuts.<br />Just a shared vision.</p>
                <p>Just a community vision.<br />A new economy. A system redesigned.<br />Every ronin is a guardian of the belief that<br />being masterless  doesn't mean walking alone.</p>
                <p className="story-ref-red">NO MASTER. ONE COMMUNITY. $RONIN.</p>
              </div>
            </div>
            <div className="story-ref-card story-ref-journey">
              <Sakura count={8} className="card-petals journey-petals" />
              <h3 className="story-ref-heading">THE JOURNEY SO FAR</h3>
              <div className="journey-ref-layout">
                <div className="journey-ref-timeline"><div className="journey-ref-line" />{timeline.map((item) => <div className="journey-ref-item" key={item.date}><span className="journey-ref-dot" /><div className="journey-ref-content"><span className="journey-ref-day">{item.date.toUpperCase()}</span><strong>{item.title}</strong></div></div>)}</div>
                <div className="journey-ref-highlight"><div className="journey-ref-highlight-box"><span className="journey-ref-highlight-day">AUG 27</span><strong className="journey-ref-highlight-value" style={{ fontSize: '24px' }}>BUILT BEYOND<br /><span>THE TOKEN</span></strong><div className="journey-ref-highlight-list no-bullets"><span>MILESTONES</span><ul><li>⚔ NFT ARTIST DEAL SECURED</li><li>🔥 44.6M $RONIN IN BURN WALLET</li><li>🌐 OFFICIAL WEBSITE LIVE</li><li>🛡 RONIN SHIELD BUILT</li><li>🔥 RONIN BURN BUILT</li><li>💰 BUY RONIN INTEGRATION BUILT</li><li>🖼 NFT SECTION BUILT</li><li>⚔ YIELD &amp; GAME SECTIONS BUILT</li><li>🌑 ECOSYSTEM EXPANDING</li></ul></div></div></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="ecosystem-section section section-tight enhanced-section">
        <Sakura count={14} className="section-petals" />
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/hero-ronin.jpg')" }} />
        <div className="enhanced-ink">浪人</div>
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="section-row"><SectionHeading eyebrow="The ecosystem" title="Choose your discipline." text="There is no single way to be a Ronin. Find the part of the road that calls to you." /><Button href="#rank" variant="outline" icon="arrowRight">See the ranks</Button></div>
          <div className="ecosystem-grid">{ecosystemCards.map((card) => <a className="ecosystem-card enhanced-card" href={`#${card.route}`} key={card.route} style={{ overflow: 'hidden' }}><div className="ecosystem-visual" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '92px', overflow: 'hidden', opacity: .18 }}><img src={card.image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'saturate(1.2)' }} /><div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(0deg, #fff 10%, transparent 80%)' }} /></div><div className="ecosystem-card-top" style={{ position: 'relative', zIndex: 1 }}><span>{card.number}</span><span className="round-icon"><Icon name={card.icon} size={18} /></span></div><div style={{ position: 'relative', zIndex: 1, marginTop: '38px' }}><Eyebrow>{card.label}</Eyebrow><h3>{card.title}</h3><p>{card.text}</p></div><span className="card-arrow"><Icon name="arrowUpRight" size={16} /></span></a>)}</div>
        </div>
      </section>

      <section className="manifesto-section enhanced-manifesto"><div className="manifesto-backdrop" /><Sakura count={16} className="manifesto-petals wind-strong" /><div className="container manifesto-content"><div style={{ display: 'flex', gap: '20px', alignItems: 'center', marginBottom: '12px' }}><span style={{ width: '40px', height: '1px', background: '#e8b4b1' }} /><Eyebrow>$RONIN / 001</Eyebrow></div><h2>Respect the road.<br /><em>Rewrite the ending.</em></h2><p>Everything we build starts with a simple idea: the future belongs to those willing to walk toward it together.</p><div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}><Button href="#transparency" variant="light" icon="arrowUpRight">Verify the movement</Button><a className="btn btn-outline" href="#story" style={{ borderColor: 'rgba(255,255,255,.18)', color: '#f5f1e9', background: 'rgba(255,255,255,.06)' }}>OUR STORY</a></div><div style={{ marginTop: '32px', display: 'flex', gap: '24px', fontFamily: 'var(--mono)', fontSize: '9px', color: '#a8a19a', letterSpacing: '.08em' }}><span>NO MASTER • ONE COMMUNITY</span><span style={{ color: '#e8b4b1' }}>•</span><span>BUILT ON SOLANA • HELIUS LIVE</span></div></div></section>
    </>
  )
}
