import { formatCompact, tokenomics } from '../data'
import { useWallet } from '../context/WalletContext'
import { Button, Eyebrow, PageHero, SectionHeading, StatCard, Tag } from '../components/Layout'

function formatUsd(num) {
  if (num == null || isNaN(num)) return '—'
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`
  return `$${Number(num).toFixed(2)}`
}

export default function Tokenomics() {
  const { tokenSupply, liveStats, liveStatsState } = useWallet()
  const supplyVal = liveStats?.supply?.amount || tokenSupply?.amount
  const totalSupply = supplyVal ? formatCompact(supplyVal) : liveStatsState === 'loading' ? '…' : '—'
  const burnedVal = liveStats?.burned
  const holdersVal = liveStats?.holdersCount
  const dex = liveStats?.dex

  return (
    <>
      <PageHero eyebrow="Tokenomics / 07" title="Tokenomics." titleAccent="A deliberate allocation." text={`Live on-chain: supply ${supplyVal ? formatCompact(supplyVal) : '…'} • burned ${burnedVal != null ? formatCompact(burnedVal) : '…'} • holders ${holdersVal ? formatCompact(holdersVal) : '…'} • ${dex?.priceUsd ? '$' + dex.priceUsd.toFixed(6) : 'price pending'} via ${dex?.dexId || 'DexScreener'}.`} image="/images/hero-ronin.jpg" className="tokenomics-hero" petals={false}>
        <div className="page-hero-ref-actions"><Tag tone="light">{liveStatsState === 'ready' ? `LIVE • ${new Date(liveStats.updatedAt).toLocaleTimeString()}` : 'Helius live'} • Planning configuration</Tag><Button href="#transparency" variant="outline" icon="arrowUpRight">Verify the principles</Button></div>
      </PageHero>

      <section className="section tokenomics-section enhanced-section">
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/hero-ronin.jpg')" }} />
        <div className="enhanced-ink">配分</div>
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="section-row"><SectionHeading eyebrow="Allocation / 001" title="Every piece has a purpose." text={`Live: ${supplyVal ? formatCompact(supplyVal) + ' supply' : 'supply pending'} • ${burnedVal != null ? formatCompact(burnedVal) + ' burned' : 'burn unavailable'} • ${dex?.marketCap ? formatUsd(dex.marketCap) + ' market cap' : ''}`} /><Tag tone="red">50 / 30 / 20 • LIVE</Tag></div>
          <div className="tokenomics-layout surface-card enhanced-card">
            <div className="donut-stage">
              <div className="donut-chart"><div className="donut-center"><span>$RONIN</span><strong>100%</strong><small>CREATOR ALLOCATION</small></div></div>
              <div className="donut-legend"><span><i className="legend-liquidity" /> Liquidity</span><span><i className="legend-burn" /> Buy & burn</span><span><i className="legend-dev" /> DEVELOPMENT</span></div>
              <div className="token-visual-side" style={{ marginTop: '28px', height: '220px' }}>
                <img src="/images/nft-legend.jpg" alt="Ronin allocation visual" />
                <div className="token-visual-side-overlay" />
              </div>
              <div style={{ marginTop: '16px', fontFamily: 'var(--mono)', fontSize: '9px', color: '#6b6560', letterSpacing: '.06em' }}>
                LIVE PRICE {dex?.priceUsd ? '$' + dex.priceUsd.toFixed(6) : '…'} • VOL 24H {dex?.volume24h ? formatUsd(dex.volume24h) : '…'} • LIQ {dex?.liquidityUsd ? formatUsd(dex.liquidityUsd) : '…'} • {dex?.dexId ? dex.dexId.toUpperCase() : 'DEX'} • HELIUS
              </div>
            </div>
            <div className="allocation-list">{tokenomics.map((item, index) => <article className="allocation-item" key={item.label}><div className="allocation-number" style={{ '--allocation-color': item.color }}>{String(index + 1).padStart(2, '0')}</div><div className="allocation-copy"><div className="allocation-title"><h3>{item.label}</h3><strong>{item.value}%</strong></div><p>{item.description}</p><div className="allocation-line"><span style={{ width: `${item.value}%`, background: item.color }} /></div></div></article>)}</div>
          </div>
        </div>
      </section>

      <section className="section section-cream token-metrics-section enhanced-section cream-enhanced">
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/game-landscape.jpg')" }} />
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="token-metrics-head"><div><Eyebrow>Supply at a glance</Eyebrow><h2 className="display-heading">Numbers should<br /><span>tell the truth.</span></h2></div><p>Live on-chain via Helius RPC + DexScreener. Burn and holder metrics appear only when verified by their live data sources.</p></div>
          <div className="token-metrics-grid">
            <StatCard stat={{ label: 'Total supply', value: totalSupply, detail: liveStats?.supply ? `Helius live • ${new Date(liveStats.supply.updatedAt).toLocaleTimeString()}` : tokenSupply ? 'Solana mainnet RPC' : 'RPC read pending', icon: 'coins' }} />
            <StatCard stat={{ label: 'Accumulated burned', value: burnedVal != null ? formatCompact(burnedVal) : liveStatsState === 'loading' ? '…' : '—', detail: burnedVal != null ? 'Global on-chain data' : liveStatsState === 'error' ? 'Global data unavailable' : 'Loading global data', icon: 'flame' }} />
            <StatCard stat={{ label: 'Holders', value: holdersVal ? formatCompact(holdersVal) : liveStatsState === 'loading' ? '…' : '—', detail: holdersVal ? 'Helius holders API live' : 'pending', icon: 'users' }} />
            <StatCard stat={{ label: 'Market cap', value: dex?.marketCap ? formatUsd(dex.marketCap) : dex?.fdv ? formatUsd(dex.fdv) : liveStatsState === 'loading' ? '…' : '—', detail: dex?.dexId ? `${dex.dexId} live via DexScreener` : 'DexScreener pending', icon: 'orbit' }} />
            <StatCard stat={{ label: '24h Volume', value: dex?.volume24h ? formatUsd(dex.volume24h) : liveStatsState === 'loading' ? '…' : '—', detail: dex ? `${dex.dexId} • $${dex.priceUsd?.toFixed(6) || ''}` : 'pending', icon: 'activity' }} />
            <StatCard stat={{ label: 'Liquidity', value: dex?.liquidityUsd ? formatUsd(dex.liquidityUsd) : liveStatsState === 'loading' ? '…' : '—', detail: dex?.pairAddress ? `${dex.pairAddress.slice(0,6)}...${dex.pairAddress.slice(-4)}` : 'pending', icon: 'chart' }} />
            <StatCard stat={{ label: 'Liquidity allocation', value: supplyVal ? '50%' : '—', detail: supplyVal ? `${formatCompact(supplyVal * .5)} $RONIN` : 'allocation pending', icon: 'chart' }} />
            <StatCard stat={{ label: 'Buy & burn allocation', value: supplyVal ? '30%' : '—', detail: supplyVal ? `${formatCompact(supplyVal * .3)} $RONIN` : 'allocation pending', icon: 'flame' }} />
          </div>
        </div>
      </section>

      <section className="section token-statement enhanced-section">
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/hero-ronin.jpg')" }} />
        <div className="enhanced-ink light">信念</div>
        <div className="container" style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="token-visual-side"><img src="/images/hero-ronin.jpg" alt="Ronin statement" /><div className="token-visual-side-overlay" /></div>
          <div className="statement-seal">信</div><Eyebrow>Clan principle</Eyebrow><h2>Every allocation is for the growth of the clan.</h2><p>Transparency. Sustainability. Long-term vision. No line item should ask for trust when it can show its work. Live: {supplyVal ? formatCompact(supplyVal) + ' supply' : ''} • {burnedVal != null ? formatCompact(burnedVal) + ' burned' : ''} • {dex?.priceUsd ? '$' + dex.priceUsd.toFixed(6) : ''} • {holdersVal ? formatCompact(holdersVal) + ' holders' : ''}</p><Button href="#transparency" variant="outline" icon="arrowUpRight">Open the ledger</Button>
        </div>
      </section>
    </>
  )
}
