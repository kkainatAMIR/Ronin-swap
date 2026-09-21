import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { useWallet, getSolanaProvider } from '../context/WalletContext'
import { getSolBalance, getRoninBalance, getRoninSupply, sendSignedSolanaTransaction, confirmSolanaTransaction } from '../services/roninService'
import { getJupiterOrder, executeJupiterOrder, getJupiterReferralConfig, JupiterApiError, SOL_MINT, LAMPORTS_PER_SOL, JUPITER_REFERRAL_ACCOUNT, JUPITER_REFERRAL_FEE_BPS, solToLamports } from '../services/jupiterService'
import { RONIN_MINT, formatNumber } from '../data'
import Icon from './Icon'
import { Button, Sakura, ContractVerifyNote } from './Layout'
import ComingSoon from './ComingSoon'
import { BUY_ENABLED } from '../config/features'

// Minimum SOL kept aside so the wallet always has enough for network /
// transaction fees, even if the user tries to spend their whole balance.
const FEE_RESERVE_SOL = 0.01
const QUOTE_DEBOUNCE_MS = 500
const QUOTE_REFRESH_MS = 20_000
const CONFIRM_TIMEOUT_MS = 90_000

const STAGE = {
  FORM: 'form',
  REVIEW: 'review',
  RESULT: 'result',
}

const MODE = {
  BUY: 'buy',
  SELL: 'sell',
}

function formatAmount(amount) {
  if (amount == null || !Number.isFinite(amount)) return '—'
  if (amount >= 1000) return formatNumber(Math.round(amount))
  return amount.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

function shortAddress(address = '') {
  if (address.length <= 12) return address
  return `${address.slice(0, 4)}…${address.slice(-4)}`
}

function solscanTxUrl(signature) {
  return `https://solscan.io/tx/${signature}`
}

function referralStatus(order, configured = {}) {
  const configuredAccount = configured.referralAccount || JUPITER_REFERRAL_ACCOUNT
  const configuredFeeBps = Number(configured.referralFeeBps) || JUPITER_REFERRAL_FEE_BPS
  const feeBps = Number(order?.feeBps)
  const platformFeeBps = Number(order?.platformFee?.feeBps)
  const referralAccount = order?.referralAccount
  const feeMint = order?.feeMint
  const matchingAccount = referralAccount === configuredAccount
  const matchingFee = feeBps === configuredFeeBps
  return {
    feeBps,
    platformFeeBps,
    referralAccount,
    feeMint,
    configuredAccount,
    configuredFeeBps,
    active: matchingAccount && matchingFee,
    matchingAccount,
    matchingFee,
  }
}

function formatFeeMint(feeMint) {
  if (!feeMint) return '—'
  if (feeMint === SOL_MINT) return 'SOL'
  if (feeMint === RONIN_MINT) return 'RONIN'
  return shortAddress(feeMint)
}

function feeTokenLabel(feeMint, decimals) {
  if (feeMint === SOL_MINT) return 'SOL'
  if (feeMint === RONIN_MINT) return 'RONIN'
  return 'token'
}

function friendlyError(error) {
  if (!error) return 'Something went wrong. Please try again.'
  const message = error?.message || String(error)

  if (/user rejected|rejected the request|4001/i.test(message)) {
    return 'You rejected the request in Phantom.'
  }
  if (/insufficient/i.test(message) && /sol/i.test(message)) {
    return 'Insufficient SOL balance.'
  }
  if (error instanceof JupiterApiError) {
    return message
  }
  if (/failed to get quotes|could not reach the ronin swap service|unable to reach jupiter/i.test(message)) {
    return 'The RONIN swap service is unavailable. Please restart the local server and try again.'
  }
  if (/no route/i.test(message)) {
    return 'No route is currently available for SOL → RONIN. Please try again shortly.'
  }
  if (/blockhash not found|timeout|timed out/i.test(message)) {
    return 'The transaction took too long to confirm. Check Solscan before retrying — it may have still landed.'
  }
  if (/simulation failed|failed to simulate/i.test(message)) {
    return 'The transaction failed simulation. Please try again with a smaller amount or fresh quote.'
  }
  if (/failed to fetch|network/i.test(message)) {
    return 'Network error. Check your connection and try again.'
  }
  return message
}

export default function BuyRonin() {
  const { wallet, hasSolanaProvider, connectWallet, connectionState, error: walletError, openBuyModal, buyModalOpen, closeBuyModal } = useWallet()

  const [stage, setStage] = useState(STAGE.FORM)
  const [mode, setMode] = useState(MODE.BUY)
  const [amount, setAmount] = useState('')
  const [solBalance, setSolBalance] = useState(null)
  const [solBalanceState, setSolBalanceState] = useState('idle')
  const [roninBalance, setRoninBalance] = useState(null)
  const [roninBalanceState, setRoninBalanceState] = useState('idle')
  const [roninDecimals, setRoninDecimals] = useState(null)
  const [quote, setQuote] = useState(null)
  const [quoteState, setQuoteState] = useState('idle') // idle | loading | ready | error
  const [quoteError, setQuoteError] = useState('')
  const [quoteUpdatedAt, setQuoteUpdatedAt] = useState(null)
  const [txState, setTxState] = useState('idle') // idle | confirm-wallet | processing | success | error
  const [txError, setTxError] = useState('')
  const [txSignature, setTxSignature] = useState('')
  const [receivedAmount, setReceivedAmount] = useState(null)
  const [verification, setVerification] = useState(null)
  const [referralConfig, setReferralConfig] = useState({ referralAccount: JUPITER_REFERRAL_ACCOUNT, referralFeeBps: JUPITER_REFERRAL_FEE_BPS })

  const quoteRequestId = useRef(0)
  const debounceTimer = useRef(null)
  const refreshTimer = useRef(null)

  const isConnected = Boolean(wallet && !wallet.isDemo)
  const numericAmount = Number(amount)
  const hasValidAmount = amount !== '' && Number.isFinite(numericAmount) && numericAmount > 0

  const isSell = mode === MODE.SELL
  const maxSpendable = isSell
    ? (roninBalance != null ? Math.max(0, roninBalance) : null)
    : (solBalance != null ? Math.max(0, solBalance - FEE_RESERVE_SOL) : null)
  const availableBalance = isSell ? roninBalance : solBalance
  const exceedsBalance = hasValidAmount && availableBalance != null && numericAmount > maxSpendable

  const resetSwapOutcome = () => {
    setTxState('idle')
    setTxError('')
    setTxSignature('')
    setReceivedAmount(null)
    setVerification(null)
  }

  // Reset everything whenever the panel opens/closes so a fresh visit never
  // shows stale amounts or a leftover success/error state.
  useEffect(() => {
    if (!buyModalOpen) return
    setStage(STAGE.FORM)
    setMode(MODE.BUY)
    setAmount('')
    setQuote(null)
    setQuoteState('idle')
    setQuoteError('')
    setVerification(null)
    resetSwapOutcome()
  }, [buyModalOpen])

  // Mirror the server-side referral config (so the UI cannot drift from the
  // backend env that actually gets sent to Jupiter).
  useEffect(() => {
    if (!BUY_ENABLED || !buyModalOpen) return undefined
    let cancelled = false
    getJupiterReferralConfig().then((config) => {
      if (!cancelled) setReferralConfig(config)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [buyModalOpen])

  const loadSolBalance = useCallback(async () => {
    if (!wallet?.address) return
    setSolBalanceState('loading')
    try {
      const result = await getSolBalance(wallet.address)
      setSolBalance(result.sol)
      setSolBalanceState('ready')
    } catch (error) {
      console.warn('SOL balance read failed', error)
      setSolBalanceState('error')
    }
  }, [wallet?.address])

  const loadRoninBalance = useCallback(async () => {
    if (!wallet?.address) return
    setRoninBalanceState('loading')
    try {
      const result = await getRoninBalance(wallet.address)
      setRoninBalance(result.amount)
      setRoninBalanceState('ready')
      if (result.decimals) setRoninDecimals(result.decimals)
    } catch (error) {
      console.warn('RONIN balance read failed', error)
      setRoninBalanceState('error')
    }
  }, [wallet?.address])

  // Load the balance relevant to the selected direction (SOL for buy,
  // RONIN for sell) so the MAX button can never submit more than is owned.
  useEffect(() => {
    if (!BUY_ENABLED || !buyModalOpen || !isConnected) return undefined
    const loadCurrent = mode === MODE.SELL ? loadRoninBalance : loadSolBalance
    loadCurrent()
    const interval = window.setInterval(loadCurrent, 20_000)
    return () => window.clearInterval(interval)
  }, [buyModalOpen, isConnected, mode, loadSolBalance, loadRoninBalance])

  // If the wallet disconnects mid-flow (e.g. from Phantom itself), fall back
  // to the form stage instead of leaving a stale review/result screen up.
  useEffect(() => {
    if (buyModalOpen && !wallet && stage !== STAGE.FORM) {
      setStage(STAGE.FORM)
    }
  }, [wallet, buyModalOpen, stage])

  // RONIN's decimal count is needed to convert Jupiter's raw outAmount into a
  // human-readable figure. Jupiter's quote response does not include token
  // decimals, so it's read once from the mint itself via Solana RPC.
  useEffect(() => {
    if (!BUY_ENABLED || !buyModalOpen || roninDecimals != null) return
    getRoninSupply()
      .then((supply) => setRoninDecimals(supply.decimals))
      .catch(() => setRoninDecimals(6))
  }, [buyModalOpen, roninDecimals])

  const fetchQuote = useCallback(async (inputAmount) => {
    // Paused: never hit the Jupiter quote endpoint while BUY is disabled.
    if (!BUY_ENABLED) return
    if (!inputAmount || inputAmount <= 0) {
      setQuote(null)
      setQuoteState('idle')
      setQuoteError('')
      return
    }

    const requestId = ++quoteRequestId.current
    setQuoteState('loading')
    setQuoteError('')

    const inputMint = isSell ? RONIN_MINT : SOL_MINT
    const outputMint = isSell ? SOL_MINT : RONIN_MINT
    const inputDecimals = isSell ? (roninDecimals ?? 6) : 9
    // Quotes are requested without taker so the price can be shown before a
    // wallet is connected. The referral params are still attached by the backend.
    const amountLamports = isSell
      ? Math.round(inputAmount * (10 ** inputDecimals))
      : solToLamports(inputAmount)

    try {
      const result = await getJupiterOrder({
        inputMint,
        outputMint,
        amountLamports,
      })
      if (requestId !== quoteRequestId.current) return
      setQuote(result)
      setVerification(referralStatus(result, referralConfig))
      setQuoteState('ready')
      setQuoteUpdatedAt(Date.now())
    } catch (error) {
      if (requestId !== quoteRequestId.current) return
      console.warn('Jupiter order quote failed', error)
      setQuote(null)
      setVerification(null)
      setQuoteState('error')
      setQuoteError(friendlyError(error))
    }
  }, [isSell, roninDecimals, referralConfig])

  // Debounce quote requests as the user types.
  useEffect(() => {
    if (debounceTimer.current) window.clearTimeout(debounceTimer.current)
    if (!hasValidAmount || exceedsBalance) {
      setQuote(null)
      setQuoteState('idle')
      return undefined
    }
    debounceTimer.current = window.setTimeout(() => {
      fetchQuote(numericAmount)
    }, QUOTE_DEBOUNCE_MS)
    return () => window.clearTimeout(debounceTimer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, mode, roninDecimals, referralConfig])

  // Keep the quote fresh while the panel is open on the form stage.
  useEffect(() => {
    if (refreshTimer.current) window.clearInterval(refreshTimer.current)
    if (stage !== STAGE.FORM || !hasValidAmount || exceedsBalance) return undefined
    refreshTimer.current = window.setInterval(() => {
      fetchQuote(numericAmount)
    }, QUOTE_REFRESH_MS)
    return () => window.clearInterval(refreshTimer.current)
  }, [stage, hasValidAmount, exceedsBalance, numericAmount, fetchQuote])

  const outputDecimals = isSell ? 9 : (roninDecimals ?? 6)

  const outAmountUi = useMemo(() => {
    if (!quote) return null
    return Number(quote.outAmount) / 10 ** outputDecimals
  }, [quote, outputDecimals])

  const minReceivedUi = useMemo(() => {
    if (!quote) return null
    return Number(quote.otherAmountThreshold) / 10 ** outputDecimals
  }, [quote, outputDecimals])

  const priceImpactPct = quote ? Number(quote.priceImpactPct) * 100 : null
  const rate = quote && numericAmount > 0 && outAmountUi != null ? outAmountUi / numericAmount : null

  const handleAmountChange = (event) => {
    const raw = event.target.value.replace(/[^0-9.]/g, '')
    // Prevent multiple decimal points.
    const parts = raw.split('.')
    const cleaned = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : raw
    setAmount(cleaned)
  }

  const handleMax = () => {
    if (maxSpendable == null) return
    const step = 10 ** (isSell ? (roninDecimals ?? 6) : 6)
    setAmount(maxSpendable > 0 ? String(Math.floor(maxSpendable * step) / step) : '0')
  }

  const handleModeChange = (nextMode) => {
    if (nextMode === mode) return
    setMode(nextMode)
    setAmount('')
    setQuote(null)
    setQuoteState('idle')
    setQuoteError('')
    setVerification(null)
    resetSwapOutcome()
  }

  const handleManualRefresh = () => {
    if (hasValidAmount && !exceedsBalance) fetchQuote(numericAmount)
  }

  const goToReview = () => {
    if (!BUY_ENABLED) return
    if (!quote || quoteState !== 'ready') return
    setStage(STAGE.REVIEW)
  }

  const backToForm = () => {
    setStage(STAGE.FORM)
    resetSwapOutcome()
  }

  const executeSwap = async () => {
    // Hard gate: the Jupiter execution path is paused. This is intentionally
    // the first statement so no transaction can ever be built or signed while
    // the COMING SOON state is live, regardless of how it was triggered.
    if (!BUY_ENABLED) return
    const provider = getSolanaProvider()
    if (!provider) {
      setTxState('error')
      setTxError('Phantom wallet was not found. Please install Phantom to continue.')
      return
    }
    if (!quote) return
    try {
      const publicKey = new PublicKey(wallet.address)
      if (!PublicKey.isOnCurve(publicKey.toBytes())) {
        throw new Error('The connected wallet address is invalid. Disconnect and reconnect Phantom before selling RONIN.')
      }
    } catch (error) {
      setTxState('error')
      setTxError(error?.message || 'The connected wallet address is invalid. Disconnect and reconnect Phantom.')
      return
    }

    setStage(STAGE.RESULT)
    setTxError('')
    setTxSignature('')
    setReceivedAmount(null)

    const inputMint = isSell ? RONIN_MINT : SOL_MINT
    const outputMint = isSell ? SOL_MINT : RONIN_MINT
    const inputDecimals = isSell ? (roninDecimals ?? 6) : 9

    try {
      // 1. Re-fetch a fresh evaluated order with the connected taker so we get
      // the assembled transaction with the RoninSamurai.com referral applied.
      setTxState('processing')
      const freshQuote = await getJupiterOrder({
        inputMint,
        outputMint,
        amountLamports: isSell ? Math.round(numericAmount * (10 ** inputDecimals)) : solToLamports(numericAmount),
        taker: wallet.address,
      })
      if (!freshQuote.transaction) {
        // Jupiter returns empty `transaction: ""` with `error: "Insufficient
        // funds"` when the wallet doesn't have enough SOL to cover the swap
        // amount + fees. Surface a clear actionable message.
        const isInsufficient = freshQuote?.error === 'Insufficient funds'
          || freshQuote?.errorCode === 1
          || /insufficient funds/i.test(freshQuote?.errorMessage || '')
        throw new JupiterApiError(
          isInsufficient
            ? 'Insufficient SOL balance for this swap. Add SOL to your wallet and try again.'
            : (freshQuote?.errorMessage || 'Jupiter could not build a transaction for this swap.'),
          { detail: freshQuote }
        )
      }

      // 2. Deserialize the assembled transaction.
      const transactionBuffer = Uint8Array.from(atob(freshQuote.transaction), (c) => c.charCodeAt(0))
      const transaction = VersionedTransaction.deserialize(transactionBuffer)

      setTxState('confirm-wallet')

      // 3. Ask Phantom to sign (not send). The signed transaction is handed to
      // Jupiter /execute for managed landing, which is required for the V2
      // fee-applied flow and for RFQ/MarketMaker signatures.
      let signature
      if (typeof provider.signTransaction === 'function') {
        const signed = await provider.signTransaction(transaction)
        const signedBase64 = Buffer.from(signed.serialize()).toString('base64')

        setTxState('processing')

        const executeResult = await executeJupiterOrder({
          signedTransaction: signedBase64,
          requestId: freshQuote.requestId,
          lastValidBlockHeight: freshQuote.lastValidBlockHeight,
        })
        signature = executeResult.signature
        if (!signature || executeResult.status === 'Failed' || (executeResult.code != null && Number(executeResult.code) !== 0)) {
          throw new Error(executeResult?.error || executeResult?.message || 'Jupiter /execute returned a failure status.')
        }

        // Fee verification: /execute returns exact input/output accounting.
        // If feeMint == inputMint, fee = totalInputAmount - inputAmountResult;
        // if feeMint == outputMint, fee = outputAmountResult - totalOutputAmount.
        const feeMint = freshQuote.feeMint
        let feeCollected = '0'
        if (feeMint === inputMint) {
          feeCollected = String(BigInt(executeResult.totalInputAmount || '0') - BigInt(executeResult.inputAmountResult || '0'))
        } else if (feeMint === outputMint) {
          feeCollected = String(BigInt(executeResult.outputAmountResult || '0') - BigInt(executeResult.totalOutputAmount || '0'))
        }
        const feeDecimals = feeMint === SOL_MINT ? 9 : (roninDecimals ?? 6)
        const feeUi = Number(feeCollected || '0') / 10 ** feeDecimals

        setVerification({
          ...referralStatus(freshQuote, referralConfig),
          feeCollected: feeCollected,
          feeCollectedUi: feeUi,
          feeMintLabel: feeTokenLabel(feeMint, feeDecimals),
          outputDecimals: isSell ? 9 : (roninDecimals ?? 6),
          executeStatus: executeResult.status,
        })

        const outputAmountUi = Number(executeResult.totalOutputAmount || '0') / (isSell ? LAMPORTS_PER_SOL : 10 ** (roninDecimals ?? 6))
        setReceivedAmount(Number.isFinite(outputAmountUi) ? outputAmountUi : null)
      } else if (typeof provider.signAndSendTransaction === 'function') {
        // Legacy wallet fallback if signTransaction is not exposed. This does
        // not use /execute, so fee accounting comes from the order response.
        const result = await provider.signAndSendTransaction(transaction)
        signature = result?.signature || result

        const confirmation = await Promise.race([
          confirmSolanaTransaction(signature, CONFIRM_TIMEOUT_MS),
          new Promise((_, reject) => window.setTimeout(() => reject(new Error('Transaction confirmation timed out. It may still land — check Solscan.')), CONFIRM_TIMEOUT_MS)),
        ])
        if (confirmation?.value?.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`)

        const outputAmountUi = Number(freshQuote.outAmount) / (isSell ? LAMPORTS_PER_SOL : 10 ** (roninDecimals ?? 6))
        setReceivedAmount(Number.isFinite(outputAmountUi) ? outputAmountUi : null)
        setVerification(referralStatus(freshQuote, referralConfig))
      } else {
        throw new Error('The connected wallet does not expose signTransaction or signAndSendTransaction.')
      }

      setTxState('success')
      setTxSignature(signature)
      loadSolBalance()
      loadRoninBalance()
    } catch (error) {
      console.error(`${isSell ? 'Sell' : 'Buy'} RONIN swap failed`, error)
      setTxState('error')
      setTxError(friendlyError(error))
    }
  }

  const buyButtonLabel = () => {
    if (!isConnected) return 'CONNECT WALLET'
    if (quoteState === 'loading') return 'GETTING QUOTE...'
    return isSell ? 'SELL RONIN' : 'BUY RONIN'
  }

  const buyButtonDisabled = () => {
    if (!isConnected) return connectionState === 'connecting'
    if (!hasValidAmount || exceedsBalance) return true
    if (quoteState !== 'ready') return true
    return false
  }

  const handlePrimaryAction = () => {
    if (!BUY_ENABLED) return
    if (!isConnected) {
      connectWallet()
      return
    }
    goToReview()
  }

  if (!buyModalOpen) return null

  // BUY/SELL paused — the panel stays visible (same shell, same design) but
  // only shows the COMING SOON state. No quote, no review, no signing.
  if (!BUY_ENABLED) {
    return (
      <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeBuyModal() }}>
        <div className="modal buy-modal" role="dialog" aria-modal="true" aria-labelledby="buy-ronin-title">
          <Sakura count={6} className="card-petals" />
          <button className="modal-close" onClick={closeBuyModal} aria-label="Close buy dialog"><Icon name="close" size={16} /></button>
          <div className="modal-kicker"><span className="status-dot" /> RONIN</div>
          <h2 id="buy-ronin-title" className="buy-title">BUY RONIN</h2>
          <div className="buy-panel">
            <ComingSoon compact />
            <ContractVerifyNote compact className="buy-verify-contract" />
            <Button className="full-button buy-primary-btn" icon="arrowRight" variant="outline" onClick={closeBuyModal}>CLOSE</Button>
            <p className="buy-fee-note">Swapping will re-open here once the RONIN swap goes live.</p>
          </div>
        </div>
      </div>
    )
  }

  const outputUnit = isSell ? 'SOL' : 'RONIN'
  const inputUnit = isSell ? 'RONIN' : 'SOL'

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeBuyModal() }}>
      <div className="modal buy-modal" role="dialog" aria-modal="true" aria-labelledby="buy-ronin-title">
        <Sakura count={6} className="card-petals" />
        <button className="modal-close" onClick={closeBuyModal} aria-label="Close buy dialog"><Icon name="close" size={16} /></button>
        <div className="modal-kicker"><span className="status-dot" /> RONIN</div>
        <h2 id="buy-ronin-title" className="buy-title">{isSell ? 'SELL RONIN' : 'BUY RONIN'}</h2>

        {stage === STAGE.FORM && (
          <div className="buy-panel">
            <div className="buy-mode-toggle" role="tablist" aria-label="Swap direction">
              <button type="button" role="tab" aria-selected={mode === MODE.BUY} className={mode === MODE.BUY ? 'active' : ''} onClick={() => handleModeChange(MODE.BUY)}>BUY $RONIN</button>
              <button type="button" role="tab" aria-selected={mode === MODE.SELL} className={mode === MODE.SELL ? 'active' : ''} onClick={() => handleModeChange(MODE.SELL)}>SELL $RONIN</button>
            </div>

            <div className="buy-field-block">
              <div className="field-label">
                <span>You Pay</span>
                {isConnected && (
                  <span>
                    Balance: {isSell
                      ? roninBalanceState === 'ready' && roninBalance != null ? `${roninBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} RONIN` : roninBalanceState === 'loading' ? 'Loading…' : '—'
                      : solBalanceState === 'ready' && solBalance != null ? `${solBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL` : solBalanceState === 'loading' ? 'Loading…' : '—'}
                  </span>
                )}
              </div>
              <div className={`amount-field buy-amount-field ${exceedsBalance ? 'amount-field-error' : ''}`}>
                <input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={handleAmountChange}
                  aria-label={isSell ? 'RONIN amount to spend' : 'SOL amount to spend'}
                />
                <span>{inputUnit}</span>
                {isConnected && <button type="button" className="buy-max-btn" onClick={handleMax}>MAX</button>}
              </div>
              {exceedsBalance && <div className="inline-message"><Icon name="info" size={14} />Insufficient {inputUnit} balance</div>}
            </div>

            <div className="buy-swap-arrow"><Icon name="arrowDown" size={16} /></div>

            <div className="buy-field-block">
              <div className="field-label"><span>You Receive</span>{quoteState === 'ready' && <button type="button" className="buy-refresh-btn" onClick={handleManualRefresh}><Icon name="refresh" size={12} /> Refresh</button>}</div>
              <div className="amount-field buy-amount-field buy-amount-field-readonly">
                <input readOnly value={quoteState === 'ready' && outAmountUi != null ? formatAmount(outAmountUi) : quoteState === 'loading' ? '…' : '0.00'} aria-label={`Estimated ${outputUnit} received`} />
                <span>{outputUnit}</span>
              </div>
            </div>

            {quoteState === 'error' && (
              <div className="inline-message"><Icon name="info" size={14} />{quoteError}</div>
            )}

            {quoteState === 'ready' && quote && (
              <div className="buy-quote-details">
                <div><span>Rate</span><strong>1 {inputUnit} ≈ {rate != null ? formatAmount(rate) : '—'} {outputUnit}</strong></div>
                <div><span>Price Impact</span><strong className={priceImpactPct != null && priceImpactPct > 3 ? 'red-text' : ''}>{priceImpactPct != null ? `${priceImpactPct.toFixed(2)}%` : '—'}</strong></div>
                <div><span>Minimum Received</span><strong>{minReceivedUi != null ? formatAmount(minReceivedUi) : '—'} {outputUnit}</strong></div>
                <div className="buy-verify-row"><span>Jupiter referral</span><strong className={verification?.active ? 'green-text' : 'red-text'}>{verification?.active ? 'APPLIED' : 'NOT VERIFIED'}</strong></div>
                {quoteUpdatedAt && <div className="buy-quote-updated"><span>Quote updated {new Date(quoteUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>}
              </div>
            )}

            <Button className="full-button buy-primary-btn" icon={isConnected ? 'arrowUpRight' : 'wallet'} onClick={handlePrimaryAction} disabled={buyButtonDisabled()}>
              {buyButtonLabel()}
            </Button>
            <ContractVerifyNote compact className="buy-verify-contract" />
            <p className="buy-fee-note">
              0.5% protocol fee applies. This fee supports the RONIN protocol and ecosystem development.
            </p>
            {!hasSolanaProvider && !isConnected && <p className="wallet-hint">No Phantom wallet detected. Install Phantom to {isSell ? 'sell' : 'buy'} $RONIN.</p>}
            {!isConnected && walletError && <div className="inline-message"><Icon name="info" size={14} />{walletError}</div>}
          </div>
        )}

        {stage === STAGE.REVIEW && quote && (
          <div className="buy-panel">
            <h3 className="buy-review-title">{isSell ? 'Review Sell' : 'Review Buy'}</h3>
            <div className="buy-review-rows">
              <div><span>You pay</span><strong>{formatAmount(numericAmount)} {inputUnit}</strong></div>
              <div><span>You receive approximately</span><strong>{formatAmount(outAmountUi)} {outputUnit}</strong></div>
              <div><span>Minimum received</span><strong>{formatAmount(minReceivedUi)} {outputUnit}</strong></div>
              <div><span>Price impact</span><strong>{priceImpactPct != null ? `${priceImpactPct.toFixed(2)}%` : '—'}</strong></div>
              <div><span>Network</span><strong>Solana Mainnet</strong></div>
            </div>
            {(verification || quote) && (
              <div className={`buy-verify-box ${verification?.active ? '' : 'buy-verify-box-error'}`}>
                <div className="buy-verify-header"><strong>{verification?.active ? 'REFERRAL FEE APPLIED' : 'REFERRAL FEE NOT VERIFIED'}</strong><span className="status-dot" /></div>
                <div><span>Referral account</span><strong>{shortAddress(verification?.referralAccount || referralConfig.referralAccount)}</strong></div>
                <div><span>Configured</span><strong>{referralConfig.referralFeeBps} bps (0.5%)</strong></div>
                <div><span>/order feeBps</span><strong>{verification?.feeBps ?? '—'}</strong></div>
                <div><span>platformFee.feeBps</span><strong>{verification?.platformFeeBps ?? '—'}</strong></div>
                <div><span>feeMint</span><strong>{formatFeeMint(verification?.feeMint)}</strong></div>
                {!verification?.active && <p>Jupiter did not confirm the 50 bps referral fee on this order. Do not execute until the referral setup is corrected.</p>}
              </div>
            )}
            <ContractVerifyNote compact className="buy-verify-contract" />
            <p className="buy-fee-note">
              0.5% protocol fee applies. This fee supports the RONIN protocol and ecosystem development.
            </p>
            <div className="buy-review-actions">
              <Button variant="outline" icon="arrowRight" onClick={backToForm}>Back</Button>
              <Button className="buy-primary-btn" icon="arrowUpRight" onClick={executeSwap}>CONFIRM {isSell ? 'SELL' : 'BUY'}</Button>
            </div>
          </div>
        )}

        {stage === STAGE.RESULT && (
          <div className="buy-panel buy-result-panel">
            {txState === 'confirm-wallet' && (
              <div className="buy-status-block">
                <div className="buy-spinner" aria-hidden="true" />
                <strong>CONFIRM IN PHANTOM</strong>
                <p>Approve the swap in your Phantom wallet to continue.</p>
              </div>
            )}
            {txState === 'processing' && (
              <div className="buy-status-block">
                <div className="buy-spinner" aria-hidden="true" />
                <strong>PROCESSING...</strong>
                <p>Submitting your swap to Solana mainnet.</p>
              </div>
            )}
            {txState === 'success' && (
              <div className="buy-status-block buy-status-success">
                <Icon name="check" size={28} />
                <strong>✓ $RONIN {isSell ? 'SOLD' : 'PURCHASED'}</strong>
                <p>You received:</p>
                <p className="buy-result-amount">{formatAmount(receivedAmount)} {outputUnit}</p>
                {verification && (
                  <div className={`buy-verify-box ${verification.active ? '' : 'buy-verify-box-error'}`}>
                    <div className="buy-verify-header"><strong>{verification.active ? 'REFERRAL FEE COLLECTED' : 'REFERRAL FEE NOT COLLECTED'}</strong><span className="status-dot" /></div>
                    <div><span>Referral account</span><strong>{shortAddress(verification.referralAccount || referralConfig.referralAccount)}</strong></div>
                    <div><span>Configured</span><strong>{referralConfig.referralFeeBps} bps (0.5%)</strong></div>
                    <div><span>/order feeBps</span><strong>{verification.feeBps ?? '—'}</strong></div>
                    <div><span>platformFee.feeBps</span><strong>{verification.platformFeeBps ?? '—'}</strong></div>
                    <div><span>feeMint</span><strong>{formatFeeMint(verification.feeMint)}</strong></div>
                    <div><span>Fee collected</span><strong>{Number(verification.feeCollectedUi || 0) > 0 ? `${Number(verification.feeCollectedUi).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${verification.feeMintLabel || formatFeeMint(verification.feeMint)}` : '0'}</strong></div>
                  </div>
                )}
                <p className="buy-result-sig">Transaction: {txSignature.slice(0, 8)}…{txSignature.slice(-8)}</p>
                <div className="buy-review-actions">
                  <a className="btn btn-outline" href={solscanTxUrl(txSignature)} target="_blank" rel="noreferrer">VIEW ON SOLSCAN <Icon name="external" size={14} /></a>
                  <Button icon="close" onClick={closeBuyModal}>Done</Button>
                </div>
              </div>
            )}
            {txState === 'error' && (
              <div className="buy-status-block buy-status-error">
                <Icon name="info" size={28} />
                <strong>Transaction failed.</strong>
                <p>{txError}</p>
                <div className="buy-review-actions">
                  <Button variant="outline" icon="arrowRight" onClick={backToForm}>TRY AGAIN</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function BuyRoninButton({ className = '', children = 'BUY RONIN', icon = 'arrowUpRight' }) {
  const { openBuyModal } = useWallet()
  const paused = !BUY_ENABLED

  // When paused, the button stays visible but can only open the COMING SOON
  // panel. When live (the current state) it behaves exactly as it always has.
  if (paused) {
    const handlePausedActivate = (event) => {
      if (event) {
        event.preventDefault()
        event.stopPropagation()
      }
      openBuyModal()
    }
    return (
      <button
        type="button"
        className={`${className} is-paused buy-btn-paused`}
        onClick={handlePausedActivate}
        aria-disabled="true"
        data-paused="true"
        title="Coming soon — buying is temporarily paused"
      >
        {children}{icon && <Icon name={icon} size={14} />}
        <span className="buy-btn-paused-tag">SOON</span>
      </button>
    )
  }

  return (
    <button type="button" className={className} onClick={openBuyModal}>
      {children}{icon && <Icon name={icon} size={14} />}
    </button>
  )
}
