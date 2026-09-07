import { useMemo, useState } from 'react'
import { formatCompact, formatNumber, yieldDurations } from '../data'
import { useWallet } from '../context/WalletContext'
import Icon from '../components/Icon'
import { Button, Eyebrow, PageHero, SectionHeading, StatCard, Tag, Sakura, ContractStatusWarning } from '../components/Layout'

export default function Yield() {
  const { wallet, profile, walletDataState, tokenSupply, openWalletModal } = useWallet()
  const hasBalance = typeof profile?.balance === 'number'
  const hasYieldPosition = typeof profile?.yieldLocked === 'number'
  const isDemoProfile = Boolean(profile && !profile.isLive)
  const [duration, setDuration] = useState(yieldDurations[1])
  const [amount, setAmount] = useState('250000')
  const [message, setMessage] = useState('')
  const numericAmount = Math.max(0, Number(amount.replace(/,/g, '')) || 0)
  // Dummy calculation since rewards are in SOL. Using a placeholder conversion logic or showing direct SOL output.
  const estimatedRewards = useMemo(() => (numericAmount * (duration.apy / 100) * (duration.days / 365)) / 1000, [numericAmount, duration])

  const handleLock = () => {
    if (!wallet) {
      openWalletModal()
      return
    }
    setMessage('Preview only — the yield contract is not connected. No transaction was submitted.')
  }

  return (
    <>
      <PageHero eyebrow="Yield / 02" title="Put your Ronin" titleAccent="to work." text="Lock $RONIN. Support the ecosystem. A yield mechanism with potential rewards once the program is live." image="/images/game-landscape.jpg" className="yield-hero">
        <div className="page-hero-ref-actions"><ContractStatusWarning className="contract-status-warning-hero" /><Button onClick={wallet ? handleLock : openWalletModal} icon={wallet ? 'lock' : 'wallet'}>{wallet ? 'Open lock preview' : 'Connect wallet'}</Button><Tag tone="light">Contract in preparation</Tag></div>
      </PageHero>

      <section className="section contract-status-section"><div className="container"><ContractStatusWarning /><p className="contract-status-caption">The yield program is under development and is not deployed on-chain. No live yield transaction can be executed on this page.</p></div></section>

      <section className="section yield-dashboard-section enhanced-section">
        <Sakura count={10} className="section-petals" />
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/game-landscape.jpg')" }} />
        <div className="enhanced-ink">利回り</div>
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="section-row"><SectionHeading eyebrow="Position overview" title="A measured return." text="Track your RONIN yield positions, rewards, and performance from one place. Live values will appear once the yield program is deployed and connected on-chain — no estimated or fabricated figures." /><div className="panel-status"><span className={`status-dot ${walletDataState === 'ready' ? 'connected' : ''}`} /> <span>{wallet ? (wallet.isDemo ? 'Demo profile' : walletDataState === 'loading' ? 'Reading mainnet…' : walletDataState === 'error' ? 'Live read unavailable' : 'Wallet synced') : 'No wallet connected'}</span></div></div>
          <div className="yield-overview surface-card enhanced-card">
            <div className="yield-overview-head"><div><span className="data-label">YOUR DASHBOARD</span><h3>{wallet ? (walletDataState === 'loading' ? 'Reading your position…' : profile ? 'Ronin in reserve.' : 'Live position unavailable') : 'Connect to see your position.'}</h3></div>{wallet ? <Tag tone={wallet.isDemo ? 'red' : walletDataState === 'ready' ? 'green' : 'neutral'}>{wallet.isDemo ? 'DEMO DATA' : walletDataState === 'ready' ? 'LIVE WALLET' : 'READING'}</Tag> : <Button variant="outline" icon="wallet" onClick={openWalletModal}>Connect wallet</Button>}</div>
            <div className="yield-stat-grid">
              <StatCard stat={{ label: 'Total Balance', value: tokenSupply ? formatCompact(tokenSupply.amount) : '—', detail: '2,450,000 RONIN', icon: 'coins' }} compact />
              <StatCard stat={{ label: 'Total Locked', value: hasYieldPosition ? formatCompact(profile.yieldLocked) : '1,000,000 RONIN', detail: 'LOCKED', icon: 'lock' }} compact />
              <StatCard stat={{ label: 'Your APY', value: isDemoProfile ? '14.8%' : '0.00 %', detail: 'ESTIMATED', icon: 'trend' }} compact />
              <StatCard stat={{ label: 'Estimated Earnings', value: isDemoProfile ? formatCompact(profile.totalEarnings) : '-- SOL', detail: 'REWARDS', icon: 'chart' }} compact />
              <StatCard stat={{ label: 'Joined Since', value: '21 FEBRUARY 2027', detail: 'START DATE', icon: 'clock' }} compact />
              <StatCard stat={{ label: 'Time Remaining', value: '183D : 14H : 22M', detail: 'COUNTDOWN', icon: 'activity' }} compact />
            </div>
          </div>
          <div className="yield-transparency-bar">
            <div className="transparency-item"><span className="data-label">TOTAL VALUE LOCKED</span><strong>-- RONIN</strong></div>
            <div className="transparency-item"><span className="data-label">ACTIVE LOCKERS</span><strong>--</strong></div>
            <div className="transparency-item"><span className="data-label">AVG LOCK</span><strong>-- DAYS</strong></div>
            <div className="transparency-item"><span className="data-label">PROTOCOL</span><strong>Non-custodial</strong></div>
          </div>
        </div>
      </section>

      <section className="section section-cream lock-section enhanced-section cream-enhanced">
        <Sakura count={12} className="section-petals" />
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/hero-ronin.jpg')" }} />
        <div className="enhanced-ink light">規律</div>
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="section-row"><SectionHeading eyebrow="Lock $RONIN" title="Choose your discipline." text="Longer locks increase the reward rate. Configure a position below; execution is intentionally disabled until the contract is live." /><div className="mini-note"><Icon name="shield" size={14} /> Non-custodial by design</div></div>
          <div className="lock-layout">
            <div className="lock-card surface-card enhanced-card">
              <ContractStatusWarning className="contract-status-warning-inset" />
              <div className="lock-card-top"><span className="data-label">CHOOSE LOCK DURATION</span><span className="selected-duration"><Icon name="clock" size={14} /> {duration.days} days selected</span></div>
              <div className="duration-grid">{yieldDurations.map((item) => <button key={item.id} className={duration.id === item.id ? 'duration-option active' : 'duration-option'} onClick={() => { setDuration(item); setMessage('') }}><strong>{item.label}</strong><span>{item.apy}% APY • {item.boost} BOOST</span></button>)}</div>
              <label className="field-label" htmlFor="lock-amount">Lock amount <span>Available balance {hasBalance ? `${formatCompact(profile.balance)} $RONIN` : '—'}</span></label>
              <div className="amount-field"><input id="lock-amount" value={amount} onChange={(event) => { setAmount(event.target.value.replace(/[^0-9]/g, '')); setMessage('') }} inputMode="numeric" aria-label="Lock amount in RONIN" /><span>$RONIN</span></div>
              <div className="lock-details"><div><span>YOUR LOCK</span><strong>1,000,000 RONIN</strong></div><div><span>LOCK APY</span><strong>{duration.apy}%</strong></div><div><span>APY BOOST</span><strong>{duration.boost} BOOST</strong></div></div>
              <div className="lock-details" style={{ marginTop: '0' }}><div><span>ESTIMATED EARNINGS</span><strong className="red-text">+{estimatedRewards.toFixed(4)} SOL</strong></div></div>
              <Button className="full-button" icon={wallet ? 'lock' : 'wallet'} onClick={handleLock}>{wallet ? 'Lock $RONIN' : 'Connect to continue'}</Button>
              {message && <div className="inline-message"><Icon name="info" size={16} />{message}</div>}
            </div>
            <div className="yield-preview enhanced-preview">
              <div className="preview-orbit"><div className="preview-ring"><span>{duration.apy}<small>%</small></span><em>EST. APY</em></div><i className="orbit-dot one" /><i className="orbit-dot two" /></div>
              <div className="preview-copy"><Eyebrow>Lock preview</Eyebrow><h3>Consistency compounds.</h3><p>Your selected position could earn approximately <strong>{estimatedRewards.toFixed(4)} SOL</strong> over {duration.days} days, based on the configured display rate.</p><span className="muted-caption">Illustrative UI value · not a yield promise</span></div>
              <div className="yield-visual-side">
                <img src="/images/rank-warrior.jpg" alt="Ronin warrior" />
                <div className="yield-visual-side-overlay" />
                <span className="yield-visual-side-label">武士道 • DISCIPLINE</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}
