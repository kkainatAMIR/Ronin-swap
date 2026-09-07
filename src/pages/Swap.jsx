import { useEffect, useMemo, useState } from 'react'
import { VersionedTransaction } from '@solana/web3.js'
import { useWallet } from '../context/WalletContext'
import Icon from '../components/Icon'
import { Sakura } from '../components/Layout'
import ComingSoon from '../components/ComingSoon'
import { SWAP_ENABLED } from '../config/features'
import { FEATURED_TOKEN_SECTIONS, RONIN_QUICK_PAIRS, SOL_MINT, TOKEN_BY_MINT, TRUSTED_TOKENS } from '../config/tokenRegistry'
import { RONIN_MINT } from '../data'
import { getJupiterOrder } from '../services/jupiterService'

function toSafeDecimalString(value) {
  if (value === null || value === undefined || value === '') return ''
  const text = String(value).trim().replace(',', '.')
  if (!/^\d*\.?\d*$/.test(text)) return ''
  return text
}

function rawAmountFromUi(value, decimals) {
  const safeValue = toSafeDecimalString(value)
  if (!safeValue || Number(safeValue) <= 0) return null
  const [wholePart, fractionalPart = ''] = safeValue.split('.')
  const normalizedFraction = (fractionalPart || '').slice(0, decimals).padEnd(decimals, '0')
  const whole = wholePart || '0'
  const wholeValue = BigInt(whole)
  const fractionValue = BigInt(normalizedFraction || '0')
  return (wholeValue * (10n ** BigInt(decimals)) + fractionValue).toString()
}

function formatTokenAmount(rawAmount, decimals, maxFraction = 6) {
  if (rawAmount == null || rawAmount === '') return '0'
  const amount = BigInt(rawAmount)
  const scale = 10n ** BigInt(decimals)
  const whole = amount / scale
  const fraction = amount % scale
  const fractionString = fraction.toString().padStart(Number(decimals), '0').slice(0, maxFraction)
  const trimmed = fractionString.replace(/0+$/, '')
  return trimmed ? `${whole.toString()}.${trimmed}` : whole.toString()
}

function isQuoteCurrent(quote, fromToken, toToken, rawAmount) {
  if (!quote) return false
  if (!fromToken || !toToken) return false
  if (String(quote?.inputMint || quote?.inMint || '') !== String(fromToken.mint)) return false
  if (String(quote?.outputMint || quote?.outMint || '') !== String(toToken.mint)) return false
  const inAmount = String(quote?.inAmount || quote?.inputAmount || '')
  return inAmount === String(rawAmount)
}

function isValidWalletAddress(address) {
  if (!address || typeof address !== 'string') return false
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address.trim())
}

function getQuoteFingerprint({ inputMint, outputMint, rawAmount, walletAddress }) {
  return `${String(inputMint || '')}::${String(outputMint || '')}::${String(rawAmount || '')}::${String(walletAddress || '')}`
}

function isQuoteCurrentForRequest(quote, fromToken, toToken, rawAmount, walletAddress) {
  if (!quote || !fromToken || !toToken) return false
  const inputMint = String(quote?.inputMint || quote?.inMint || '')
  const outputMint = String(quote?.outputMint || quote?.outMint || '')
  const inAmount = String(quote?.inAmount || quote?.inputAmount || '')
  const matchesWallet = !walletAddress || !quote?.taker ? true : String(quote.taker || '').toLowerCase() === String(walletAddress).toLowerCase()
  return inputMint === String(fromToken.mint) && outputMint === String(toToken.mint) && inAmount === String(rawAmount) && matchesWallet
}

function validateUnsignedTransactionPayload(payload) {
  if (!payload || typeof payload !== 'string') return false
  try {
    const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
    VersionedTransaction.deserialize(bytes)
    return true
  } catch {
    return false
  }
}

const swapBenefits = [
  { icon: 'trend', title: 'BEST PRICES', text: 'Jupiter aggregates deep liquidity across Solana to get you the best possible price.' },
  { icon: 'shield', title: 'LOW FEES', text: 'Optimized routing means lower fees and more tokens in your wallet.' },
  { icon: 'lock', title: 'NON-CUSTODIAL', text: 'You keep control of your assets. We never store or have access to your funds.' },
  { icon: 'activity', title: 'INSTANT SWAPS', text: "Fast and reliable transactions on Solana's high-speed network." },
  { icon: 'award', title: 'CLAN POWERED', text: 'A portion of platform fees supports LP, burns, and ecosystem development.' },
]

function formatUsd(num) {
  if (num == null || !Number.isFinite(num)) return null
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`
  if (num >= 1_000) return `$${Math.round(num).toLocaleString()}`
  return `$${num.toFixed(2)}`
}

function JupiterMark({ size = 16 }) {
  return (
    <span className="jupiter-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size} height={size}>
        <circle cx="12" cy="12" r="12" fill="#0f1115" />
        <path d="M4 14.5c2.6-2.2 5-2.2 7.6 0 2.6 2.2 5 2.2 7.6 0" stroke="#2ee6c5" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        <path d="M4.6 10.4c2.6-2.2 5-2.2 7.6 0 2.6 2.2 5 2.2 7.6 0" stroke="#7de3ff" strokeWidth="1.6" fill="none" strokeLinecap="round" opacity=".85" />
        <path d="M6 6.6c2.2-1.8 4.2-1.8 6.4 0 2.2 1.8 4.2 1.8 6.4 0" stroke="#c9f56b" strokeWidth="1.4" fill="none" strokeLinecap="round" opacity=".7" />
      </svg>
    </span>
  )
}

function TokenMark({ token, size = 25 }) {
  const [imageFailed, setImageFailed] = useState(false)
  if (token.logoURI && !imageFailed) {
    return <img className="swap-token-dot swap-token-logo" src={token.logoURI} alt="" width={size} height={size} onError={() => setImageFailed(true)} />
  }
  return <span className={`swap-token-dot ${token.className}`} aria-hidden="true">{token.glyph}</span>
}

function shortMint(mint) {
  return `${mint.slice(0, 5)}...${mint.slice(-5)}`
}

function TokenSelector({ side, selected, other, onSelect, onClose }) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const results = useMemo(() => TRUSTED_TOKENS.filter((token) => {
    if (token.mint === other.mint) return false
    return !query || [token.symbol, token.name, token.mint].some((value) => value.toLowerCase().includes(query))
  }), [other.mint, query])

  const sectionTokens = (name) => FEATURED_TOKEN_SECTIONS[name]
    .map((symbol) => TRUSTED_TOKENS.find((token) => token.symbol === symbol))
    .filter((token) => token && token.mint !== other.mint)

  const choose = (token) => {
    onSelect(token)
    onClose()
  }

  return (
    <div className="swap-token-picker-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="swap-token-picker" role="dialog" aria-modal="true" aria-label={`Select ${side} token`}>
        <div className="swap-token-picker-head">
          <div><span className="swap-field-label">SELECT {side.toUpperCase()} TOKEN</span><strong>{selected.symbol}</strong></div>
          <button type="button" className="swap-token-picker-close" onClick={onClose} aria-label="Close token selector">×</button>
        </div>
        <input className="swap-token-search" autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search symbol, name, or mint" aria-label="Search trusted tokens" />
        {!query && <div className="swap-token-picker-sections">
          {['popular', 'memes', 'featured'].map((section) => {
            const tokens = sectionTokens(section)
            if (!tokens.length) return null
            return <div key={section}><span className="swap-token-section-title">{section}</span><div className="swap-token-quick-row">{tokens.map((token) => <button type="button" key={token.mint} onClick={() => choose(token)}><TokenMark token={token} size={22} /><span>{token.symbol}</span></button>)}</div></div>
          })}
        </div>}
        <div className="swap-token-results" role="listbox">
          {results.length ? results.map((token) => (
            <button type="button" className="swap-token-result" key={token.mint} onClick={() => choose(token)} role="option">
              <TokenMark token={token} size={30} />
              <span className="swap-token-result-copy"><strong>{token.symbol}</strong><small>{token.name}</small><small>{shortMint(token.mint)}</small></span>
              <span className="swap-token-trust">{token.trust}</span>
            </button>
          )) : <p className="swap-token-empty-state">No validated token matches that search.</p>}
        </div>
      </div>
    </div>
  )
}

export default function Swap() {
  const { wallet, openWalletModal, liveStats, liveStatsState } = useWallet()
  const [tab, setTab] = useState('swap')
  const [fromToken, setFromToken] = useState(TOKEN_BY_MINT[SOL_MINT])
  const [toToken, setToToken] = useState(TOKEN_BY_MINT[RONIN_MINT] || TRUSTED_TOKENS[1])
  const [pickerSide, setPickerSide] = useState(null)
  const [tokenFilter, setTokenFilter] = useState('tokens')
  const [amountInput, setAmountInput] = useState('')
  const [quote, setQuote] = useState(null)
  const [quoteState, setQuoteState] = useState('idle')
  const [quoteError, setQuoteError] = useState('')
  const [txState, setTxState] = useState('idle')
  const [txError, setTxError] = useState('')
  const [quoteMeta, setQuoteMeta] = useState(null)
  const paused = !SWAP_ENABLED
  const quoteAmountRaw = rawAmountFromUi(amountInput, fromToken?.decimals || 9)

  const visibleTokens = tokenFilter === 'tokens'
    ? TRUSTED_TOKENS
    : TRUSTED_TOKENS.filter((token) => token.section.includes(tokenFilter))

  useEffect(() => {
    if (!SWAP_ENABLED || !fromToken || !toToken) return undefined
    if (!amountInput || Number(amountInput) <= 0 || fromToken.mint === toToken.mint) {
      setQuote(null)
      setQuoteMeta(null)
      setQuoteState('idle')
      setQuoteError('')
      return undefined
    }
    const rawAmount = rawAmountFromUi(amountInput, fromToken.decimals)
    if (!rawAmount || !wallet?.address || !isValidWalletAddress(wallet.address)) {
      setQuote(null)
      setQuoteMeta(null)
      setQuoteState('idle')
      setQuoteError('')
      return undefined
    }

    let cancelled = false
    const controller = new AbortController()

    const fetchCurrentQuote = async () => {
      setQuoteState('loading')
      setQuoteError('')
      try {
        const nextQuote = await getJupiterOrder({
          inputMint: fromToken.mint,
          outputMint: toToken.mint,
          amountLamports: rawAmount,
          slippageBps: 100,
          taker: wallet.address,
          signal: controller.signal,
        })
        if (cancelled) return
        setQuote(nextQuote)
        setQuoteMeta({
          quoteKey: getQuoteFingerprint({
            inputMint: fromToken.mint,
            outputMint: toToken.mint,
            rawAmount,
            walletAddress: wallet.address,
          }),
          inputMint: fromToken.mint,
          outputMint: toToken.mint,
          rawAmount,
          walletAddress: wallet.address,
        })
        setQuoteState('ready')
        setTxState('idle')
        setTxError('')
      } catch (error) {
        if (cancelled) return
        setQuote(null)
        setQuoteMeta(null)
        setQuoteState('error')
        setQuoteError(error?.message || 'Unable to price this pair right now.')
      }
    }

    fetchCurrentQuote()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [amountInput, fromToken, toToken, wallet?.address])

  const selectToken = (side, token) => {
    if (side === 'from') {
      if (token.mint === toToken.mint) return
      setFromToken(token)
    } else {
      if (token.mint === fromToken.mint) return
      setToToken(token)
    }
    setQuote(null)
    setTxState('idle')
    setTxError('')
  }

  const flipTokens = () => {
    setFromToken(toToken)
    setToToken(fromToken)
    setQuote(null)
    setTxState('idle')
    setTxError('')
  }

  const choosePair = (pair) => {
    const from = TOKEN_BY_MINT[pair.from]
    const to = TOKEN_BY_MINT[pair.to]
    if (from && to) {
      setFromToken(from)
      setToToken(to)
      setQuote(null)
      setTxState('idle')
      setTxError('')
    }
  }

  const paymentAmountUi = Number(amountInput || 0)
  const quoteOutputAmount = quote?.outAmount ? formatTokenAmount(quote.outAmount, toToken?.decimals || 6, 6) : '0.00'
  const quoteRate = quote && Number(quote.inAmount) > 0 && Number(quote.outAmount) > 0 && paymentAmountUi > 0
    ? (Number(quote.outAmount) / Number(quote.inAmount)) * (10 ** (fromToken.decimals - toToken.decimals))
    : null

  const dex = liveStats?.dex
  const pending = liveStatsState === 'loading' ? '…' : '—'
  const ecosystemStats = [
    { icon: 'chart', label: '24H VOLUME', value: formatUsd(dex?.volume24h) || pending, note: dex?.dexId ? `${dex.dexId} live` : 'DexScreener pending' },
    { icon: 'swapVertical', label: 'TOTAL SWAPS', value: '—', note: 'Live at launch' },
    { icon: 'users', label: 'HOLDERS', value: liveStats?.holdersCount ? Number(liveStats.holdersCount).toLocaleString() : pending, note: liveStats?.holdersCount ? 'Helius live' : 'Helius pending' },
    { icon: 'flame', label: 'LIQUIDITY', value: formatUsd(dex?.liquidityUsd) || pending, note: dex?.liquidityUsd ? 'DexScreener live' : 'pending' },
    { icon: 'award', label: 'ECOSYSTEM SUPPORT', value: '100%', note: 'Of platform fees' },
  ]

  const validateSwapRequest = () => {
    if (!SWAP_ENABLED) return 'The swap flow is currently unavailable.'
    if (!wallet?.address || !isValidWalletAddress(wallet.address)) return 'Connect a valid wallet to continue.'
    if (!fromToken || !toToken) return 'Select a valid token pair.'
    if (fromToken.mint === toToken.mint) return 'Select two different tokens.'
    const rawAmount = rawAmountFromUi(amountInput, fromToken.decimals)
    if (!rawAmount || Number(rawAmount) <= 0) return 'Enter a valid amount to swap.'
    if (!quote || !isQuoteCurrentForRequest(quote, fromToken, toToken, rawAmount, wallet.address)) {
      return 'Quote is missing or stale. Please refresh the quote and review it again before preparing the swap.'
    }
    if (!quote?.transaction || typeof quote.transaction !== 'string' || !validateUnsignedTransactionPayload(quote.transaction)) {
      return 'Jupiter returned an invalid unsigned transaction payload. Please request a fresh quote and try again.'
    }
    return ''
  }

  const handleSwapAction = async (event) => {
    if (event) {
      event.preventDefault()
      event.stopPropagation()
    }
    if (!SWAP_ENABLED) return

    if (!wallet?.address) {
      openWalletModal()
      return
    }

    const validationError = validateSwapRequest()
    if (validationError) {
      setTxState('error')
      setTxError(validationError)
      return
    }

    setTxState('preparing')
    setTxError('')

    try {
      const rawAmount = rawAmountFromUi(amountInput, fromToken.decimals)
      const freshQuote = await getJupiterOrder({
        inputMint: fromToken.mint,
        outputMint: toToken.mint,
        amountLamports: rawAmount,
        slippageBps: 100,
        taker: wallet.address,
      })

      if (!freshQuote || !freshQuote.transaction || !validateUnsignedTransactionPayload(freshQuote.transaction)) {
        throw new Error('Jupiter returned an invalid or missing unsigned transaction payload.')
      }

      const freshQuoteKey = getQuoteFingerprint({
        inputMint: fromToken.mint,
        outputMint: toToken.mint,
        rawAmount,
        walletAddress: wallet.address,
      })

      setQuote(freshQuote)
      setQuoteMeta({
        quoteKey: freshQuoteKey,
        inputMint: fromToken.mint,
        outputMint: toToken.mint,
        rawAmount,
        walletAddress: wallet.address,
      })
      setQuoteState('ready')
      setTxState('ready_to_sign')
      setTxError('')
    } catch (error) {
      setTxState('error')
      setTxError(error?.message || 'Unable to prepare the swap transaction. Please try again.')
    }
  }

  return (
    <div className="swap-page">
      {/* ---------- HERO ---------- */}
      <section className="swap-hero-section">
        <div className="swap-hero-bg" aria-hidden="true">
          <img src="/images/swap-hero-wide.png" alt="" />
        </div>
        <div className="swap-hero-scrim" aria-hidden="true" />

        <div className="swap-hero-clanbar">
          <span className="swap-clanbar-seal" aria-hidden="true">❁</span>
          <div>
            <strong>EVERY SWAP SUPPORTS THE CLAN</strong>
            <p>A small platform fee helps fund LP, burns, development and future utilities.</p>
          </div>
        </div>

        <div className="swap-hero-inner">
          <div className="swap-hero-copy">
            <h1 className="swap-hero-title">
              <span className="swap-hero-title-black">RONIN</span>
              <span className="swap-hero-title-red">SWAP</span>
            </h1>
            <div className="swap-hero-powered">
              <i aria-hidden="true" /> POWERED BY <JupiterMark size={18} /> <b>JUPITER</b> <i aria-hidden="true" />
            </div>

            <h2 className="swap-hero-sub">
              SWAP ANY TOKEN.<br />
              FAST. SECURE. ON <em>SOLANA.</em>
            </h2>
            <p className="swap-hero-text">
              Access the best prices and lowest fees across the entire Solana ecosystem
              — all from the Ronin Samurai hub.
            </p>

            <ul className="swap-hero-points">
              <li><span className="swap-point-icon"><Icon name="activity" size={15} /></span><div><strong>Best Prices</strong><p>Jupiter finds the best routes across all liquidity sources.</p></div></li>
              <li><span className="swap-point-icon"><Icon name="shield" size={15} /></span><div><strong>Secure &amp; Non-Custodial</strong><p>You stay in control. We never hold your funds.</p></div></li>
              <li><span className="swap-point-icon swap-point-icon-kanji">浪</span><div><strong>Built for the Clan</strong><p>Every swap supports the $RONIN ecosystem.</p></div></li>
            </ul>
          </div>

          {/* ---------- SWAP WIDGET ---------- */}
          <div className="swap-widget">
            <div className="swap-widget-head">
              <div>
                <h3>RONIN SWAP</h3>
                <span className="swap-widget-powered">Powered by <JupiterMark size={15} /> <b>Jupiter</b></span>
              </div>
              <button type="button" className="swap-widget-gear" onClick={handleSwapAction} aria-label="Swap settings" aria-disabled={paused ? 'true' : undefined} disabled={paused}>
                <Icon name="settings" size={18} />
              </button>
            </div>

            <div className="swap-widget-tabs" role="tablist" aria-label="Swap mode">
              <button type="button" role="tab" aria-selected={tab === 'swap'} className={tab === 'swap' ? 'active' : ''} onClick={() => setTab('swap')}>SWAP</button>
              <button type="button" role="tab" aria-selected={tab === 'limit'} className={tab === 'limit' ? 'active' : ''} onClick={() => setTab('limit')} disabled>
                LIMIT ORDER <span className="swap-soon-chip">SOON</span>
              </button>
            </div>

            {paused && <ComingSoon compact className="swap-widget-coming-soon" />}

            <div className="swap-field">
              <span className="swap-field-label">YOU PAY</span>
              <div className="swap-field-row">
                <input
                  className="swap-field-input"
                  value={amountInput}
                  onChange={(event) => {
                    const nextValue = toSafeDecimalString(event.target.value)
                    setAmountInput(nextValue)
                    setQuote(null)
                    setTxState('idle')
                    setTxError('')
                  }}
                  placeholder="0.0"
                  inputMode="decimal"
                  aria-label="Amount you pay"
                />
                <button type="button" className="swap-token-select" onClick={() => setPickerSide('from')}>
                  <TokenMark token={fromToken} />
                  <strong>{fromToken.symbol}</strong>
                  <Icon name="chevronDown" size={14} />
                </button>
              </div>
              <div className="swap-field-foot">
                <span>$0.00</span>
                <span>Balance: -- <button type="button" className="swap-max" onClick={() => setAmountInput('1')} disabled={paused}>MAX</button></span>
              </div>
            </div>

            <div className="swap-flip-row">
              <button type="button" className="swap-flip" onClick={flipTokens} aria-label="Flip swap direction">
                <Icon name="swapVertical" size={16} />
              </button>
            </div>

            <div className="swap-field">
              <span className="swap-field-label">YOU RECEIVE</span>
              <div className="swap-field-row">
                <input className="swap-field-input" readOnly value={quoteOutputAmount} placeholder="0.0" aria-label="Amount you receive" />
                <button type="button" className="swap-token-select" onClick={() => setPickerSide('to')}>
                  <TokenMark token={toToken} />
                  <strong>{toToken.symbol}</strong>
                  <Icon name="chevronDown" size={14} />
                </button>
              </div>
              <div className="swap-field-foot">
                <span>$0.00</span>
                <span>Balance: --</span>
              </div>
            </div>

            <button type="button" className="swap-cta" onClick={handleSwapAction} disabled={paused || txState === 'preparing'} aria-disabled={paused ? 'true' : undefined}>
              {txState === 'preparing' ? 'PREPARING SWAP...' : txState === 'ready_to_sign' ? 'READY FOR WALLET' : !wallet?.address ? 'CONNECT WALLET TO SWAP' : 'SWAP'}
            </button>

            {(quoteError || txError) && <p className="swap-widget-foot" style={{ color: '#ba3c3c', marginTop: '8px' }}>{quoteError || txError}</p>}

            <div className="swap-quote-box">
              <div className="swap-quote-rate">
                <span>1 {fromToken.symbol} ≈ {quoteRate != null ? quoteRate.toFixed(6) : '0.00'} {toToken.symbol}</span>
                <button type="button" className="swap-quote-refresh" onClick={() => {
                  if (!wallet?.address) {
                    openWalletModal()
                    return
                  }
                  setQuote(null)
                  setTxState('idle')
                  setTxError('')
                  setQuoteState('idle')
                }} aria-label="Refresh quote" disabled={paused || !wallet?.address}><Icon name="refresh" size={13} /></button>
              </div>
              <div className="swap-quote-row"><span>Slippage Tolerance <Icon name="info" size={12} /></span><strong>1% <Icon name="pencil" size={11} /></strong></div>
              <div className="swap-quote-row"><span>Price Impact <Icon name="info" size={12} /></span><strong>{quote?.priceImpactPct ? Number(quote.priceImpactPct).toFixed(2) + '%' : '--'}</strong></div>
              <div className="swap-quote-row"><span>Minimum Received <Icon name="info" size={12} /></span><strong>{quote?.otherAmountThreshold ? formatTokenAmount(quote.otherAmountThreshold, toToken.decimals || 6, 6) : '--'}</strong></div>
              <div className="swap-quote-row"><span>Estimated Fees <Icon name="info" size={12} /></span><strong>{quote?.platformFee ? formatTokenAmount(quote.platformFee.amount, quote.platformFee.decimals || 6, 6) : '--'}</strong></div>
            </div>

            <p className="swap-widget-foot"><Icon name="shield" size={12} /> {txState === 'ready_to_sign' ? 'Unsigned swap prepared — ready for wallet signing.' : 'Secure. Non-Custodial. Powered by Jupiter Aggregator.'}</p>
          </div>
        </div>
      </section>

      {/* ---------- BENEFITS ---------- */}
      <section className="swap-benefits-section">
        <div className="swap-benefits-card">
          {swapBenefits.map((item) => (
            <div className="swap-benefit" key={item.title}>
              <span className="swap-benefit-icon"><Icon name={item.icon} size={22} /></span>
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- LIVE STATS ---------- */}
      <section className="swap-stats-section">
        <div className="swap-stats-card">
          <div className="swap-stats-title"><span aria-hidden="true">❁</span> LIVE ECOSYSTEM STATS <span aria-hidden="true">❁</span></div>
          <div className="swap-stats-grid">
            {ecosystemStats.map((stat) => (
              <div className="swap-stat" key={stat.label}>
                <span className="swap-stat-icon"><Icon name={stat.icon} size={17} /></span>
                <div>
                  <span className="swap-stat-label">{stat.label}</span>
                  <strong className="swap-stat-value">{stat.value}</strong>
                  {stat.note && <span className="swap-stat-note">{stat.note}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- POPULAR TOKENS ---------- */}
      <section className="swap-tokens-section">
        <div className="swap-tokens-card">
          <div className="swap-tokens-head">
            <div>
              <h3>POPULAR TOKENS ON SOLANA</h3>
              <div className="swap-token-filters" role="tablist" aria-label="Token filter">
                {['tokens', 'popular', 'memes'].map((filter) => (
                  <button type="button" role="tab" aria-selected={tokenFilter === filter} className={tokenFilter === filter ? 'active' : ''} key={filter} onClick={() => setTokenFilter(filter)}>
                    {filter}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className="swap-tokens-all" onClick={handleSwapAction} disabled={paused}>VIEW ALL TOKENS <Icon name="chevronRight" size={13} /></button>
          </div>
          <div className="swap-tokens-row">
            {visibleTokens.map((token) => (
              <button type="button" className="swap-token" key={token.mint} onClick={() => selectToken('to', token)}>
                <TokenMark token={token} size={38} />
                <strong>{token.symbol}</strong>
                <small>{token.name}</small>
              </button>
            ))}
          </div>
          <div className="swap-quick-pairs">{RONIN_QUICK_PAIRS.map((pair) => <button type="button" key={pair.label} onClick={() => choosePair(pair)}>{pair.label}</button>)}</div>
        </div>
      </section>

      {/* ---------- PURPOSE BANNER ---------- */}
      <section className="swap-purpose-section">
        <Sakura count={10} className="swap-purpose-petals wind-strong" />
        <div className="swap-purpose-inner">
          <span className="swap-purpose-seal" aria-hidden="true">❁</span>
          <h2 className="swap-purpose-title">
            <span>SWAP WITH PURPOSE.</span>
            <em>BUILD THE LEGACY.</em>
          </h2>
          <p>Every swap fuels the future of $RONIN. Together, we strengthen the clan and build something unstoppable.</p>
          <div className="swap-purpose-torii" aria-hidden="true">⛩</div>
        </div>
      </section>
      {pickerSide && <TokenSelector side={pickerSide} selected={pickerSide === 'from' ? fromToken : toToken} other={pickerSide === 'from' ? toToken : fromToken} onSelect={(token) => selectToken(pickerSide, token)} onClose={() => setPickerSide(null)} />}
    </div>
  )
}
