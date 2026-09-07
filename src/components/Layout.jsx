import { useEffect, useState } from 'react'
import { formatCompact, getCurrentRank, navItems, RONIN_MINT, RONIN_TOKEN_URL } from '../data'
import { useWallet } from '../context/WalletContext'
import Icon from './Icon'
import BuyRonin from './BuyRonin'

export function RoninMark({ compact = false }) {
  return (
    <span className={`brand ${compact ? 'brand-compact' : ''}`}>
      <span className="brand-seal" aria-hidden="true"><span>浪</span></span>
      <span className="brand-copy"><strong>RONIN</strong>{!compact && <small>THE MASTERLESS SAMURAI</small>}</span>
    </span>
  )
}

// Shared wallet-safety reminder. Rendered on every page where a wallet
// signature can be requested (Buy, Burn/Forge, Shield guidance). It states a
// caution, never a guarantee: users are told to verify, not told they are safe.
export function ContractVerifyNote({ compact = false, className = '' }) {
  return (
    <div className={`contract-verify-note ${compact ? 'contract-verify-note-compact' : ''} ${className}`}>
      <Icon name="shield" size={compact ? 13 : 15} />
      <div>
        <strong>Always verify the official contract address before signing.</strong>
        <span className="contract-verify-note-address">
          Official $RONIN contract: <code>{RONIN_MINT}</code>
          <a href={RONIN_TOKEN_URL} target="_blank" rel="noreferrer">Verify on Solscan <Icon name="external" size={10} /></a>
        </span>
      </div>
    </div>
  )
}

// Status banner for features whose contracts are not deployed yet (Yield,
// NFT purchase). Rendered before the user can interact with the feature so
// nobody mistakes the UI for a live, executable program.
export function ContractStatusWarning({ className = '' }) {
  return (
    <div className={`contract-status-warning ${className}`} role="status">
      <span className="contract-status-warning-dot" aria-hidden="true" />
      NOT LIVE — CONTRACT IN DEVELOPMENT
    </div>
  )
}

export function Button({ children, variant = 'primary', icon = 'arrowUpRight', className = '', href, onClick, type = 'button', disabled = false }) {
  const classes = `btn btn-${variant} ${className}`
  if (href) {
    return <a className={classes} href={href} onClick={onClick}>{children}{icon && <Icon name={icon} size={15} />}</a>
  }
  return <button className={classes} type={type} onClick={onClick} disabled={disabled}>{children}{icon && <Icon name={icon} size={15} />}</button>
}

export function Eyebrow({ children, icon }) {
  return <div className="eyebrow">{icon && <Icon name={icon} size={13} />}{children}</div>
}

export function SectionHeading({ eyebrow, title, text, align = 'left', dark = false, children }) {
  return (
    <div className={`section-heading align-${align} ${dark ? 'heading-dark' : ''}`}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="section-title">{title}</h2>
      {text && <p className="section-copy">{text}</p>}
      {children}
    </div>
  )
}

export function StatCard({ stat, compact = false }) {
  return (
    <div className={`stat-card ${compact ? 'stat-card-compact' : ''}`}>
      {stat.icon && <span className="stat-icon"><Icon name={stat.icon} size={16} /></span>}
      <div className="stat-label">{stat.label}</div>
      <div className="stat-value">{stat.value}</div>
      {stat.detail && <div className="stat-detail">{stat.detail}</div>}
      {stat.suffix && <div className="stat-detail">{stat.suffix}</div>}
    </div>
  )
}

export function ProgressBar({ value = 0, label, rightLabel, tone = 'red' }) {
  return (
    <div className="progress-wrap">
      {(label || rightLabel) && <div className="progress-meta"><span>{label}</span><strong>{rightLabel || `${value}%`}</strong></div>}
      <div className="progress-track"><span className={`progress-fill ${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>
    </div>
  )
}

export function Tag({ children, tone = 'neutral' }) {
  return <span className={`tag tag-${tone}`}>{children}</span>
}

export function PageHero({ eyebrow, title, titleAccent, text, image, className = '', children, dark = false, petals = true }) {
  return (
    <section className={`page-hero-ref ${dark ? 'dark' : ''} ${className}`}>
      <div className="page-hero-ref-bg" aria-hidden="true">
        {image ? <img src={image} alt="" /> : <div className="page-hero-ref-bg-fallback" />}
        <div className="page-hero-ref-overlay" />
      </div>

      {petals && <Sakura count={16} className="page-hero-petals wind-strong" />}

      <div className="page-hero-ref-inner">
        <div className="page-hero-ref-content">
          {eyebrow && <div className="page-hero-ref-kicker"><Eyebrow>{eyebrow}</Eyebrow></div>}
          <h1 className="page-title-ref">
            <span>{title}</span>
            {titleAccent && <em>{titleAccent}</em>}
          </h1>
          {text && <p className="page-hero-ref-text">{text}</p>}
          {children && <div className="page-hero-ref-actions">{children}</div>}
        </div>
      </div>

      <div className="page-hero-ref-stamp" aria-hidden="true"><span>RONIN</span><b>浪</b><small>THE WAY</small></div>
    </section>
  )
}

export function Sakura({ count = 5, className = '' }) {
  return (
    <div className={`sakura ${className}`} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <i key={index} style={{ '--i': index, left: `${8 + (index * 23) % 88}%`, top: `${-10 + (index * 17) % 30}%`, animationDelay: `${index * -1.2}s`, animationDuration: `${7 + (index % 5) * 1.8}s` }} />)}
    </div>
  )
}

function WalletButton({ onClick }) {
  const { wallet } = useWallet()
  if (wallet) {
    return (
      <button className="wallet-pill" onClick={onClick} aria-label="Open wallet details">
        <span className={`wallet-dot ${wallet.isDemo ? 'demo' : ''}`} />
        <span>{wallet.shortAddress}</span>
        {wallet.isDemo && <small style={{ padding: '2px 4px', border: '1px solid var(--red-soft)', borderRadius: '3px', color: 'var(--red)', fontSize: '7px' }}>DEMO</small>}
        <Icon name="chevronDown" size={14} />
      </button>
    )
  }
  return <Button className="connect-button" icon="wallet" onClick={onClick}>Connect wallet</Button>
}

export function Header({ route }) {
  const { openWalletModal } = useWallet()
  const [open, setOpen] = useState(false)

  useEffect(() => setOpen(false), [route])

  const navigate = (event, id) => {
    event.preventDefault()
    window.location.hash = id
    setOpen(false)
  }

  return (
    <header className="site-header">
      <div className="nav-shell">
        <a href="#home" onClick={(event) => navigate(event, 'home')} aria-label="Ronin home"><RoninMark /></a>
        <nav className={`nav-links ${open ? 'is-open' : ''}`} aria-label="Primary navigation">
          {navItems.map((item) => <a key={item.id} className={route === item.id ? 'active' : ''} href={`#${item.id}`} onClick={(event) => navigate(event, item.id)}>{item.label}</a>)}
          <div className="mobile-wallet"><WalletButton onClick={openWalletModal} /></div>
        </nav>
        <div className="nav-actions"><WalletButton onClick={openWalletModal} /><button className="menu-toggle" onClick={() => setOpen((value) => !value)} aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open}><Icon name={open ? 'close' : 'menu'} size={20} /></button></div>
      </div>
    </header>
  )
}

function WalletModal() {
  const { wallet, profile, connectionState, walletDataState, walletDataError, lastUpdated, error, hasSolanaProvider, isMobileDevice, walletModalOpen, closeWalletModal, connectDemo, connectWallet, disconnect } = useWallet()
  const currentRank = getCurrentRank(profile)
  const liveBalance = profile && typeof profile.balance === 'number' ? formatCompact(profile.balance) : walletDataState === 'loading' ? '…' : '—'
  if (!walletModalOpen) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeWalletModal() }}>
      <div className="modal wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-dialog-title">
        <button className="modal-close" onClick={closeWalletModal} aria-label="Close wallet dialog"><Icon name="close" size={16} /></button>
        <div className="modal-kicker"><span className="status-dot" /> RONIN WALLET</div>
        {wallet ? (
          <>
            <h2 id="wallet-dialog-title">Your place in the clan.</h2>
            <div className="connected-card">
              <div className="connected-avatar">浪</div>
              <div><span className="data-label">{wallet.isDemo ? 'Demo wallet' : 'Connected wallet'}</span><strong style={{ fontFamily: 'var(--mono)', fontSize: '11px' }}>{wallet.shortAddress}</strong><small style={{ fontSize: '8px', color: 'var(--muted-light)' }}>{wallet.provider}</small></div>
              <Tag tone={wallet.isDemo ? 'red' : 'green'}>{wallet.isDemo ? 'UI PREVIEW' : 'CONNECTED'}</Tag>
            </div>
            <div className="wallet-preview-stats">
              <div><span>RONIN BALANCE</span><strong>{liveBalance}</strong></div>
              <div><span>CLAN RANK</span><strong>{currentRank ? currentRank.name.toUpperCase() : walletDataState === 'loading' ? 'READING' : 'PENDING'}</strong></div>
              <div><span>NFTS</span><strong>{typeof profile?.nfts === 'number' ? profile.nfts : '—'}</strong></div>
            </div>
            {!wallet.isDemo && <div className={`notice-box ${walletDataState === 'error' ? 'notice-box-error' : ''}`}><Icon name={walletDataState === 'error' ? 'info' : 'check'} size={16} /><span>{walletDataState === 'error' ? `${walletDataError} Check your RPC configuration and try again.` : `Live $RONIN balance is read from Solana mainnet RPC${lastUpdated ? ` · updated ${new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' · reading now'}. Rank is based on the token holding.`}</span></div>}
            <Button variant="outline" icon="close" onClick={disconnect}>Disconnect wallet</Button>
          </>
        ) : (
          <>
            <h2 id="wallet-dialog-title">Enter the clan.</h2>
            <p className="modal-lead">Connect a Solana wallet to unlock your Ronin identity, rank progress, and ecosystem position.</p>
            <div className="wallet-benefits">
              <span><Icon name="shield" size={16} /> Your holdings</span>
              <span><Icon name="trophy" size={16} /> Your rank</span>
              <span><Icon name="gamepad" size={16} /> Your progress</span>
            </div>
            <Button icon="wallet" onClick={connectWallet} disabled={(!hasSolanaProvider && !isMobileDevice) || connectionState === 'connecting'}>
              {connectionState === 'connecting' ? 'Connecting…' : (isMobileDevice && !hasSolanaProvider ? 'Open in Phantom' : 'Connect Solana wallet')}
            </Button>
            {!hasSolanaProvider && !isMobileDevice && <p className="wallet-hint">No browser wallet detected. Use the preview profile to explore the connected experience, or install Phantom to connect a real wallet.</p>}
            {!hasSolanaProvider && isMobileDevice && <p className="wallet-hint" style={{ color: 'var(--ink)' }}>Tap above to securely open the RONIN ecosystem inside the Phantom mobile app.</p>}
            {error && <div className="error-box"><Icon name="info" size={16} /><span>{error}</span></div>}
          </>
        )}
      </div>
    </div>
  )
}

export function Footer({ onNavigate }) {
  const go = (event, route) => {
    event.preventDefault()
    onNavigate(route)
  }
  return (
    <footer className="site-footer">
      <Sakura count={8} className="footer-petals wind-strong" />
      <div className="footer-top container">
        <div className="footer-brand">
          <RoninMark />
          <p>Forged by the community.<br />Backed by the ronin.<br /><br />$RONIN — The Masterless Samurai.<br />Built in public, verified on-chain.<br /><a href="https://roninsamurai.com" target="_blank" rel="noreferrer">RoninSamurai.com</a><br /><a href="mailto:info@roninsamurai.com">info@roninsamurai.com</a></p>
          <div className="footer-company">
            <span>MASTERLESS DIGITAL LIMITED</span>
            <span>Company No. 81168671</span>
            <span>SUITE 1701-02, 17/F. 308</span>
            <span>CENTRAL DES VOEUX 308 DES</span>
            <span>VOEUX RD CENTRAL</span>
            <span>HONG KONG</span>
          </div>
        </div>
        <div className="footer-nav"><span className="footer-label">Explore</span>{navItems.map((item) => <a key={item.id} href={`#${item.id}`} onClick={(event) => go(event, item.id)}>{item.label}</a>)}</div>
        <div className="footer-community"><span className="footer-label">Join the clan</span><div className="social-links"><a href="https://x.com" target="_blank" rel="noreferrer" aria-label="X / Twitter"><span>𝕏</span></a><a href="https://discord.com" target="_blank" rel="noreferrer" aria-label="Discord"><Icon name="discord" size={17} /></a><a href="https://t.me/RONIN_SamuraiTG" target="_blank" rel="noreferrer" aria-label="Telegram"><Icon name="telegram" size={17} /></a></div><p>Announcements, expeditions,<br />and the next mark in the stone.</p></div>
      </div>
      <div className="footer-bottom container"><span>© {new Date().getFullYear()} $RONIN — The Masterless Samurai. All rights reserved.</span><span>Built in public <i /> No hidden control.</span><span>$RONIN / Solana</span></div>
    </footer>
  )
}

export function AppChrome({ route, children, onNavigate }) {
  const { notice, walletModalOpen } = useWallet()
  return (
    <div className={`app-shell app-route-${route}`}>
      <Header route={route} />
      <main className="page-transition" key={route}>{children}</main>
      <Footer onNavigate={onNavigate} />
      <WalletModal />
      <BuyRonin />
      {notice && !walletModalOpen && <div className="toast"><Icon name="check" size={16} /><span>{notice}</span></div>}
    </div>
  )
}
