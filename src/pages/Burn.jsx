import { useEffect, useMemo, useState } from 'react'
import { VersionedTransaction } from '@solana/web3.js'
import { useWallet, getSolanaProvider } from '../context/WalletContext'
import { sendSignedSolanaTransaction, confirmSolanaTransaction } from '../services/roninService'
import {
  getBurnPreview,
  buildBurnTransaction,
  decodeBase58Transaction,
  solscanTxUrl,
  toRawUnits,
  rawUnitsToUiAmount,
  BurnApiError,
} from '../services/burnService'
import { RONIN_TOKEN_URL, formatCompact, formatNumber } from '../data'
import Icon from '../components/Icon'
import { Button, Eyebrow, PageHero, SectionHeading, StatCard, Tag, Sakura, ContractVerifyNote } from '../components/Layout'

const CONFIRM_TIMEOUT_MS = 90_000
const PRESETS = ['10%', '25%', '50%', 'MAX']

// Converts raw atomic units back into an exact decimal string (no float
// math), so preset buttons never lose precision on the round trip through
// toRawUnits() when the burn is actually submitted.
function rawToExactString(raw, decimals) {
  let value = raw < 0n ? -raw : raw
  const digits = value.toString().padStart(decimals + 1, '0')
  const intPart = digits.slice(0, digits.length - decimals) || '0'
  const fracPart = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, '') : ''
  return `${raw < 0n ? '-' : ''}${intPart}${fracPart ? `.${fracPart}` : ''}`
}

function formatRoninAmount(amount) {
  if (amount == null || !Number.isFinite(amount)) return '—'
  if (amount === 0) return '0'
  if (Math.abs(amount) >= 1000) return formatNumber(Math.round(amount))
  return amount.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

function shortAddr(address = '') {
  if (!address || address.length <= 10) return address || '—'
  return `${address.slice(0, 4)}...${address.slice(-4)}`
}

function shortSig(sig = '') {
  if (!sig || sig.length <= 16) return sig || '—'
  return `${sig.slice(0, 8)}…${sig.slice(-8)}`
}

function lamportsToSol(lamports) {
  if (lamports == null || !Number.isFinite(Number(lamports))) return null
  return Number(lamports) / 1_000_000_000
}

function friendlyBurnError(error) {
  if (!error) return 'Something went wrong. Please try again.'
  const message = error?.message || String(error)

  if (/user rejected|rejected the request|4001/i.test(message)) {
    return 'You rejected the request in Phantom.'
  }
  if (error instanceof BurnApiError) {
    return message
  }
  if (/insufficient/i.test(message)) {
    return 'Insufficient RONIN balance.'
  }
  if (/blockhash not found|timeout|timed out/i.test(message)) {
    return 'The transaction took too long to confirm. Check Solscan before retrying — it may have still landed.'
  }
  if (/simulation failed|failed to simulate/i.test(message)) {
    return 'The burn transaction failed simulation. Please try again.'
  }
  if (/transaction failed/i.test(message)) {
    return message
  }
  if (/failed to fetch|network/i.test(message)) {
    return 'Network error. Check your connection and try again.'
  }
  return message
}

export default function Burn() {
  const {
    wallet,
    profile,
    connectionState,
    liveStats,
    liveStatsState,
    hasSolanaProvider,
    openWalletModal,
    refreshWalletData,
    refreshLiveStats,
  } = useWallet()

  const [amount, setAmount] = useState('')
  const [preset, setPreset] = useState('')
  const [formError, setFormError] = useState('')

  // phase drives the confirm/result modal: idle -> previewing (no modal yet)
  // -> confirm -> signing -> confirming -> updating -> success | failed
  const [phase, setPhase] = useState('idle')
  const [previewData, setPreviewData] = useState(null)
  const [txError, setTxError] = useState('')
  const [txSignature, setTxSignature] = useState('')
  const [burnedAmountUi, setBurnedAmountUi] = useState(null)

  const [historyState, setHistoryState] = useState('idle')
  const [historyEvents, setHistoryEvents] = useState([])
  const [historyMeta, setHistoryMeta] = useState(null)

  const isConnected = Boolean(wallet && !wallet.isDemo)
  const decimals = profile?.decimals ?? 6
  const balance = typeof profile?.balance === 'number' ? profile.balance : null
  const numericAmount = Number(amount)
  const hasValidNumericAmount = amount.trim() !== '' && Number.isFinite(numericAmount) && numericAmount > 0
  const exceedsBalance = hasValidNumericAmount && balance != null && numericAmount > balance

  const fieldError = useMemo(() => {
    if (amount.trim() !== '' && !hasValidNumericAmount) return 'Enter a valid amount.'
    if (exceedsBalance) return 'Insufficient RONIN balance.'
    return ''
  }, [amount, hasValidNumericAmount, exceedsBalance])

  const burnedLive = liveStats?.burned
  const supplyLive = liveStats?.supply?.amount

  const modalOpen = ['confirm', 'signing', 'confirming', 'updating', 'success', 'failed'].includes(phase)

  // The burn ledger uses the same backend response as the accumulated global
  // total. It never performs a second wallet-scoped calculation in the UI.
  useEffect(() => {
    if (liveStatsState === 'loading' && !liveStats) {
      setHistoryState('loading')
      return
    }
    if (liveStatsState === 'error' || !liveStats) {
      setHistoryState('error')
      setHistoryEvents([])
      setHistoryMeta(null)
      return
    }
    setHistoryEvents(liveStats.burnHistory || [])
    setHistoryMeta({ source: liveStats.source, scanned: liveStats.burnHistory?.length || 0 })
    setHistoryState('ready')
  }, [liveStats, liveStatsState])

  // If the wallet disconnects mid-flow, fall back to idle instead of leaving
  // a stale confirm/result modal open.
  useEffect(() => {
    if (!wallet && phase !== 'idle') {
      setPhase('idle')
      setPreviewData(null)
      setTxError('')
      setTxSignature('')
    }
  }, [wallet, phase])

  const choosePreset = (key) => {
    if (!profile?.rawBalance || balance == null || balance <= 0) return
    const rawBalance = BigInt(profile.rawBalance)
    let raw
    if (key === 'MAX') {
      raw = rawBalance
    } else {
      const pct = BigInt(key.replace('%', ''))
      raw = (rawBalance * pct) / 100n
    }
    setPreset(key)
    setAmount(rawToExactString(raw, decimals))
    setFormError('')
  }

  const handleAmountChange = (event) => {
    const raw = event.target.value.replace(/[^0-9.]/g, '')
    const parts = raw.split('.')
    const cleaned = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : raw
    setAmount(cleaned)
    setPreset('')
    setFormError('')
  }

  const primaryDisabled = () => {
    if (!isConnected) return connectionState === 'connecting'
    if (balance == null) return true
    if (balance === 0) return true
    if (!hasValidNumericAmount || exceedsBalance) return true
    if (phase !== 'idle') return true
    return false
  }

  const primaryLabel = () => {
    if (!isConnected) return connectionState === 'connecting' ? 'CHECKING WALLET...' : 'CONNECT WALLET'
    if (phase === 'previewing') return 'PREPARING BURN...'
    return 'BURN RONIN'
  }

  const runPreview = async () => {
    setFormError('')
    setPhase('previewing')
    try {
      const rawUnits = toRawUnits(amount, decimals)
      if (rawUnits <= 0n) throw new Error('Enter a valid amount.')
      const preview = await getBurnPreview({ userPublicKey: wallet.address, burnAmountRaw: rawUnits })
      setPreviewData({ ...preview, rawUnits, uiAmount: rawUnitsToUiAmount(rawUnits, decimals) })
      setPhase('confirm')
    } catch (error) {
      console.error('RONIN burn preview failed', error)
      setPhase('idle')
      setFormError(friendlyBurnError(error))
    }
  }

  const handlePrimaryAction = () => {
    if (!isConnected) {
      openWalletModal()
      return
    }
    if (primaryDisabled()) return
    runPreview()
  }

  const closeModal = () => {
    if (phase === 'signing' || phase === 'confirming' || phase === 'updating') return
    if (phase === 'success') {
      setAmount('')
      setPreset('')
    }
    setPhase('idle')
    setPreviewData(null)
    setTxError('')
    setTxSignature('')
  }

  const retryBurn = () => {
    setTxError('')
    setTxSignature('')
    setPreviewData(null)
    runPreview()
  }

  const executeBurn = async () => {
    if (!previewData) return
    const provider = getSolanaProvider()
    if (!provider) {
      setPhase('failed')
      setTxError('Phantom wallet was not found. Please install Phantom to continue.')
      return
    }

    setTxError('')
    setPhase('signing')

    try {
      // 1. Ask the RONIN backend (which holds the Sol Incinerator key) to
      // build the burn transaction for this exact wallet + amount.
      const built = await buildBurnTransaction({ userPublicKey: wallet.address, burnAmountRaw: previewData.rawUnits })
      const txBytes = decodeBase58Transaction(built.serializedTransaction)
      const transaction = VersionedTransaction.deserialize(txBytes)

      // 2. Hand to Phantom for approval. This is the only point in the flow
      // where a signature is requested.
      let signature
      if (typeof provider.signAndSendTransaction === 'function') {
        const result = await provider.signAndSendTransaction(transaction)
        signature = result?.signature || result
      } else {
        const signed = await provider.signTransaction(transaction)
        signature = await sendSignedSolanaTransaction(signed.serialize())
      }

      setPhase('confirming')
      setTxSignature(signature)

      // 3. Confirm on-chain through the same server-side RPC path. Success is
      // never shown before the signed transaction is confirmed.
      const confirmation = await Promise.race([
        confirmSolanaTransaction(signature, CONFIRM_TIMEOUT_MS),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error('Transaction confirmation timed out. It may still land — check Solscan.')), CONFIRM_TIMEOUT_MS)),
      ])

      if (confirmation?.value?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`)
      }

      // 4. Refresh balance, live stats, and burn history immediately — no
      // page reload, no stale numbers shown as if they were current.
      setPhase('updating')
      setBurnedAmountUi(previewData.uiAmount)
      await Promise.all([
        Promise.resolve(refreshWalletData()),
        // Refresh the shared global stats source immediately after confirmation;
        // this also refreshes the ledger through the effect above.
        Promise.resolve(refreshLiveStats()),
      ])

      setPhase('success')
    } catch (error) {
      console.error('RONIN burn failed', error)
      setPhase('failed')
      setTxError(friendlyBurnError(error))
    }
  }

  const balanceDisplay = balance == null ? (isConnected ? '…' : '—') : `${formatRoninAmount(balance)}`
  const recentBurn = historyEvents[0]

  return (
    <>
      <PageHero
        eyebrow="Burn / 03"
        title="The Ronin"
        titleAccent="Forge"
        text="What enters the forge never returns. Burn your $RONIN, permanently and on-chain, via a real Solana transaction you sign yourself."
        image="/images/forge.jpg"
        className="burn-hero"
      >
        <div className="page-hero-ref-actions">
          <Button onClick={isConnected ? () => document.getElementById('burn-desk')?.scrollIntoView({ behavior: 'smooth' }) : openWalletModal} icon={isConnected ? 'flame' : 'wallet'}>
            {isConnected ? 'Enter the forge' : 'Connect wallet'}
          </Button>
          <Tag tone="light">Permanent by design • Helius live</Tag>
        </div>
      </PageHero>

      <section className="section burn-stats-section enhanced-section">
        <Sakura count={12} className="section-petals" />
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/forge.jpg')" }} />
        <div className="enhanced-ink">炎</div>
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="section-row">
            <SectionHeading
              eyebrow="The burn ledger"
              title="Scarcity, made visible."
              text={`Every burn is a permanent, verifiable reduction in supply. Global on-chain data: supply ${supplyLive ? formatCompact(supplyLive) : '…'}${burnedLive != null ? ` • accumulated burned ${formatCompact(burnedLive)}` : ''}.`}
            />
            <div className="ledger-mark"><span>火</span><small>FIRE<br />LEDGER</small></div>
          </div>
          <div className="burn-stat-grid">
            <StatCard stat={{ label: 'ACCUMULATED BURNED', value: burnedLive != null ? formatCompact(burnedLive) : liveStatsState === 'loading' ? '…' : '—', suffix: burnedLive != null ? 'RONIN • global on-chain' : liveStatsState === 'loading' ? 'Fetching global on-chain data' : 'Global on-chain data unavailable', icon: 'flame' }} />
            <StatCard stat={{ label: 'CURRENT SUPPLY', value: supplyLive ? formatCompact(supplyLive) : '—', suffix: 'RONIN • Solana RPC', icon: 'coins' }} />
            <StatCard stat={{ label: 'RECENT VERIFIED BURN', value: recentBurn ? formatRoninAmount(recentBurn.amount) : historyState === 'loading' ? '…' : '—', suffix: recentBurn ? 'RONIN • on-chain' : 'None found in scan', icon: 'trend' }} />
            <StatCard stat={{ label: 'VERIFIED BURNS (LATEST)', value: historyState === 'ready' ? String(historyEvents.length) : historyState === 'loading' ? '…' : '—', suffix: historyState === 'ready' ? 'global Helius history' : historyState === 'loading' ? 'Reading global history' : 'Global data unavailable', icon: 'chart' }} />
          </div>
          <div className="burn-ornament">
            <div className="burn-ornament-line" />
            <span>燃やして強くなる • Burn to grow stronger • LIVE {liveStats?.updatedAt ? new Date(liveStats.updatedAt).toLocaleTimeString() : ''}</span>
            <div className="burn-ornament-line" />
          </div>
        </div>
      </section>

      <section className="section burn-desk-section enhanced-section cream-enhanced" id="burn-desk">
        <Sakura count={14} className="section-petals" />
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/hero-ronin.jpg')" }} />
        <div className="enhanced-ink light">焼却</div>
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="section-row">
            <SectionHeading eyebrow="The burn desk" title="Burn your $RONIN." text="Enter an amount, review the real fee preview from Sol Incinerator, then sign in Phantom. Nothing is destroyed until you confirm and Solana confirms it back." />
            <Tag tone="light">Sol Incinerator v2 • Live supply {supplyLive ? formatCompact(supplyLive) : '…'}</Tag>
          </div>
          <div className="burn-layout">
            <div className="burn-card enhanced-card">
              <div className="burn-card-head">
                <div>
                  <span className="data-label">YOUR BALANCE</span>
                  <strong>{isConnected ? `${balanceDisplay} RONIN` : '— RONIN'}</strong>
                  <span className="data-label" style={{ marginTop: '6px' }}>AMOUNT TO BURN</span>
                </div>
                <div>
                  <Tag tone="neutral">{wallet ? wallet.shortAddress : 'Not connected'}</Tag>
                  <div className="fire-emblem" style={{ marginTop: '12px', marginLeft: 'auto' }}><Icon name="flame" size={20} /></div>
                </div>
              </div>

              {wallet?.isDemo && (
                <div className="notice-box notice-box-error">
                  <Icon name="info" size={16} />
                  <span>Demo profile is not a real Solana address and cannot be burned from. Connect a real Phantom wallet on mainnet to use the Forge.</span>
                </div>
              )}

              {isConnected && balance === 0 && (
                <div className="notice-box notice-box-error">
                  <Icon name="info" size={16} />
                  <span>0 RONIN available. You need $RONIN in this wallet before you can burn.</span>
                </div>
              )}

              <div className="field-label"><span></span><span>{isConnected && hasValidNumericAmount && balance ? `${Math.min(100, Math.round((numericAmount / balance) * 100))}% of balance` : 'Choose your mark'}</span></div>
              <div className={`amount-field ${fieldError ? 'amount-field-error' : ''}`}>
                <input
                  value={amount}
                  onChange={handleAmountChange}
                  placeholder="0"
                  inputMode="decimal"
                  aria-label="Amount to burn in RONIN"
                  disabled={!isConnected}
                />
                <span>RONIN</span>
              </div>
              {fieldError && <div className="inline-message"><Icon name="info" size={14} />{fieldError}</div>}

              <div className="preset-row">
                {PRESETS.map((item) => (
                  <button key={item} className={preset === item ? 'preset active' : 'preset'} onClick={() => choosePreset(item)} disabled={!isConnected || !balance}>{item}</button>
                ))}
              </div>

              <div className="burn-warning">
                <Icon name="info" size={16} />
                <div>
                  <strong>PERMANENT ACTION</strong>
                  <span>Burns are permanent and irreversible. Always verify the official contract address before signing. Burning $RONIN permanently destroys those tokens on-chain — burned tokens can never be recovered. Only a full-balance (MAX) burn closes the token account and reclaims rent — partial burns leave the account open.</span>
                </div>
              </div>
              <ContractVerifyNote compact />

              <Button className="full-button burn-button" icon={isConnected ? 'flame' : 'wallet'} onClick={handlePrimaryAction} disabled={primaryDisabled()}>
                {primaryLabel()}
              </Button>
              {formError && <div className="burn-message"><Icon name="info" size={16} />{formError}</div>}
              {!hasSolanaProvider && !isConnected && <p className="wallet-hint">No Phantom wallet detected. Install Phantom to burn $RONIN.</p>}
              {!isConnected && hasSolanaProvider && <p className="wallet-hint">Connect your Phantom wallet to see your live RONIN balance and burn.</p>}
            </div>

            <div className="burn-side-copy">
              <div className="brush-kanji">焼</div>
              <Eyebrow>One less blade in circulation.</Eyebrow>
              <h3>Make scarcity<br /><em>mean something.</em></h3>
              <p>The forge is not a button to press lightly. Every burn here is a real Solana transaction, signed by you, verifiable on Solscan, and irreversible the moment it lands.</p>
              <div className="burn-side-visual">
                <img src="/images/forge.jpg" alt="Forge" />
                <div className="burn-side-visual-overlay" />
              </div>
              <div className="burn-side-grid">
                <div className="surface-card enhanced-mini">
                  <span className="data-label">LIVE TOP HOLDERS</span>
                  <div className="mini-ledger">
                    {(liveStats?.largestAccounts || []).slice(0, 3).map((acc, i) => (
                      <div key={i}><span>{i + 1}. {acc.address ? shortAddr(acc.address) : '—'}</span><strong>{acc.uiAmountString || acc.amount} RONIN</strong></div>
                    ))}
                    {!liveStats?.largestAccounts?.length && <div><span>Loading live holders...</span></div>}
                  </div>
                </div>
                <div className="surface-card enhanced-mini burn-next">
                  <span className="data-label">LATEST VERIFIED BURN</span>
                  {recentBurn ? (
                    <>
                      <div className="burn-next-ring"><span>{formatRoninAmount(recentBurn.amount)}<br /><small>RONIN</small></span></div>
                      <span className="muted-caption">{recentBurn.timestamp ? new Date(recentBurn.timestamp).toLocaleDateString() : ''} • {shortAddr(recentBurn.wallet)}</span>
                      <div style={{ marginTop: '10px' }}>
                        <a className="btn btn-outline" href={solscanTxUrl(recentBurn.signature)} target="_blank" rel="noreferrer">Verify on Solscan <Icon name="external" size={14} /></a>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="burn-next-ring"><span>—</span></div>
                      <span className="muted-caption">{historyState === 'loading' ? 'Scanning global on-chain burns...' : 'No verified burns found in the global history yet.'}</span>
                      <div style={{ marginTop: '10px' }}>
                        <a className="btn btn-outline" href={RONIN_TOKEN_URL} target="_blank" rel="noreferrer">Verify on Solscan <Icon name="external" size={14} /></a>
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="burn-side-rule"><span /> supply is a story we write together • Helius live</div>
            </div>
          </div>
        </div>
      </section>

      <section className="section hall-section enhanced-section">
        <Sakura count={8} className="section-petals" />
        <div className="enhanced-bg" style={{ backgroundImage: "url('/images/game-landscape.jpg')" }} />
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div className="section-row">
            <SectionHeading eyebrow="Verified on-chain burns" title="The clan remembers." text="Real, confirmed SPL burn instructions against the $RONIN mint, read directly from Helius. Nothing here is estimated or invented." />
            <Button href={RONIN_TOKEN_URL} variant="outline" icon="external">Verify on Solscan</Button>
          </div>

          {historyState === 'loading' && (
            <div className="shield-empty"><Icon name="refresh" size={16} /><span>Scanning Solana for verified $RONIN burns…</span></div>
          )}

          {historyState === 'error' && (
            <div className="notice-box notice-box-error"><Icon name="info" size={16} /><span>Unable to read burn history right now. Try again shortly, or verify directly on Solscan.</span></div>
          )}

          {historyState === 'ready' && historyEvents.length === 0 && (
            <div className="shield-empty">
              <Icon name="info" size={16} />
              <span>No verified on-chain $RONIN burns were returned by the global scan. This page never fabricates burn history — check back after the first confirmed burn, or verify directly on <a href={RONIN_TOKEN_URL} target="_blank" rel="noreferrer">Solscan</a>.</span>
            </div>
          )}

          {historyState === 'ready' && historyEvents.length > 0 && (
            <div className="burn-table surface-card enhanced-card">
              <div className="table-head burn-table-grid"><span>#</span><span>Wallet</span><span>Amount burned</span><span>Date</span><span>Tx</span></div>
              {historyEvents.map((item, index) => (
                <div className="table-row burn-table-grid" key={item.signature}>
                  <span className="table-rank"><span className="mini-seal">{String(index + 1).padStart(2, '0')}</span></span>
                  <strong>{item.wallet ? shortAddr(item.wallet) : '—'}</strong>
                  <span className="amount-cell">{formatRoninAmount(item.amount)} <small>$RONIN</small></span>
                  <span>{item.timestamp ? new Date(item.timestamp).toLocaleDateString() : '—'}</span>
                  <a className="tag tag-neutral" href={solscanTxUrl(item.signature)} target="_blank" rel="noreferrer">{shortSig(item.signature)}</a>
                </div>
              ))}
            </div>
          )}

          <div className="hall-footer">
            <span className="data-label">LIVE • {supplyLive ? formatCompact(supplyLive) + ' SUPPLY' : ''} {burnedLive != null ? `• ${formatCompact(burnedLive)} BURNED` : ''} {historyMeta?.source ? `• ${historyMeta.source}` : ''}</span>
            <div className="hall-line" />
          </div>
        </div>
      </section>

      {modalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal() }}>
          <div className="modal buy-modal" role="dialog" aria-modal="true" aria-labelledby="burn-confirm-title">
            <Sakura count={6} className="card-petals" />
            {phase === 'confirm' && <button className="modal-close" onClick={closeModal} aria-label="Close burn dialog"><Icon name="close" size={16} /></button>}
            <div className="modal-kicker"><span className="status-dot" /> RONIN FORGE</div>

            {phase === 'confirm' && previewData && (
              <div className="buy-panel">
                <h2 id="burn-confirm-title" className="buy-title">CONFIRM RONIN BURN</h2>
                <div className="buy-review-rows">
                  <div><span>Amount to burn</span><strong>{formatRoninAmount(previewData.uiAmount)} RONIN</strong></div>
                  <div><span>Transaction type</span><strong>{previewData.transactionType || '—'}</strong></div>
                  <div><span>SOL reclaimed</span><strong>{previewData.solanaReclaimed ? `${previewData.solanaReclaimed} SOL` : 'None (partial burn keeps account open)'}</strong></div>
                  {previewData.feeBreakdown?.totalFee != null && (
                    <div><span>Protocol fee</span><strong>{lamportsToSol(previewData.feeBreakdown.totalFee)?.toFixed(6)} SOL</strong></div>
                  )}
                  <div><span>Network</span><strong>Solana Mainnet</strong></div>
                </div>
                <div className="burn-warning">
                  <Icon name="info" size={16} />
                  <div>
                    <strong>THIS CANNOT BE REVERSED</strong>
                    <span>Burns are permanent and irreversible. Always verify the official contract address before signing. Burning {formatRoninAmount(previewData.uiAmount)} RONIN permanently destroys these tokens on-chain. They can never be recovered.</span>
                  </div>
                </div>
                <ContractVerifyNote compact />
                <div className="buy-review-actions">
                  <Button variant="outline" icon="close" onClick={closeModal}>CANCEL</Button>
                  <Button className="buy-primary-btn" icon="flame" onClick={executeBurn}>CONFIRM BURN</Button>
                </div>
              </div>
            )}

            {(phase === 'signing' || phase === 'confirming' || phase === 'updating') && (
              <div className="buy-panel buy-result-panel">
                <div className="buy-status-block">
                  <div className="buy-spinner" aria-hidden="true" />
                  <strong>
                    {phase === 'signing' && 'WAITING FOR PHANTOM APPROVAL...'}
                    {phase === 'confirming' && 'CONFIRMING BURN ON SOLANA...'}
                    {phase === 'updating' && 'UPDATING RONIN BALANCE...'}
                  </strong>
                  <p>
                    {phase === 'signing' && 'Approve the burn in your Phantom wallet to continue.'}
                    {phase === 'confirming' && 'Waiting for real on-chain confirmation. This can take a few moments.'}
                    {phase === 'updating' && 'Refreshing your live balance, supply, and the burn ledger.'}
                  </p>
                </div>
              </div>
            )}

            {phase === 'success' && (
              <div className="buy-panel buy-result-panel">
                <div className="buy-status-block buy-status-success">
                  <Icon name="flame" size={28} />
                  <strong>🔥 RONIN BURN COMPLETE</strong>
                  <p>You burned:</p>
                  <p className="buy-result-amount">{formatRoninAmount(burnedAmountUi)} RONIN</p>
                  <p className="buy-result-sig">Transaction: {shortSig(txSignature)}</p>
                  <div className="buy-review-actions">
                    <a className="btn btn-outline" href={solscanTxUrl(txSignature)} target="_blank" rel="noreferrer">VIEW ON SOLSCAN <Icon name="external" size={14} /></a>
                    <Button icon="close" onClick={closeModal}>DONE</Button>
                  </div>
                </div>
              </div>
            )}

            {phase === 'failed' && (
              <div className="buy-panel buy-result-panel">
                <div className="buy-status-block buy-status-error">
                  <Icon name="info" size={28} />
                  <strong>Burn failed.</strong>
                  <p>{txError}</p>
                  <div className="buy-review-actions">
                    <Button variant="outline" icon="close" onClick={closeModal}>CLOSE</Button>
                    <Button icon="arrowRight" onClick={retryBurn}>TRY AGAIN</Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
