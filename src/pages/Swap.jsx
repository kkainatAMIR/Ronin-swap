import { connectEthereumWallet, connectRobinhoodWallet, ensureEthereumMainnet, ensureRobinhoodChain, evmAmount, formatEvmAmount, getErc20Decimals, getEthereumProvider, getEthereumQuote, getEthereumTokenBalances, getEthereumTokenPrices } from '../services/ethereumService'
import { approveLifiTransaction, getLifiApprovalRequest, getLifiQuote, getLifiStatus, lifiStatusIsComplete, lifiStatusIsFailed, sendLifiTransaction } from '../services/lifiService'
import { getRobinhoodTokenSections, getRobinhoodTrending } from '../services/robinhoodTokenService'
import { getLiveTrendingTokens } from '../services/liveTrendingService'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { VersionedTransaction } from '@solana/web3.js'
import { useWallet, getSolanaProvider } from '../context/WalletContext'
import Icon from '../components/Icon'
import { Button, Sakura } from '../components/Layout'
import ComingSoon from '../components/ComingSoon'
import { SWAP_ENABLED } from '../config/features'
import { FEATURED_TOKEN_SECTIONS, RONIN_QUICK_PAIRS, SOL_MINT, TOKEN_BY_MINT, TRUSTED_TOKENS } from '../config/tokenRegistry'
import { RONIN_MINT } from '../data'
import { executeJupiterOrder, getJupiterOrder, JupiterApiError, processSamuraiPoints, recordVerifiedSwap, verifySwapTransaction } from '../services/jupiterService'
import { confirmSolanaTransaction, getRoninBalance, getSolBalance } from '../services/roninService'
import { getAllTokenAccounts } from '../services/shieldService'
import { ETHEREUM_CHAIN_ID, ETHEREUM_FEATURED_SECTIONS, ETHEREUM_FEATURED_TOKENS, ETHEREUM_SWAP_TOKENS } from '../config/ethereumRegistry'

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

function friendlySwapError(error) {
  if (!error) return 'Something went wrong. Please try again.'
  const message = error?.message || String(error)
  if (/user rejected|rejected the request|4001/i.test(message)) return 'Transaction cancelled in wallet.'
  if (/wallet changed|stale|expired|blockhash|fresh quote/i.test(message)) return 'Wallet changed or the quote expired. Please request a fresh quote before signing.'
  if (/insufficient balance/i.test(message)) return 'Insufficient balance to complete this swap.'
  if (/slippage|price impact/i.test(message)) return 'The swap failed because the price moved beyond the allowed slippage.'
  if (/simulation failed|execute.*failed|transaction failed|failed to simulate/i.test(message)) return 'The swap failed during execution or simulation.'
  if (/network|rpc|timeout|timed out|did not respond/i.test(message)) return 'Network or RPC error. Please try again.'
  return message
}

function shortSignature(signature = '', length = 5) {
  if (!signature) return ''
  if (signature.length <= length * 2) return signature
  return `${signature.slice(0, length)}...${signature.slice(-length)}`
}

function getCompletionPointsRecord(payload) {
  const candidate = payload?.points ?? payload?.pointsRecord ?? payload?.samuraiPoints ?? null
  if (!candidate || typeof candidate !== 'object') return null
  return candidate
}

function normalizeCompletionPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const pointsRecord = payload?.points ?? payload?.pointsRecord ?? payload?.samuraiPoints ?? null
  return {
    ...payload,
    points: pointsRecord,
  }
}

function hasUsablePointsRecord(payload) {
  const points = getCompletionPointsRecord(payload)
  if (!points) return false
  const keys = Object.keys(points)
  if (!keys.length) return false
  const hasAnyPointsValue = [points.points_awarded, points.pointsAwarded, points.final_points, points.finalPoints, points.qualifying_volume_usd, points.qualifyingVolumeUsd].some((value) => value != null && value !== '')
  const hasQualifiedFlag = points.qualified === true || points.eligibility_status === 'qualified'
  return hasAnyPointsValue || hasQualifiedFlag
}

function solscanTxUrl(signature) {
  return `https://solscan.io/tx/${signature}`
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
  { icon: 'shield', title: 'LOW FEES', text: 'Jupiter routing is optimized for efficient execution and minimal network overhead.' },
  { icon: 'lock', title: 'NON-CUSTODIAL', text: 'You keep control of your assets. We never store or have access to your funds.' },
  { icon: 'activity', title: 'INSTANT SWAPS', text: "Fast and reliable transactions on Solana's high-speed network." },
  { icon: 'award', title: 'CLAN POWERED', text: 'Built for the Ronin ecosystem with a 0.5% Jupiter referral fee.' },
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

function EthereumTokenSelector({ side, selected, other, onSelect, onClose }) {
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const tokens = ETHEREUM_FEATURED_TOKENS.filter((token) => token !== other && (!query || `${token.symbol} ${token.name} ${token.address || 'native'}`.toLowerCase().includes(query)))
  const sectionTokens = (section) => ETHEREUM_FEATURED_SECTIONS[section].map((symbol) => ETHEREUM_FEATURED_TOKENS.find((token) => token.symbol === symbol)).filter((token) => token && token !== other && (!query || `${token.symbol} ${token.name} ${token.address || 'native'}`.toLowerCase().includes(query)))
  const choose = (token) => { onSelect(token); onClose() }
  return createPortal(<div className="swap-token-picker-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="swap-token-picker" role="dialog" aria-modal="true" aria-label={`Select Ethereum ${side} token`}><div className="swap-token-picker-head"><div><span className="swap-field-label">SELECT {side.toUpperCase()} TOKEN</span><strong>{selected.symbol}</strong></div><button type="button" className="swap-token-picker-close" onClick={onClose} aria-label="Close token selector">×</button></div><input className="swap-token-search" autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Ethereum token" aria-label="Search Ethereum tokens" />{!query && <div className="swap-token-picker-sections">{['popular', 'memes', 'featured'].map((section) => <div key={section}><span className="swap-token-section-title">{section}</span><div className="swap-token-quick-row">{sectionTokens(section).map((token) => <button type="button" key={token.address || 'native'} onClick={() => choose(token)}><TokenMark token={token} size={22} /><span>{token.symbol}</span></button>)}</div></div>)}</div>}<div className="swap-token-results" role="listbox">{tokens.map((token) => <button type="button" className="swap-token-result" key={token.address || 'native'} onClick={() => choose(token)} role="option"><TokenMark token={token} size={30} /><span className="swap-token-result-copy"><strong>{token.symbol}</strong><small>{token.name}</small><small>{token.type === 'native' ? 'Native ETH' : token.address}</small></span><span className="swap-token-trust">FEATURED</span></button>)}</div></div></div>, document.body)
}

function EthereumSwapPanel() {
  const [account, setAccount] = useState('')
  const [fromToken, setFromToken] = useState(ETHEREUM_SWAP_TOKENS[0])
  const [toToken, setToToken] = useState(ETHEREUM_SWAP_TOKENS[2])
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState(null)
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const [txHash, setTxHash] = useState('')
  const [pickerSide, setPickerSide] = useState(null)
  const [balances, setBalances] = useState(new Map())
  const [prices, setPrices] = useState(new Map())
  const [completion, setCompletion] = useState(null)
  const executeInFlightRef = useRef(false)

  useEffect(() => {
    const provider = getEthereumProvider()
    if (!provider) return undefined
    const refresh = async () => {
      try {
        const accounts = await provider.request({ method: 'eth_accounts' })
        const nextAccount = accounts?.[0] || ''
        setAccount(nextAccount)
        setBalances(nextAccount ? await getEthereumTokenBalances(provider, nextAccount, ETHEREUM_SWAP_TOKENS) : new Map())
        setPrices(nextAccount ? await getEthereumTokenPrices(ETHEREUM_SWAP_TOKENS) : new Map())
      } catch { setAccount(''); setBalances(new Map()); setPrices(new Map()) }
    }
    const changed = (accounts) => { setAccount(accounts?.[0] || ''); setBalances(new Map()); setPrices(new Map()); setQuote(null); setMessage('Wallet account changed. Request a fresh quote.') }
    const chainChanged = () => { setBalances(new Map()); setPrices(new Map()); setQuote(null); setMessage('Network changed. Ethereum quotes were cleared.') }
    refresh(); provider.on?.('accountsChanged', changed); provider.on?.('chainChanged', chainChanged)
    return () => { provider.removeListener?.('accountsChanged', changed); provider.removeListener?.('chainChanged', chainChanged) }
  }, [])

  useEffect(() => {
    setQuote(null)
    setTxHash('')
    if (status !== 'idle') setStatus('idle')
  }, [fromToken.address, toToken.address, amount, account])

  const connect = async () => {
    try { setMessage(''); const nextAccount = await connectEthereumWallet(); setAccount(nextAccount); setBalances(await getEthereumTokenBalances(getEthereumProvider(), nextAccount, ETHEREUM_SWAP_TOKENS)); setPrices(await getEthereumTokenPrices(ETHEREUM_SWAP_TOKENS)) } catch (error) { setMessage(error.message) }
  }

  const etherscanTxUrl = (hash) => `https://etherscan.io/tx/${hash}`

  const balanceLabel = (token) => {
    const entry = balances.get(token.address || 'native')
    return entry ? formatEvmAmount(entry.raw.toString(), entry.decimals) : '--'
  }

  const loadQuote = async () => {
    const provider = getEthereumProvider()
    if (!provider || !account) throw new Error('Connect MetaMask before requesting a quote.')
    await ensureEthereumMainnet(provider)
    const decimals = fromToken.type === 'native' ? 18 : await getErc20Decimals(provider, fromToken.address)
    const sellAmount = evmAmount(amount, decimals)
    if (!sellAmount) throw new Error(`Enter a valid amount with up to ${decimals} decimals.`)
    const outputDecimals = toToken.type === 'native' ? 18 : await getErc20Decimals(provider, toToken.address)
    const result = await getEthereumQuote({ chainId: ETHEREUM_CHAIN_ID, sellToken: fromToken.type === 'native' ? 'native' : fromToken.address, buyToken: toToken.type === 'native' ? 'native' : toToken.address, sellAmount: BigInt(sellAmount).toString(), walletAddress: account })
    const nextQuote = { ...result, sellAmount: result.sellAmount || BigInt(sellAmount).toString(), sellDecimals: decimals, buyDecimals: outputDecimals, wallet: account, sellToken: fromToken.address || 'native', buyToken: toToken.address || 'native' }
    setQuote(nextQuote)
    return nextQuote
  }

  const requestQuote = async () => {
    try {
      setStatus('loading'); setMessage(''); setQuote(null)
      await loadQuote(); setStatus('ready')
    } catch (error) { setStatus('error'); setMessage(error.message || 'Ethereum quote unavailable.') }
  }

  const waitForReceipt = async (provider, hash) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] })
      if (receipt) return receipt
      await new Promise((resolve) => window.setTimeout(resolve, 2_000))
    }
    throw new Error('Transaction confirmation timed out.')
  }

  const readBalance = async (provider, token, owner) => {
    if (token.type === 'native') return BigInt(await provider.request({ method: 'eth_getBalance', params: [owner, 'latest'] }))
    const data = `0x70a08231${owner.slice(2).padStart(64, '0')}`
    return BigInt(await provider.request({ method: 'eth_call', params: [{ to: token.address, data }, 'latest'] }))
  }

  const execute = async () => {
    if (executeInFlightRef.current) return
    executeInFlightRef.current = true
    try {
      setStatus('loading'); setMessage('Checking wallet balances and requesting a fresh quote...')
      setCompletion(null)
      const provider = getEthereumProvider()
      await ensureEthereumMainnet(provider)
      const accounts = await provider.request({ method: 'eth_accounts' })
      if (!accounts?.[0] || accounts[0].toLowerCase() !== account.toLowerCase()) throw new Error('Wallet account changed. Request a fresh quote.')
      let freshQuote = await loadQuote()
      const balance = await readBalance(provider, fromToken, account)
      if (balance < BigInt(freshQuote.sellAmount)) throw new Error(`Insufficient ${fromToken.symbol} balance.`)
      if (fromToken.type === 'erc20') {
        if (!freshQuote.allowanceTarget || !/^0x[0-9a-fA-F]{40}$/.test(freshQuote.allowanceTarget)) throw new Error('The routing provider did not return a valid approval spender.')
        const allowanceData = `0xdd62ed3e${account.slice(2).padStart(64, '0')}${freshQuote.allowanceTarget.slice(2).padStart(64, '0')}`
        const allowance = await provider.request({ method: 'eth_call', params: [{ to: fromToken.address, data: allowanceData }, 'latest'] })
        if (BigInt(allowance) < BigInt(freshQuote.sellAmount)) {
          setStatus('approval_required'); setMessage('Approval required. Review the exact allowance in MetaMask.')
          const approvalData = `0x095ea7b3${freshQuote.allowanceTarget.slice(2).padStart(64, '0')}${BigInt(freshQuote.sellAmount).toString(16).padStart(64, '0')}`
          const approvalHash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: fromToken.address, data: approvalData, value: '0x0' }] })
          setStatus('approval_pending'); setMessage(`Approval submitted: ${approvalHash}`)
          const approvalReceipt = await waitForReceipt(provider, approvalHash)
          if (approvalReceipt.status !== '0x1') throw new Error('Token approval failed.')
          setStatus('approval_confirmed'); setMessage('Approval confirmed. Refreshing quote...')
          freshQuote = await loadQuote()
        }
      }
      const gas = await provider.request({ method: 'eth_estimateGas', params: [{ from: account, to: freshQuote.transaction.to, data: freshQuote.transaction.data, value: `0x${BigInt(freshQuote.transaction.value || 0).toString(16)}` }] })
      const gasPrice = await provider.request({ method: 'eth_gasPrice' })
      const gasCost = BigInt(gas) * BigInt(gasPrice)
      const ethBalance = await readBalance(provider, { type: 'native' }, account)
      if (ethBalance < gasCost + (fromToken.type === 'native' ? BigInt(freshQuote.sellAmount) : 0n)) throw new Error('Insufficient ETH for network gas.')
      setStatus('signing')
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: freshQuote.transaction.to, data: freshQuote.transaction.data, value: `0x${BigInt(freshQuote.transaction.value || 0).toString(16)}`, gas: `0x${BigInt(gas).toString(16)}` }] })
      setTxHash(hash); setStatus('pending'); setMessage('Transaction submitted. Waiting for confirmation...')
      const receipt = await waitForReceipt(provider, hash)
      if (receipt.status !== '0x1') throw new Error('Transaction reverted.')
      setStatus('confirmed')
      setMessage('Transaction confirmed on Ethereum. Recording swap and Samurai Points...')
      try {
        const completed = await fetch('/api/evm/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chainId: 1, transactionHash: hash, wallet: account, sellToken: freshQuote.sellToken, buyToken: freshQuote.buyToken, sellAmount: freshQuote.sellAmount, buyAmount: freshQuote.buyAmount, quoteProof: freshQuote.quoteProof }) }).then((response) => response.json().then((body) => { if (!response.ok) throw new Error(body.error || 'Confirmed swap could not be recorded.'); return body }))
        const pointsRecord = completed?.points ?? completed?.pointsRecord ?? completed?.samuraiPoints ?? null
        const normalizedCompletion = {
          ...completed,
          points: pointsRecord,
        }

        const normalizedPoints = getCompletionPointsRecord(normalizedCompletion) || {}
        const normalizedPointsAwarded = Number(
          normalizedPoints.points_awarded ??
          normalizedPoints.pointsAwarded ??
          normalizedPoints.final_points ??
          normalizedPoints.finalPoints ??
          0
        )

        setCompletion(normalizedCompletion)
        setMessage(`Swap confirmed. Samurai Points: ${normalizedPointsAwarded.toLocaleString()}`)
      } catch (completionError) {
        setMessage(`Transaction confirmed on Ethereum, but recording is pending: ${completionError?.message || 'backend unavailable.'}`)
      }
    } catch (error) { setStatus('error'); setMessage(/4001|rejected/i.test(error.message) ? 'Transaction cancelled in MetaMask.' : error.message || 'Ethereum swap failed.') }
    finally { executeInFlightRef.current = false }
  }

  const busy = ['loading', 'approval_required', 'approval_pending', 'approval_confirmed', 'signing', 'pending'].includes(status)
  const holdings = ETHEREUM_SWAP_TOKENS.map((token) => {
    const entry = balances.get(token.address || 'native')
    if (!entry || entry.raw === 0n) return null
    const amountValue = Number(formatEvmAmount(entry.raw.toString(), entry.decimals))
    const price = prices.get(token.address || 'native')
    return { token, amount: formatEvmAmount(entry.raw.toString(), entry.decimals), usd: Number.isFinite(amountValue) && price ? amountValue * price : null }
  }).filter(Boolean)
  const holdingsMessage = account
    ? `Balance: ${fromToken.symbol} ${balanceLabel(fromToken)} | ${toToken.symbol} ${balanceLabel(toToken)} · Holdings: ${holdings.map(({ token, amount: holdingAmount, usd }) => `${token.symbol} ${holdingAmount}${usd != null ? ` ($${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })})` : ''}`).join(' | ') || 'none detected'}`
    : ''
  const statusMessage = [holdingsMessage, { loading: 'Finding best route...', approval_required: 'Approval required. Review the exact allowance in MetaMask.', approval_pending: 'Approval pending...', approval_confirmed: 'Approval confirmed. Refreshing quote...', signing: 'Confirm the transaction in MetaMask.', pending: 'Transaction submitted. Waiting for confirmation...', confirmed: 'Swap confirmed.' }[status]].filter(Boolean).join(' · ')
  const submit = () => { if (!account) return connect(); if (quote) return execute(); return requestQuote() }
  return (
    <div className="evm-swap-panel">
      <div className="swap-widget-head">
        <div>
          <h3>RONIN SWAP</h3>
          <span className="swap-widget-powered">Powered by <b>0x</b> · Ethereum Mainnet</span>
          <span className="swap-contract-status">CONTRACT IN DEVELOPMENT</span>
        </div>
        <button type="button" className="swap-widget-gear" aria-label="Swap settings" disabled><Icon name="settings" size={18} /></button>
      </div>
      {account && <div className="swap-wallet-strip" style={{ marginBottom: '12px', display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px', color: '#ff5c5c', background: 'rgba(255, 92, 92, 0.08)', border: '1px solid rgba(255, 92, 92, 0.32)', borderRadius: '10px', padding: '8px 10px' }}><span style={{ color: '#ff8d8d' }}>Wallet</span><strong style={{ color: '#ff5c5c', fontFamily: 'var(--mono)' }}>{account.slice(0, 6)}...{account.slice(-4)}</strong></div>}
      <div className="swap-widget-tabs" role="tablist" aria-label="Swap mode"><button type="button" role="tab" aria-selected="true" className="active">SWAP</button><button type="button" role="tab" aria-selected="false" disabled>LIMIT ORDER <span className="swap-soon-chip">SOON</span></button></div>
      <div className="swap-field">
        <span className="swap-field-label">YOU PAY</span>
        <div className="swap-field-row"><input className="swap-field-input" disabled={busy} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0" inputMode="decimal" aria-label="Amount you pay" /><button type="button" className="swap-token-select" disabled={busy} onClick={() => setPickerSide('from')}><TokenMark token={fromToken} /><strong>{fromToken.symbol}</strong><Icon name="chevronDown" size={14} /></button></div>
        <div className="swap-field-foot"><span>$0.00</span><span>Balance: {account ? `${balanceLabel(fromToken)} ${fromToken.symbol}` : '--'}{fromToken.type === 'native' && account && <button type="button" className="swap-max" onClick={() => setAmount(balanceLabel(fromToken))} disabled={busy}>MAX</button>}</span></div>
      </div>
      <div className="swap-flip-row"><button type="button" className="swap-flip" disabled={busy} onClick={() => { setFromToken(toToken); setToToken(fromToken); setQuote(null) }} aria-label="Reverse Ethereum swap"><Icon name="swapVertical" size={16} /></button></div>
      <div className="swap-field">
        <span className="swap-field-label">YOU RECEIVE</span>
        <div className="swap-field-row"><input className="swap-field-input" readOnly value={quote ? formatEvmAmount(quote.buyAmount, quote.buyDecimals || 6) : ''} placeholder="0.0" aria-label="Amount you receive" /><button type="button" className="swap-token-select" disabled={busy} onClick={() => setPickerSide('to')}><TokenMark token={toToken} /><strong>{toToken.symbol}</strong><Icon name="chevronDown" size={14} /></button></div>
        <div className="swap-field-foot"><span>$0.00</span><span>Balance: {account ? `${balanceLabel(toToken)} ${toToken.symbol}` : '--'}</span></div>
      </div>
      <button type="button" className="swap-cta" disabled={busy} onClick={submit}>{!account ? 'CONNECT METAMASK TO SWAP' : status === 'loading' ? 'FINDING BEST ROUTE...' : status === 'approval_pending' ? 'APPROVAL PENDING...' : status === 'signing' ? 'CONFIRM IN METAMASK...' : status === 'pending' ? 'CONFIRMING...' : status === 'confirmed' ? 'SWAP COMPLETE' : status === 'error' ? 'TRY AGAIN' : quote ? 'CONFIRM SWAP' : 'GET LIVE QUOTE'}</button>
      {quote && <div className="swap-quote-box"><div className="swap-quote-rate"><span>1 {fromToken.symbol} ≈ {formatEvmAmount(quote.buyAmount, quote.buyDecimals || 6)} {toToken.symbol}</span></div><div className="swap-quote-row"><span>Network</span><strong>Ethereum Mainnet</strong></div><div className="swap-quote-row"><span>Route</span><strong>0x</strong></div><div className="swap-quote-row"><span>Gas estimate</span><strong>{quote.transaction?.gas ? `${quote.transaction.gas} gas` : '—'}</strong></div><div className="swap-quote-row"><span>Treasury fee</span><strong>{quote.swapFeeBps != null ? `${Number(quote.swapFeeBps) / 100}%` : '—'}</strong></div><div className="swap-quote-row"><span>Minimum Received</span><strong>{quote.buyAmount ? `${formatEvmAmount(quote.buyAmount, quote.buyDecimals || 6)} ${toToken.symbol}` : '—'}</strong></div></div>}
      {status === 'confirmed' && (() => {
        const points = completion?.points ?? completion?.pointsRecord ?? completion?.samuraiPoints ?? null
        const pointsAwarded = Number(
          points?.points_awarded ??
          points?.pointsAwarded ??
          points?.final_points ??
          points?.finalPoints ??
          0
        )
        const qualified = points?.eligibility_status === 'qualified' || points?.qualified === true || pointsAwarded > 0
        const hasPointsRecord = hasUsablePointsRecord(completion)
        const seasonPoints = Number(points?.season_points ?? points?.walletSeasonPoints ?? 0)
        const qualifyingVolumeUsd = Number(points?.qualifying_volume_usd ?? points?.qualifyingVolumeUsd ?? 0)
        const reason = points?.reason || points?.exclusionReason || points?.exclusion_reason || 'NOT_QUALIFIED'

        return (
          <div className="swap-result-box swap-result-success">
            <h4>⚔️ SWAP COMPLETE</h4>
            <p><strong>You Paid:</strong> {amount || '0'} {fromToken.symbol}</p>
            <p><strong>You Received:</strong> {quote ? `${formatEvmAmount(quote.buyAmount, quote.buyDecimals || 6)} ${toToken.symbol}` : '—'}</p>
            <p><strong>Status:</strong> Confirmed</p>
            <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,.14)' }}>
              <p style={{ margin: '0 0 4px', color: qualified ? 'var(--gold)' : 'var(--red-dark)' }}>
                <strong>{qualified ? `+${pointsAwarded.toLocaleString()} Samurai Points` : hasPointsRecord ? '0 Samurai Points' : 'Samurai Points unavailable'}</strong>
              </p>
              {qualified && (
                <>
                  <p style={{ margin: '4px 0', color: 'var(--ink)' }}>Season Points: {seasonPoints.toLocaleString()}</p>
                  <p style={{ margin: '4px 0', color: 'var(--ink)' }}>Qualifying Volume: ${qualifyingVolumeUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })}</p>
                </>
              )}
              {hasPointsRecord && !qualified && <p style={{ margin: '4px 0', color: 'var(--red-dark)' }}>Reason: {String(reason).replaceAll('_', ' ')}</p>}
              {!hasPointsRecord && <p style={{ margin: '4px 0', color: 'var(--red-dark)' }}>Reason: backend did not return a points record for this swap.</p>}
            </div>
            {txHash && (
              <>
                <p style={{ margin: '8px 0 4px' }}><strong>Transaction:</strong> {`${txHash.slice(0, 5)}...${txHash.slice(-5)}`}</p>
                <button type="button" className="swap-token-result" onClick={() => navigator.clipboard?.writeText?.(txHash) || null}>Copy Txn</button>
              </>
            )}
          </div>
        )
      })()}
      {status === 'error' && <div className="swap-result-box swap-result-error"><h4>SWAP FAILED</h4><p>{message || 'The Ethereum swap could not be completed.'}</p><p>Review the wallet message and try again.</p></div>}
      {statusMessage && status !== 'confirmed' && status !== 'error' && <p className="swap-widget-foot">{statusMessage}</p>}
      {message && status !== 'confirmed' && status !== 'error' && <p className="swap-widget-foot" style={{ color: '#ba3c3c' }}>{message}</p>}
      {txHash && <p className="evm-success">Transaction: {txHash.slice(0, 10)}...{txHash.slice(-8)}</p>}
      <p className="swap-widget-foot"><Icon name="shield" size={12} /> {status === 'confirmed' ? 'Swap confirmed on Ethereum Mainnet.' : 'Secure. Non-Custodial. Powered by 0x on Ethereum Mainnet.'}</p>
      {pickerSide && <EthereumTokenSelector side={pickerSide} selected={pickerSide === 'from' ? fromToken : toToken} other={pickerSide === 'from' ? toToken : fromToken} onSelect={(token) => pickerSide === 'from' ? setFromToken(token) : setToToken(token)} onClose={() => setPickerSide(null)} />}
    </div>
  )
}

const ROBINHOOD_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ROBINHOOD_NATIVE_TOKEN = Object.freeze({ chainId: 4663, chainKey: 'robinhood', type: 'native', address: null, symbol: 'ETH', name: 'Ether', decimals: 18 })
const ROBINHOOD_TOKEN_FILTERS = ['all', 'tokens', 'memes', 'pop', 'trending']

function robinhoodTokenKey(token) {
  return token?.type === 'native' ? 'native' : String(token?.address || '').toLowerCase()
}

function robinhoodTokenAddress(token) {
  return token?.type === 'native' ? ROBINHOOD_ZERO_ADDRESS : token.address
}

function normalizeRobinhoodUiAmount(value, decimals) {
  const text = String(value || '').trim().replace(',', '.')
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > decimals) return null
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals))
}

function isSuccessfulRobinhoodReceipt(receipt) {
  const status = receipt?.status
  return status === '0x1' || status === '0x01' || status === 1 || status === '1' || status === true
}

function RobinhoodTokenSelector({ side, selected, other, sections, onSelect, onClose }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [trending, setTrending] = useState({ state: 'idle', results: [] })
  const query = search.trim().toLowerCase()

  useEffect(() => {
    if (filter !== 'trending' || trending.state !== 'idle') return undefined
    let cancelled = false
    setTrending({ state: 'loading', results: [] })
    getRobinhoodTrending()
      .then((body) => { if (!cancelled) setTrending({ state: body.dataAvailable ? 'ready' : 'empty', results: body.results || [] }) })
      .catch(() => { if (!cancelled) setTrending({ state: 'error', results: [] }) })
    return () => { cancelled = true }
  }, [filter, trending.state])

  const baseList = filter === 'tokens' ? sections.tokens
    : filter === 'memes' ? sections.memes
    : filter === 'pop' ? sections.popular
    : filter === 'trending' ? trending.results.map((item) => ({ chainId: 4663, chainKey: 'robinhood', type: 'erc20', address: item.address, symbol: item.symbol, name: item.name, decimals: item.decimals, logoURI: item.logoURI, isMeme: false, activity: item.activity }))
    : sections.all

  const results = [ROBINHOOD_NATIVE_TOKEN, ...baseList]
    .filter((token) => robinhoodTokenKey(token) !== robinhoodTokenKey(other))
    .filter((token) => !query || `${token.symbol} ${token.name} ${token.address || 'native'}`.toLowerCase().includes(query))

  const choose = (token) => { onSelect(token); onClose() }

  return createPortal(
    <div className="swap-token-picker-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="swap-token-picker" role="dialog" aria-modal="true" aria-label={`Select Robinhood ${side} token`}>
        <div className="swap-token-picker-head"><div><span className="swap-field-label">SELECT {side.toUpperCase()} TOKEN</span><strong>{selected.symbol}</strong></div><button type="button" className="swap-token-picker-close" onClick={onClose} aria-label="Close token selector">×</button></div>
        <input className="swap-token-search" autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Robinhood token" aria-label="Search Robinhood tokens" />
        <div className="swap-token-filters" role="tablist" aria-label="Robinhood token filter" style={{ margin: '0 0 10px' }}>
          {ROBINHOOD_TOKEN_FILTERS.map((entry) => <button type="button" role="tab" aria-selected={filter === entry} className={filter === entry ? 'active' : ''} key={entry} onClick={() => setFilter(entry)}>{entry}</button>)}
        </div>
        {filter === 'trending' && trending.state === 'loading' && <p className="swap-token-empty-state">Loading live trending data...</p>}
        {filter === 'trending' && trending.state === 'error' && <p className="swap-token-empty-state">Live trending data is unavailable.</p>}
        <div className="swap-token-results" role="listbox">
          {results.length ? results.map((token) => (
            <button type="button" className="swap-token-result" key={robinhoodTokenKey(token)} onClick={() => choose(token)} role="option">
              <TokenMark token={token} size={30} />
              <span className="swap-token-result-copy"><strong>{token.symbol}</strong><small>{token.name}</small><small>{token.type === 'native' ? 'Native ETH' : shortMint(token.address)}</small></span>
              <span className="swap-token-trust">{token.type === 'native' ? 'NATIVE' : token.isMeme ? 'MEME' : 'CATALOG'}</span>
            </button>
          )) : <p className="swap-token-empty-state">No token matches that search in this filter.</p>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function RobinhoodSwapPanel() {
  const [account, setAccount] = useState('')
  const [sections, setSections] = useState({ all: [], tokens: [], memes: [], popular: [] })
  const [sectionsState, setSectionsState] = useState('loading')
  const [fromToken, setFromToken] = useState(ROBINHOOD_NATIVE_TOKEN)
  const [toToken, setToToken] = useState(ROBINHOOD_NATIVE_TOKEN)
  const [pickerSide, setPickerSide] = useState(null)
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState(null)
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const [txHash, setTxHash] = useState('')
  const [completion, setCompletion] = useState(null)
  const executeInFlightRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    getRobinhoodTokenSections()
      .then((body) => {
        if (cancelled) return
        const nextSections = { all: body.sections?.all || [], tokens: body.sections?.tokens || [], memes: body.sections?.memes || [], popular: body.sections?.popular || [] }
        setSections(nextSections)
        setSectionsState(body.dataAvailable ? 'ready' : 'empty')
        setToToken((current) => (current.type === 'native' && nextSections.all[0] ? nextSections.all[0] : current))
      })
      .catch(() => { if (!cancelled) setSectionsState('error') })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const provider = getEthereumProvider()
    if (!provider) return undefined
    const refresh = async () => {
      try { setAccount((await provider.request({ method: 'eth_accounts' }))?.[0] || '') } catch { setAccount('') }
    }
    const changed = (accounts) => { setAccount(accounts?.[0] || ''); setQuote(null); setMessage('Wallet account changed. Request a fresh quote.') }
    const chainChanged = () => { setQuote(null); setMessage('Network changed. Robinhood quotes were cleared.') }
    refresh(); provider.on?.('accountsChanged', changed); provider.on?.('chainChanged', chainChanged)
    return () => { provider.removeListener?.('accountsChanged', changed); provider.removeListener?.('chainChanged', chainChanged) }
  }, [])

  useEffect(() => {
    setQuote(null)
    setTxHash('')
    setCompletion(null)
    if (status !== 'idle') setStatus('idle')
  }, [fromToken, toToken, amount, account])

  const connect = async () => {
    try { setMessage(''); setAccount(await connectRobinhoodWallet()) } catch (error) { setMessage(error.message) }
  }

  const loadQuote = async (wallet) => {
    const rawAmount = normalizeRobinhoodUiAmount(amount, fromToken.decimals || 18)
    if (!rawAmount || rawAmount <= 0n) throw new Error('Enter a valid amount greater than zero.')
    if (robinhoodTokenAddress(fromToken) === robinhoodTokenAddress(toToken)) throw new Error('Select two different tokens.')
    const nextQuote = await getLifiQuote({
      fromChain: 4663,
      toChain: 4663,
      fromToken: robinhoodTokenAddress(fromToken),
      toToken: robinhoodTokenAddress(toToken),
      fromAmount: rawAmount.toString(),
      fromAddress: wallet,
      toAddress: wallet,
      slippage: 0.01,
    })
    if (!nextQuote?.transactionRequest || !nextQuote.quoteId) throw new Error('LI.FI returned an incomplete route for this pair.')
    setQuote(nextQuote)
    return nextQuote
  }

  const requestQuote = async () => {
    try {
      setStatus('loading'); setMessage(''); setQuote(null)
      const wallet = account || await connectRobinhoodWallet()
      setAccount(wallet)
      await ensureRobinhoodChain(getEthereumProvider())
      await loadQuote(wallet)
      setStatus('ready')
    } catch (error) { setStatus('error'); setMessage(error.message || 'Robinhood quote unavailable.') }
  }

  const pollStatus = async (hash) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await getLifiStatus({ txHash: hash, fromChain: 4663, toChain: 4663 })
      if (lifiStatusIsComplete(response)) return response
      if (lifiStatusIsFailed(response)) throw new Error(response?.message || response?.error || 'LI.FI reported this swap as failed.')
      await new Promise((resolve) => window.setTimeout(resolve, 3_000))
    }
    throw new Error('LI.FI confirmation timed out. Please check the route and try again.')
  }

  const execute = async () => {
    if (executeInFlightRef.current) return
    executeInFlightRef.current = true
    try {
      setStatus('loading'); setMessage('Requesting a fresh LI.FI quote...'); setCompletion(null)
      const provider = getEthereumProvider()
      if (!provider) throw new Error('MetaMask is not installed.')
      await ensureRobinhoodChain(provider)
      const accounts = await provider.request({ method: 'eth_accounts' })
      const wallet = accounts?.[0]
      if (!wallet) throw new Error('Connect MetaMask to continue.')
      if (account && wallet.toLowerCase() !== account.toLowerCase()) throw new Error('Wallet changed. Request a fresh quote.')
      setAccount(wallet)
      const freshQuote = await loadQuote(wallet)
      const approvalRequest = getLifiApprovalRequest(freshQuote)
      if (approvalRequest) {
        setStatus('approval_required')
        setMessage('Approval required. Review the token allowance in MetaMask.')
        const approvalHash = await approveLifiTransaction({ provider, approvalRequest, expectedChainId: 4663, wallet })
        setStatus('approval_pending')
        setMessage(`Approval submitted: ${approvalHash}`)
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [approvalHash] })
          if (receipt) {
            if (receipt.status !== '0x1') throw new Error('Token approval failed.')
            break
          }
          await new Promise((resolve) => window.setTimeout(resolve, 2_000))
        }
        setStatus('approval_confirmed')
        setMessage('Approval confirmed. Refreshing quote...')
      }
      const hash = await sendLifiTransaction({ provider, transactionRequest: freshQuote.transactionRequest, expectedChainId: 4663, wallet })
      setTxHash(hash)
      setStatus('pending')
      setMessage('Swap submitted. Tracking LI.FI status...')
      let finalStatus
      try {
        finalStatus = await pollStatus(hash)
      } catch (pollError) {
        const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] })
        if (!isSuccessfulRobinhoodReceipt(receipt)) throw pollError
        finalStatus = { status: 'DONE', state: 'DONE', source: 'ROBINHOOD_RECEIPT_FALLBACK', receipt }
        setMessage('Swap confirmed on-chain. LI.FI status was delayed, so the receipt was used to complete recording.')
      }
      if (!lifiStatusIsComplete(finalStatus)) throw new Error(finalStatus?.message || 'LI.FI has not confirmed a successful swap.')
      setStatus('confirmed')
      setMessage('Swap confirmed. Recording swap and Samurai Points...')
      const completionResponse = await fetch('/api/lifi/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionHash: hash,
          wallet,
          fromChain: 4663,
          toChain: 4663,
          fromToken: robinhoodTokenAddress(fromToken),
          toToken: robinhoodTokenAddress(toToken),
          fromAmount: freshQuote.inputAmount,
          toAmount: freshQuote.expectedOutput,
          quoteId: freshQuote.quoteId,
          quoteProof: freshQuote.quoteProof,
        }),
      })
      const completionBody = await completionResponse.json().catch(() => ({}))
      if (!completionResponse.ok || !completionBody.success) throw new Error(completionBody.error || 'This swap was confirmed on-chain but could not be recorded.')
      setCompletion(completionBody)
      setMessage(completionBody?.points?.qualified ? `Swap confirmed. +${Number(completionBody.points.pointsAwarded || 0).toLocaleString()} Samurai Points.` : 'Swap confirmed. This transaction did not qualify for Samurai Points.')
    } catch (error) {
      const messageText = error?.message || 'Robinhood swap failed.'
      const timedOut = /timeout|aborted|AbortError/i.test(messageText)
      setStatus(timedOut ? 'confirmed' : 'error')
      setMessage(timedOut
        ? 'Transaction confirmed on-chain, but the backend timed out while recording it. Please refresh or recheck the swap history.'
        : /4001|rejected/i.test(messageText) ? 'Transaction cancelled in MetaMask.' : messageText)
    } finally {
      executeInFlightRef.current = false
    }
  }

  const busy = ['loading', 'approval_required', 'approval_pending', 'approval_confirmed', 'signing', 'pending'].includes(status)
  const quoteOutputAmount = quote?.expectedOutput ? formatTokenAmount(quote.expectedOutput, toToken.decimals || 18, 6) : ''
  const submit = () => { if (!account) return connect(); if (quote) return execute(); return requestQuote() }

  return (
    <div className="evm-swap-panel">
      <div className="swap-widget-head">
        <div>
          <h3>RONIN SWAP</h3>
          <span className="swap-widget-powered">Powered by <b>LI.FI</b> · Robinhood Chain</span>
          <span className="swap-contract-status">CONTRACT IN DEVELOPMENT</span>
        </div>
        <button type="button" className="swap-widget-gear" aria-label="Swap settings" disabled><Icon name="settings" size={18} /></button>
      </div>
      {account && <div className="swap-wallet-strip" style={{ marginBottom: '12px', display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px', color: '#ff5c5c', background: 'rgba(255, 92, 92, 0.08)', border: '1px solid rgba(255, 92, 92, 0.32)', borderRadius: '10px', padding: '8px 10px' }}><span style={{ color: '#ff8d8d' }}>Wallet</span><strong style={{ color: '#ff5c5c', fontFamily: 'var(--mono)' }}>{account.slice(0, 6)}...{account.slice(-4)}</strong></div>}
      <div className="swap-widget-tabs" role="tablist" aria-label="Swap mode"><button type="button" role="tab" aria-selected="true" className="active">SWAP</button><button type="button" role="tab" aria-selected="false" disabled>LIMIT ORDER <span className="swap-soon-chip">SOON</span></button></div>
      <div className="swap-field">
        <span className="swap-field-label">YOU PAY</span>
        <div className="swap-field-row"><input className="swap-field-input" disabled={busy} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0" inputMode="decimal" aria-label="Amount you pay" /><button type="button" className="swap-token-select" disabled={busy} onClick={() => setPickerSide('from')}><TokenMark token={fromToken} /><strong>{fromToken.symbol}</strong><Icon name="chevronDown" size={14} /></button></div>
        <div className="swap-field-foot"><span>$0.00</span><span>Robinhood Chain · 4663</span></div>
      </div>
      <div className="swap-flip-row"><button type="button" className="swap-flip" disabled={busy} onClick={() => { setFromToken(toToken); setToToken(fromToken); setQuote(null) }} aria-label="Reverse Robinhood swap"><Icon name="swapVertical" size={16} /></button></div>
      <div className="swap-field">
        <span className="swap-field-label">YOU RECEIVE</span>
        <div className="swap-field-row"><input className="swap-field-input" readOnly value={quoteOutputAmount} placeholder="0.0" aria-label="Amount you receive" /><button type="button" className="swap-token-select" disabled={busy} onClick={() => setPickerSide('to')}><TokenMark token={toToken} /><strong>{toToken.symbol}</strong><Icon name="chevronDown" size={14} /></button></div>
        <div className="swap-field-foot"><span>$0.00</span><span>{sectionsState === 'loading' ? 'Loading live catalog…' : sectionsState === 'error' ? 'Live catalog unavailable' : `${sections.all.length} tokens indexed`}</span></div>
      </div>
      <button type="button" className="swap-cta" disabled={busy} onClick={submit}>{!account ? 'CONNECT METAMASK TO SWAP' : status === 'loading' ? 'FINDING BEST ROUTE...' : status === 'approval_pending' ? 'APPROVAL PENDING...' : status === 'pending' ? 'CONFIRMING...' : status === 'confirmed' ? 'SWAP COMPLETE' : status === 'error' ? 'TRY AGAIN' : quote ? 'CONFIRM SWAP' : 'GET LIVE QUOTE'}</button>
      {quote && <div className="swap-quote-box"><div className="swap-quote-rate"><span>1 {fromToken.symbol} ≈ {quoteOutputAmount || '0.00'} {toToken.symbol}</span></div><div className="swap-quote-row"><span>Network</span><strong>Robinhood Chain</strong></div><div className="swap-quote-row"><span>Route</span><strong>{quote?.tool?.name || quote?.provider || 'LI.FI'}</strong></div><div className="swap-quote-row"><span>Quote ID</span><strong>{quote?.quoteId || '—'}</strong></div><div className="swap-quote-row"><span>Minimum Received</span><strong>{quote.minimumReceived ? formatTokenAmount(quote.minimumReceived, toToken.decimals || 18, 6) : '—'}</strong></div></div>}
      {status === 'confirmed' && <div className="swap-result-box swap-result-success"><h4>⚔️ SWAP COMPLETE</h4><p><strong>You Paid:</strong> {amount || '0'} {fromToken.symbol}</p><p><strong>You Received:</strong> {quoteOutputAmount ? `${quoteOutputAmount} ${toToken.symbol}` : '—'}</p><p><strong>Status:</strong> Confirmed</p><div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,.14)' }}><p style={{ margin: '0 0 4px', color: completion?.points?.qualified ? 'var(--gold)' : 'var(--red-dark)' }}><strong>{completion?.points?.qualified ? `+${Number(completion.points.pointsAwarded || completion.points.points_awarded || 0).toLocaleString()} Samurai Points` : completion?.points ? '0 Samurai Points' : 'Samurai Points unavailable'}</strong></p>{completion?.points?.qualified && <p style={{ margin: '4px 0', color: 'var(--ink)' }}>Qualifying Volume: ${Number(completion.points.qualifyingVolumeUsd || completion.points.qualifying_volume_usd || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}</p>}{completion?.points && !completion.points.qualified && <p style={{ margin: '4px 0', color: 'var(--red-dark)' }}>Reason: {(completion.points.reason || 'NOT_QUALIFIED').replaceAll('_', ' ')}</p>}</div>{txHash && <p style={{ margin: '8px 0 4px' }}><strong>Transaction:</strong> {txHash.slice(0, 10)}...{txHash.slice(-8)}</p>}</div>}
      {status === 'error' && <div className="swap-result-box swap-result-error"><h4>SWAP FAILED</h4><p>{message || 'The Robinhood swap could not be completed.'}</p></div>}
      {status !== 'confirmed' && status !== 'error' && message && <p className="swap-widget-foot">{message}</p>}
      {txHash && status !== 'confirmed' && <p className="evm-success">Transaction: {txHash.slice(0, 10)}...{txHash.slice(-8)}</p>}
      <p className="swap-widget-foot"><Icon name="shield" size={12} /> Secure. Non-Custodial. Powered by LI.FI on Robinhood Chain.</p>
      {pickerSide && <RobinhoodTokenSelector side={pickerSide} selected={pickerSide === 'from' ? fromToken : toToken} other={pickerSide === 'from' ? toToken : fromToken} sections={sections} onSelect={(token) => (pickerSide === 'from' ? setFromToken(token) : setToToken(token))} onClose={() => setPickerSide(null)} />}
    </div>
  )
}

function UnifiedSwapHistory({ solanaWallet }) {
  const [chain, setChain] = useState('all')
  const [wallet, setWallet] = useState(solanaWallet || '')
  const [rows, setRows] = useState([])
  const [state, setState] = useState('idle')
  const [historyOpen, setHistoryOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      let address = solanaWallet || ''
      try { address = (await getEthereumProvider()?.request({ method: 'eth_accounts' }))?.[0] || address } catch {}
      if (!address) { setWallet(''); setRows([]); return }
      setWallet(address); setState('loading')
      try {
        const response = await fetch(`/api/swap/history?wallet=${encodeURIComponent(address)}&chain=${chain}`)
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'History unavailable.')
        if (!cancelled) { setRows(Array.isArray(body.swaps) ? body.swaps : []); setState('ready') }
      } catch { if (!cancelled) { setRows([]); setState('error') } }
    }
    load()
    return () => { cancelled = true }
  }, [solanaWallet, chain])

  return <section className="swap-history section"><div className="swap-history-head"><div><span className="data-label">CONFIRMED ACTIVITY</span><h2>Swap history.</h2></div><button type="button" className={`swap-history-toggle ${historyOpen ? 'is-open' : ''}`} onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen}>{historyOpen ? 'Hide all transactions' : 'See all transactions'}<span aria-hidden="true">⌄</span></button></div>{historyOpen && <div className="swap-history-dropdown"><div className="swap-history-filters" role="tablist" aria-label="Swap history network"><button className={chain === 'all' ? 'active' : ''} onClick={() => setChain('all')}>All</button><button className={chain === 'solana' ? 'active' : ''} onClick={() => setChain('solana')}>Solana</button><button className={chain === 'ethereum' ? 'active' : ''} onClick={() => setChain('ethereum')}>Ethereum</button><button className={chain === 'robinhood' ? 'active' : ''} onClick={() => setChain('robinhood')}>Robinhood</button></div>{!wallet && <p className="swap-history-empty">Connect a wallet to view confirmed swaps.</p>}{wallet && state === 'loading' && <p className="swap-history-empty">Loading confirmed swaps...</p>}{wallet && state === 'error' && <p className="swap-history-empty">Swap history is unavailable right now.</p>}{wallet && state === 'ready' && !rows.length && <p className="swap-history-empty">No confirmed swaps for this wallet yet.</p>}{rows.length > 0 && <div className="swap-history-table-wrap"><table className="swap-history-table"><thead><tr><th>Network</th><th>Pair</th><th>Volume</th><th>Status</th><th>Points</th><th>Date</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.chain_id}:${row.transaction_hash || row.signature}`}><td>{Number(row.chain_id) === 1 ? 'Ethereum' : Number(row.chain_id) === 4663 ? 'Robinhood' : 'Solana'}</td><td>{row.input_mint === 'native' ? 'ETH' : String(row.input_mint || '').slice(0, 8)} → {row.output_mint === 'native' ? 'ETH' : String(row.output_mint || '').slice(0, 8)}</td><td>{row.volume_usd == null ? '—' : `$${Number(row.volume_usd).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}</td><td>{row.status || 'CONFIRMED'}</td><td>{Number(row.points_awarded || 0).toLocaleString()}</td><td>{row.timestamp ? new Date(row.timestamp).toLocaleDateString() : '—'}</td></tr>)}</tbody></table></div>}</div>}</section>
}

function TokenMark({ token, size = 25 }) {
  const [imageFailed, setImageFailed] = useState(false)
  const logoUri = token?.logoURI || token?.logo || token?.icon || token?.image || token?.fallbackLogoURI || null

  useEffect(() => {
    setImageFailed(false)
  }, [logoUri])

  if (logoUri && !imageFailed) {
    return <img className="swap-token-dot swap-token-logo" src={logoUri} alt="" width={size} height={size} onError={(event) => {
      if (token?.fallbackLogoURI && event.currentTarget.src !== token.fallbackLogoURI) {
        event.currentTarget.src = token.fallbackLogoURI
        return
      }
      setImageFailed(true)
    }} />
  }

  return <span className={`swap-token-dot ${token.className || 'tok-empty'}`} aria-hidden="true">{token.glyph || token.symbol?.slice(0, 1) || '?'}</span>
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

  const walletBalanceMap = useMemo(() => {
    const map = new Map()
    if (!window.__RONIN_SWAP_WALLET_TOKENS) return map
    for (const token of window.__RONIN_SWAP_WALLET_TOKENS) {
      map.set(String(token.mint), Number(token.amount || 0))
    }
    return map
  }, [])

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
          {results.length ? results.map((token) => {
            const balance = walletBalanceMap.get(token.mint)
            return (
              <button type="button" className="swap-token-result" key={token.mint} onClick={() => choose(token)} role="option">
                <TokenMark token={token} size={30} />
                <span className="swap-token-result-copy"><strong>{token.symbol}</strong><small>{token.name}</small><small>{shortMint(token.mint)}</small></span>
                <span className="swap-token-trust" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
                  <span>{token.trust}</span>
                  {typeof balance === 'number' && balance > 0 && <small style={{ color: '#ff8d8d', fontSize: '10px' }}>{balance.toLocaleString(undefined, { maximumFractionDigits: 6 })}</small>}
                </span>
              </button>
            )
          }) : <p className="swap-token-empty-state">No validated token matches that search.</p>}
        </div>
      </div>
    </div>
  )
}

export default function Swap() {
  const { wallet, openWalletModal, liveStats, liveStatsState } = useWallet()
  const [network, setNetwork] = useState('solana')
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
  const [txSignature, setTxSignature] = useState('')
  const [verificationStatus, setVerificationStatus] = useState('idle')
  const [verificationResult, setVerificationResult] = useState(null)
  const [persistenceStatus, setPersistenceStatus] = useState('idle')
  const [pointsResult, setPointsResult] = useState(null)
  const [pointsError, setPointsError] = useState('')
  const [receivedAmount, setReceivedAmount] = useState(null)
  const [quoteMeta, setQuoteMeta] = useState(null)
  const [solBalance, setSolBalance] = useState(null)
  const [roninBalance, setRoninBalance] = useState(null)
  const [walletTokens, setWalletTokens] = useState([])
  const [robinhoodSections, setRobinhoodSections] = useState({ all: [], tokens: [], memes: [], popular: [] })
  const [trendingTimeframe, setTrendingTimeframe] = useState('24h')
  const [trendingState, setTrendingState] = useState({ state: 'idle', results: [], chain: null, timeframe: '24h' })
  const [trendingRetry, setTrendingRetry] = useState(0)
  const swapInFlightRef = useRef(false)
  const paused = !SWAP_ENABLED
  const quoteAmountRaw = rawAmountFromUi(amountInput, fromToken?.decimals || 9)

  useEffect(() => {
    setQuote(null)
    setQuoteMeta(null)
    setQuoteState('idle')
    setTxState('idle')
    setTxError('')
    setPointsResult(null)
  }, [network])

  useEffect(() => {
    if (network !== 'robinhood') return undefined
    let cancelled = false
    getRobinhoodTokenSections().then((body) => {
      if (!cancelled) setRobinhoodSections({ all: body.sections?.all || [], tokens: body.sections?.tokens || [], memes: body.sections?.memes || [], popular: body.sections?.popular || [] })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [network])

  useEffect(() => {
    let cancelled = false
    const chain = network === 'robinhood' ? 'robinhood' : network
    setTrendingState((current) => ({ ...current, state: 'loading', chain, timeframe: trendingTimeframe }))
    const loadTrending = async () => {
      try {
        const body = await getLiveTrendingTokens({ chain, timeframe: trendingTimeframe })
        if (!cancelled) setTrendingState({ state: body.dataAvailable ? 'ready' : 'empty', results: body.tokens || [], chain, timeframe: trendingTimeframe })
      } catch {
        if (!cancelled) setTrendingState({ state: 'error', results: [], chain, timeframe: trendingTimeframe })
      }
    }
    loadTrending()
    const interval = window.setInterval(loadTrending, 45_000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [network, trendingTimeframe, trendingRetry])

  const dashboardTrending = trendingState.chain === network ? trendingState.results : []
  const visibleTokens = network === 'ethereum'
    ? (tokenFilter === 'trending'
      ? dashboardTrending
      : tokenFilter === 'tokens'
        ? ETHEREUM_FEATURED_TOKENS
        : ETHEREUM_FEATURED_SECTIONS[tokenFilter]?.map((symbol) => ETHEREUM_FEATURED_TOKENS.find((token) => token.symbol === symbol)).filter(Boolean) || [])
    : network === 'robinhood'
      ? (tokenFilter === 'trending' ? dashboardTrending : tokenFilter === 'memes' ? robinhoodSections.memes : tokenFilter === 'pop' ? robinhoodSections.popular : tokenFilter === 'tokens' ? robinhoodSections.tokens : robinhoodSections.all)
      : tokenFilter === 'tokens'
        ? TRUSTED_TOKENS
        : tokenFilter === 'trending'
          ? dashboardTrending
          : TRUSTED_TOKENS.filter((token) => token.section.includes(tokenFilter))

  useEffect(() => {
    if (!wallet?.address || !isValidWalletAddress(wallet.address)) return undefined
    let cancelled = false
    const loadBalances = async () => {
      try {
        const [solResult, roninResult, tokenResult] = await Promise.all([
          getSolBalance(wallet.address),
          getRoninBalance(wallet.address),
          getAllTokenAccounts(wallet.address),
        ])
        if (cancelled) return

        const tokenList = (tokenResult?.accounts || [])
          .map((token) => {
            const tokenMeta = TRUSTED_TOKENS.find((entry) => entry.mint === token.mint)
            const uiAmount = Number(token.uiAmount ?? token.uiAmountString ?? '0')
            return {
              mint: token.mint,
              symbol: token.symbol || tokenMeta?.symbol || 'TOKEN',
              name: token.name || tokenMeta?.name || 'Unknown token',
              amount: Number.isFinite(uiAmount) ? uiAmount : 0,
              decimals: Number(token.decimals ?? tokenMeta?.decimals ?? 0),
              logo: token.logo || tokenMeta?.logoURI || null,
            }
          })
          .filter((token) => token.amount > 0)

        const solEntry = solResult?.sol > 0 ? {
          mint: SOL_MINT,
          symbol: 'SOL',
          name: 'Solana',
          amount: Number(solResult.sol),
          decimals: 9,
          logo: null,
        } : null

        const roninEntry = roninResult?.amount > 0 ? {
          mint: RONIN_MINT,
          symbol: 'RONIN',
          name: 'RONIN',
          amount: Number(roninResult.amount),
          decimals: Number(roninResult.decimals || 6),
          logo: null,
        } : null

        const merged = [solEntry, roninEntry, ...tokenList].filter(Boolean)
        const deduped = new Map()
        for (const item of merged) deduped.set(item.mint, item)
        const tokenBalances = Array.from(deduped.values()).sort((a, b) => b.amount - a.amount)
        setWalletTokens(tokenBalances)
        window.__RONIN_SWAP_WALLET_TOKENS = tokenBalances
        setSolBalance(solResult?.sol ?? 0)
        setRoninBalance(roninResult?.amount ?? 0)
      } catch {
        if (!cancelled) {
          setSolBalance(null)
          setRoninBalance(null)
          setWalletTokens([])
          delete window.__RONIN_SWAP_WALLET_TOKENS
        }
      }
    }
    loadBalances()
    const interval = window.setInterval(loadBalances, 30000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [wallet?.address])

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
        const errorMessage = error?.message || ''
        setQuoteError(/insufficient funds/i.test(errorMessage)
          ? 'Insufficient SOL for transaction fees. Add SOL to this wallet and try again.'
          : /failed to get quotes|could not get quote|no route|not found/i.test(errorMessage)
            ? 'Jupiter could not price this pair for your wallet. Try a smaller amount, swap direction, or refresh in a moment.'
            : errorMessage || 'Unable to price this pair right now.')
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

  const walletTokenMap = useMemo(() => {
    const map = new Map()
    for (const token of walletTokens) {
      map.set(String(token.mint), Number(token.amount || 0))
    }
    if (solBalance != null) map.set(String(SOL_MINT), Number(solBalance))
    if (roninBalance != null) map.set(String(RONIN_MINT), Number(roninBalance))
    return map
  }, [roninBalance, solBalance, walletTokens])

  const fromTokenBalance = useMemo(() => {
    if (!wallet?.address) return null
    return walletTokenMap.get(String(fromToken?.mint)) ?? null
  }, [fromToken?.mint, wallet?.address, walletTokenMap])

  const toTokenBalance = useMemo(() => {
    if (!wallet?.address) return null
    return walletTokenMap.get(String(toToken?.mint)) ?? null
  }, [toToken?.mint, wallet?.address, walletTokenMap])

  const maxFromBalance = fromTokenBalance != null ? Number(fromTokenBalance) : null

  const dex = liveStats?.dex
  const pending = liveStatsState === 'loading' ? '…' : '—'
  const ecosystemStats = [
    { icon: 'chart', label: '24H VOLUME', value: formatUsd(dex?.volume24h) || pending, note: dex?.dexId ? `${dex.dexId} live` : 'DexScreener pending' },
    { icon: 'swapVertical', label: 'TOTAL SWAPS', value: dex?.transactions24h != null ? Number(dex.transactions24h).toLocaleString() : pending, note: dex?.transactions24h != null ? 'DexScreener live' : 'DexScreener pending' },
    { icon: 'users', label: 'HOLDERS', value: liveStats?.holdersCount ? Number(liveStats.holdersCount).toLocaleString() : pending, note: liveStats?.holdersCount ? 'Helius live' : 'Helius pending' },
    { icon: 'flame', label: 'LIQUIDITY', value: formatUsd(dex?.liquidityUsd) || pending, note: dex?.liquidityUsd ? 'DexScreener live' : 'pending' },
    { icon: 'award', label: 'ECOSYSTEM SUPPORT', value: '0.5%', note: 'Jupiter referral fee' },
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
    if (quoteMeta?.walletAddress && String(quoteMeta.walletAddress).toLowerCase() !== String(wallet.address).toLowerCase()) {
      return 'Wallet changed after the quote was prepared. Please request a fresh quote and review it again.'
    }
    // NOTE: we intentionally do NOT check `quote.transaction` here anymore.
    // The displayed quote may be a quote-only response (transaction: null)
    // from the auto-retry without taker — that's fine for showing a price.
    // The actual transaction check happens in handleSwapAction after it
    // re-fetches WITH the taker (requireTransaction: true), which surfaces
    // the real Jupiter error (Insufficient funds / wallet not supported).
    return ''
  }

  const invalidatePreparedSwap = (message = '') => {
    setQuote(null)
    setQuoteMeta(null)
    setQuoteState('idle')
    setTxState('idle')
    setTxError(message)
    setTxSignature('')
    setReceivedAmount(null)
  }

  const handleSwapAction = async (event) => {
    if (event) {
      event.preventDefault()
      event.stopPropagation()
    }
    if (!SWAP_ENABLED || swapInFlightRef.current) return false

    if (!wallet?.address) {
      openWalletModal()
      return false
    }

    swapInFlightRef.current = true
    setTxState('preparing')
    setTxError('')

    try {
      const rawAmount = rawAmountFromUi(amountInput, fromToken.decimals)
      if (!rawAmount || Number(rawAmount) <= 0) {
        throw new Error('Enter a valid amount to swap.')
      }

      // requireTransaction: true → do NOT auto-retry without taker.
      // At sign-time we NEED the real Jupiter error so we can tell the user
      // exactly what's wrong: "Insufficient SOL" (add SOL), "Failed to get
      // quotes" (wallet not supported), or a real network error.
      const freshQuote = await getJupiterOrder({
        inputMint: fromToken.mint,
        outputMint: toToken.mint,
        amountLamports: rawAmount,
        slippageBps: 100,
        taker: wallet.address,
        requireTransaction: true,
      })

      if (!freshQuote || !freshQuote.transaction || !validateUnsignedTransactionPayload(freshQuote.transaction)) {
        // Distinguish "Insufficient funds" (Jupiter returned a price but no
        // signable tx) from a real invalid-payload error.
        if (freshQuote?.error === 'Insufficient funds' || freshQuote?.errorCode === 1 || /insufficient funds/i.test(freshQuote?.errorMessage || '')) {
          throw new Error('Insufficient SOL balance for this swap. Add SOL to your wallet and try again.')
        }
        // If Jupiter returned a quote-only response (transaction: null) even
        // with the taker, the wallet is not supported by Jupiter's quote
        // engine for this pair. Surface a clear actionable message.
        if (freshQuote?.inAmount && freshQuote?.outAmount && !freshQuote?.transaction) {
          throw new Error('Jupiter could not build a signable transaction for this wallet. Try a smaller amount, or use a different wallet.')
        }
        // Jupiter returned nothing useful at all — surface the actual error.
        if (freshQuote?.error) {
          throw new Error(freshQuote.error === 'Failed to get quotes'
            ? 'Jupiter could not price this pair for your wallet right now. Try a slightly different amount or refresh in a moment.'
            : freshQuote.error)
        }
        throw new Error('Jupiter returned an invalid or missing unsigned transaction payload. Please request a fresh quote and try again.')
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
      return true
    } catch (error) {
      setQuote(null)
      setQuoteMeta(null)
      setQuoteState('error')
      setTxState('error')
      setTxError(error?.message || 'Unable to prepare the swap transaction. Please try again.')
      return false
    } finally {
      swapInFlightRef.current = false
    }
  }

  const executeSwap = async () => {
    if (!SWAP_ENABLED || swapInFlightRef.current) return
    if (!wallet?.address) {
      openWalletModal()
      return
    }

    const provider = getSolanaProvider()
    if (!provider) {
      setTxState('error')
      setTxError('Phantom wallet was not found. Please install Phantom to continue.')
      return
    }

    const requestError = validateSwapRequest()
    if (requestError) {
      if (/wallet changed|fresh quote/i.test(requestError)) {
        invalidatePreparedSwap(requestError)
        return
      }
      setTxState('error')
      setTxError(requestError)
      return
    }

    swapInFlightRef.current = true
    setTxState('signing')
    setTxError('')
    setTxSignature('')
    setReceivedAmount(null)
    setPointsResult(null)
    setPointsError('')

    try {
      const base64Transaction = quote.transaction
      const bytes = Uint8Array.from(atob(base64Transaction), (char) => char.charCodeAt(0))
      const transaction = VersionedTransaction.deserialize(bytes)

      if (typeof provider.signTransaction !== 'function') {
        throw new Error('The connected wallet does not expose signTransaction.')
      }

      const signed = await provider.signTransaction(transaction)
      const signedTransaction = Buffer.from(signed.serialize()).toString('base64')
      setTxState('submitted')

      const executeResult = await executeJupiterOrder({
        signedTransaction,
        requestId: quote.requestId,
        lastValidBlockHeight: quote.lastValidBlockHeight,
      })

      if (!executeResult?.signature || executeResult?.status === 'Failed' || executeResult?.status === 'error' || (executeResult?.code != null && Number(executeResult.code) !== 0)) {
        throw new Error(executeResult?.error || executeResult?.message || 'Jupiter execution failed.')
      }

      setTxState('confirming')
      await confirmSolanaTransaction(executeResult.signature, 120_000)

      setVerificationStatus('verifying')
      const verification = await verifySwapTransaction({ signature: executeResult.signature, wallet: wallet.address })
      setVerificationResult(verification)

      if (verification?.verified) {
        setVerificationStatus('verified')
        setPersistenceStatus('saving')
        try {
          await recordVerifiedSwap({ signature: executeResult.signature, wallet: wallet.address })
          setPersistenceStatus('saved')
          try {
            const points = await processSamuraiPoints({ signature: executeResult.signature })
            setPointsResult(points)
          } catch (pointsError) {
            console.error('Samurai Points processing failed:', pointsError)
            setPointsResult(null)
            setPointsError(pointsError?.message || 'Samurai Points could not be processed.')
          }
        } catch (persistenceError) {
          console.error('Verified swap persistence failed:', persistenceError)
          setPersistenceStatus('error')
          setPointsError(persistenceError?.message || 'Verified swap was not saved, so Samurai Points could not be calculated.')
        }
      } else if (verification?.status === 'pending') {
        setVerificationStatus('pending')
      } else if (verification?.status === 'failed' || verification?.reason === 'TRANSACTION_FAILED' || verification?.reason === 'WALLET_MISMATCH') {
        setVerificationStatus('failed')
      } else if (verification?.status === 'not_found') {
        setVerificationStatus('error')
      } else {
        setVerificationStatus('error')
      }

      const outputDecimals = toToken?.decimals || 6
      const outputRaw = executeResult?.outputAmountResult || executeResult?.outAmount || quote.outAmount || '0'
      const outputUi = Number(outputRaw) / 10 ** outputDecimals
      setReceivedAmount(Number.isFinite(outputUi) ? outputUi : null)

      if (verification?.verified) {
        setTxState('success')
      } else {
        setTxState('failed')
        setTxError(verification?.reason === 'WALLET_MISMATCH' ? 'The transaction was signed by a different wallet than the connected wallet.' : verification?.reason === 'TRANSACTION_FAILED' ? 'The on-chain transaction failed and cannot be verified as a successful swap.' : verification?.status === 'pending' ? 'The transaction is pending confirmation on-chain.' : 'Unable to verify this transaction on Solana.')
      }
      setTxSignature(executeResult.signature)
      if (verification?.verified) setTxError('')
    } catch (error) {
      const friendly = friendlySwapError(error)
      setTxState('failed')
      setTxError(friendly)
      setVerificationStatus('error')
      setVerificationResult(null)
      setPointsResult(null)
      setPointsError('')
    } finally {
      swapInFlightRef.current = false
    }
  }

  const verificationSummary = (() => {
    if (verificationStatus === 'verified') return 'Transaction verified'
    if (verificationStatus === 'verifying') return 'Verifying transaction...'
    if (verificationStatus === 'pending') return 'Waiting for transaction confirmation...'
    if (verificationStatus === 'failed') return 'Transaction failed verification'
    if (verificationStatus === 'error') return 'Unable to verify transaction. Please try again.'
    return ''
  })()

  return (
    <div className="swap-page">
      {/* ---------- HERO ---------- */}
      <section className="swap-hero-section">
        <div className="swap-hero-bg" aria-hidden="true">
            <img src="/images/hero-ronin.jpg" alt="" />
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
              <li><span className="swap-point-icon swap-point-icon-kanji">浪</span><div><strong>Built for the Clan</strong><p>Every swap supports the $RONIN ecosystem with a 0.5% Jupiter referral fee.</p></div></li>
            </ul>
          </div>

          {/* ---------- SWAP WIDGET ---------- */}
          <div className="swap-widget">
            <div className="swap-network-switch" role="tablist" aria-label="Swap network"><span>NETWORK</span><button type="button" className={network === 'solana' ? 'active' : ''} onClick={() => setNetwork('solana')}>Solana</button><button type="button" className={network === 'ethereum' ? 'active' : ''} onClick={() => setNetwork('ethereum')}>Ethereum</button><button type="button" className={network === 'robinhood' ? 'active' : ''} onClick={() => setNetwork('robinhood')}>Robinhood</button></div>
            {network === 'ethereum' ? <EthereumSwapPanel /> : network === 'robinhood' ? <RobinhoodSwapPanel /> : <>
            <div className="swap-widget-head">
              <div>
                <h3>RONIN SWAP</h3>
                <span className="swap-widget-powered">Powered by <JupiterMark size={15} /> <b>Jupiter</b></span>
                <span className="swap-contract-status">CONTRACT IN DEVELOPMENT</span>
              </div>
              <button type="button" className="swap-widget-gear" onClick={handleSwapAction} aria-label="Swap settings" aria-disabled={paused ? 'true' : undefined} disabled={paused}>
                <Icon name="settings" size={18} />
              </button>
            </div>

            {wallet?.address && (
              <div className="swap-wallet-strip" style={{ marginBottom: '12px', display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px', color: '#ff5c5c', background: 'rgba(255, 92, 92, 0.08)', border: '1px solid rgba(255, 92, 92, 0.32)', borderRadius: '10px', padding: '8px 10px' }}>
                <span style={{ color: '#ff8d8d' }}>Wallet</span>
                <strong style={{ color: '#ff5c5c', fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>{wallet.shortAddress || wallet.address}</strong>
              </div>
            )}

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
                    setPointsResult(null)
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
                <span>
                  Balance: {fromTokenBalance != null ? `${Number(fromTokenBalance).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${fromToken.symbol}` : '--'}
                  <button
                    type="button"
                    className="swap-max"
                    onClick={() => {
                      if (maxFromBalance == null) return
                      setAmountInput(String(Math.min(maxFromBalance, Number.MAX_SAFE_INTEGER)))
                    }}
                    disabled={paused || maxFromBalance == null}
                  >
                    MAX
                  </button>
                </span>
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
                <span>Balance: {toTokenBalance != null ? `${Number(toTokenBalance).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${toToken.symbol}` : '--'}</span>
              </div>
            </div>

            <button
              type="button"
              className="swap-cta"
              onClick={async () => {
                if (!wallet?.address) {
                  openWalletModal()
                  return
                }
                if (txState === 'ready_to_sign' || txState === 'signing' || txState === 'submitted' || txState === 'confirming') {
                  await executeSwap()
                  return
                }
                const prepared = await handleSwapAction()
                if (prepared) {
                  await executeSwap()
                }
              }}
              disabled={paused || swapInFlightRef.current || txState === 'preparing' || txState === 'signing' || txState === 'submitted' || txState === 'confirming'}
              aria-disabled={paused ? 'true' : undefined}
            >
              {txState === 'preparing' ? 'PREPARING SWAP...' : txState === 'signing' ? 'READY FOR WALLET APPROVAL...' : txState === 'submitted' ? 'SUBMITTED...' : txState === 'confirming' ? 'CONFIRMING...' : txState === 'success' ? 'SWAP COMPLETE' : txState === 'failed' ? 'TRY AGAIN' : txState === 'ready_to_sign' ? 'READY FOR WALLET APPROVAL' : !wallet?.address ? 'CONNECT WALLET TO SWAP' : 'SWAP'}
            </button>

            {(txState === 'success' || txState === 'failed') && (
              <div className={`swap-result-box ${txState === 'success' ? 'swap-result-success' : 'swap-result-error'}`} style={{ marginTop: '12px' }}>
                {txState === 'success' ? (
                  <>
                    <h4 style={{ margin: '0 0 8px', fontSize: '1.2rem' }}>⚔️ SWAP COMPLETE</h4>
                    <p style={{ margin: '4px 0' }}><strong>You Paid:</strong> {amountInput || '0'} {fromToken.symbol}</p>
                    <p style={{ margin: '4px 0' }}><strong>You Received:</strong> {receivedAmount != null ? `${receivedAmount.toFixed(6)} ${toToken.symbol}` : '—'}</p>
                    <p style={{ margin: '4px 0' }}><strong>Status:</strong> Confirmed</p>
                    <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,.14)' }}>
                      <p style={{ margin: '0 0 4px', color: pointsResult?.success && pointsResult?.qualified ? 'var(--gold)' : 'var(--red-dark)' }}><strong>{pointsResult?.success && pointsResult?.qualified ? `+${Number(pointsResult.pointsAwarded || 0).toLocaleString()} Samurai Points` : pointsResult?.success ? '0 Samurai Points' : persistenceStatus === 'saving' ? 'Calculating Samurai Points...' : 'Samurai Points unavailable'}</strong></p>
                      {pointsResult?.success && pointsResult?.qualified && <><p style={{ margin: '4px 0', color: 'var(--ink)' }}>Season Points: {Number(pointsResult.walletSeasonPoints || 0).toLocaleString()}</p><p style={{ margin: '4px 0', color: 'var(--ink)' }}>Qualifying Volume: ${Number(pointsResult.qualifyingVolumeUsd || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })}</p></>}
                      {pointsResult?.success && !pointsResult?.qualified && <p style={{ margin: '4px 0', color: 'var(--red-dark)' }}>Reason: {(pointsResult.reason || 'NOT_QUALIFIED').replaceAll('_', ' ')}</p>}
                      {pointsError && <p style={{ margin: '4px 0', color: 'var(--red-dark)' }}>{pointsError}</p>}
                    </div>
                    {txSignature && (
                      <>
                        <p style={{ margin: '8px 0 4px' }}><strong>Transaction:</strong> {shortSignature(txSignature, 5)}</p>
                        <button type="button" className="swap-token-result" onClick={() => navigator.clipboard?.writeText?.(txSignature)} style={{ marginTop: '6px' }}>
                          Copy Signature
                        </button>
                        <a href={solscanTxUrl(txSignature)} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: '8px', color: '#7de3ff' }}>
                          VIEW ON SOLSCAN
                        </a>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <h4 style={{ margin: '0 0 8px', fontSize: '1.2rem' }}>SWAP FAILED</h4>
                    <p style={{ margin: '0' }}>{txError}</p>
                  </>
                )}

                {verificationSummary && (
                  <p style={{ margin: '10px 0 0', color: verificationStatus === 'verified' ? '#81f39a' : verificationStatus === 'failed' ? '#ff8d8d' : '#dfe8ff' }}>
                    {verificationSummary}
                  </p>
                )}
              </div>
            )}

            {(quoteError || txError) && txState !== 'success' && txState !== 'failed' && <p className="swap-widget-foot" style={{ color: '#ba3c3c', marginTop: '8px' }}>{quoteError || txError}</p>}

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
              <div className="swap-quote-row"><span>Swap Fee (0.5%) <Icon name="info" size={12} /></span><strong>{quote?.platformFee ? formatTokenAmount(quote.platformFee.amount, quote.platformFee.decimals || 6, 6) : '--'}</strong></div>
            </div>

            <p className="swap-widget-foot"><Icon name="shield" size={12} /> {txState === 'ready_to_sign' ? 'Unsigned swap prepared — ready for wallet approval.' : txState === 'signing' ? 'READY FOR WALLET APPROVAL' : txState === 'submitted' ? 'Transaction submitted to Jupiter.' : txState === 'confirming' ? 'Waiting for on-chain confirmation.' : 'Secure. Non-Custodial. Powered by Jupiter Aggregator.'}</p>
            </>}
          </div>

          <aside className="swap-reference-side" aria-label="Ronin ecosystem highlights">
            <section className="swap-reference-card swap-reference-chains">
              <div className="swap-reference-card-title"><span className="swap-reference-icon">✦</span><strong>SUPPORTED CHAINS</strong><span className="swap-reference-new">NEW</span></div>
              <div className="swap-reference-chain-list"><span><TokenMark token={fromToken} size={22} /> Solana</span><span><span className="swap-reference-chain-gem">◆</span> Ethereum</span><span><span className="swap-reference-chain-gem">↗</span> Robinhood Chain</span></div>
              <p>One platform. Three chains. More opportunities.</p>
            </section>
            <section className="swap-reference-card swap-reference-points">
              <div className="swap-reference-card-title"><span className="swap-reference-icon">♜</span><strong>SAMURAI POINTS</strong></div>
              <div className="swap-reference-points-body"><div><small>Earn points per qualifying swap.</small><b>YOUR JOURNEY</b></div><ul><li>Earn Points Per Swap</li><li>Leaderboard &amp; Seasons</li><li>Future Airdrops</li><li>More Utilities Coming</li></ul></div>
              <button type="button" className="swap-reference-outline-button" onClick={handleSwapAction}>VIEW POINTS &amp; REWARDS</button>
            </section>
            <section className="swap-reference-card swap-reference-clan"><div className="swap-reference-card-title"><span className="swap-reference-icon">♨</span><strong>EVERY SWAP FUELS THE CLAN</strong></div><p>A portion of platform fees supports LP, buy &amp; burns, validator development and future utilities.</p><a href="#tokenomics" className="swap-reference-card-link">VIEW TOKENOMICS →</a></section>
            <section className="swap-reference-card swap-reference-live"><div className="swap-reference-card-title"><span className="swap-reference-icon">✦</span><strong>LIVE ECOSYSTEM STATS</strong><span className="swap-reference-live-dot">● Live</span></div><div className="swap-reference-live-grid">{ecosystemStats.slice(0, 4).map((stat) => <div key={stat.label}><small>{stat.label}</small><b>{stat.value}</b><em>{stat.note || 'Live data'}</em></div>)}</div></section>
          </aside>
        </div>
      </section>

      <UnifiedSwapHistory solanaWallet={wallet?.address} />

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
              <h3>POPULAR TOKENS ON {network === 'ethereum' ? 'ETHEREUM' : network === 'robinhood' ? 'ROBINHOOD CHAIN' : 'SOLANA'}</h3>
              <div className="swap-token-filters" role="tablist" aria-label="Token filter">
                {(network === 'ethereum' ? ['tokens', 'popular', 'memes', 'featured', 'trending'] : network === 'robinhood' ? ROBINHOOD_TOKEN_FILTERS : ['tokens', 'popular', 'memes', 'trending']).map((filter) => (
                  <button type="button" role="tab" aria-selected={tokenFilter === filter} className={tokenFilter === filter ? 'active' : ''} key={filter} onClick={() => setTokenFilter(filter)}>
                    {filter}
                  </button>
                ))}
              </div>
              {tokenFilter === 'trending' && <div className="swap-token-filters trending-timeframe-filters" role="tablist" aria-label="Trending timeframe">
                {['1h', '6h', '24h'].map((period) => <button type="button" role="tab" aria-selected={trendingTimeframe === period} className={trendingTimeframe === period ? 'active' : ''} key={period} onClick={() => setTrendingTimeframe(period)}>{period.toUpperCase()}</button>)}
              </div>}
            </div>
            <button type="button" className="swap-tokens-all" onClick={handleSwapAction} disabled={paused}>VIEW ALL TOKENS <Icon name="chevronRight" size={13} /></button>
          </div>
          <div className="swap-tokens-row">
            {tokenFilter === 'trending' && trendingState.state === 'loading' && <p className="swap-token-empty-state">Loading live trending data...</p>}
            {tokenFilter === 'trending' && trendingState.state === 'error' && <p className="swap-token-empty-state">Trending data temporarily unavailable. <button type="button" onClick={() => setTrendingRetry((value) => value + 1)}>Retry</button></p>}
            {tokenFilter === 'trending' && trendingState.state === 'empty' && <p className="swap-token-empty-state">No live trending tokens are available for this chain right now.</p>}
            {visibleTokens.map((token) => (
              <button type="button" className="swap-token" key={token.mint || token.address || token.symbol} onClick={() => network === 'solana' && selectToken('to', token)}>
                <TokenMark token={token} size={38} />
                <strong>{token.symbol}</strong>
                <small>{token.name}</small>
                {tokenFilter === 'trending' && <small>${Number(token.priceUsd || 0).toLocaleString('en-US', { maximumSignificantDigits: 6 })} · {Number(token.priceChange || 0).toFixed(2)}%</small>}
              </button>
            ))}
          </div>
          {tokenFilter === 'trending' && dashboardTrending.length > 0 && <div className="swap-tokens-note" style={{ marginTop: '12px', fontSize: '12px', opacity: 0.75 }}>Live DexScreener activity · {trendingTimeframe.toUpperCase()} · refreshes every 45 seconds.</div>}
          <div className="swap-quick-pairs">{RONIN_QUICK_PAIRS.map((pair) => <button type="button" key={pair.label} onClick={() => choosePair(pair)}>{pair.label}</button>)}</div>
        </div>
      </section>

      <section className="swap-reference-promos" aria-label="Ronin features">
        <article className="swap-reference-promo"><img src="/images/game-landscape.jpg" alt="Ronin PVP Arena" /><div><h3>⚔ RONIN PVP ARENA</h3><span>COMING SOON</span><p>Stake. Fight. Win. Burn.<br />Samurai vs Samurai.</p></div></article>
        <article className="swap-reference-promo"><img src="/images/nft-shogun.jpg" alt="Ronin NFTs" /><div><h3>▣ RONIN NFTs</h3><span>CUSTOMIZE YOUR SAMURAI</span><p>Equip NFTs. Show your style.<br />Gain exclusive perks.</p></div></article>
        <a href="#shield" className="swap-reference-promo"><img src="/images/rank-warrior.jpg" alt="Ronin Shield" /><div><h3>⬡ RONIN SHIELD</h3><span>FREE WALLET SCANNER</span><p>Scan and revoke risky approvals.<br />Keep your assets safe.</p></div></a>
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
