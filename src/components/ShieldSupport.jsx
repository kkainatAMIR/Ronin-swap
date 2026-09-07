import { useState, useEffect } from 'react'
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { getSolanaConnection } from '../services/solanaConnection'
import { getSolanaProvider } from '../context/WalletContext'
import { SHIELD_TREASURY_ADDRESS, SHIELD_SUPPORT_PRESETS, SHIELD_MIN_CUSTOM_SOL, SHIELD_MAX_CUSTOM_SOL } from '../config/shield'
import { trackShieldContribution } from '../services/shieldStatsService'
import Icon from './Icon'
import { Button, Eyebrow, Tag } from './Layout'

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || '—'
  return `${addr.slice(0, 6)}...${addr.slice(-6)}`
}

// Success is only shown after the transfer is confirmed on-chain. If the
// blockheight poller expires right as the transaction lands, we double-check
// the actual signature status before treating it as a failure.
async function rpcViaProxy(method, params) {
  const res = await fetch('/api/solana/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  if (!res.ok) throw new Error(`RPC proxy ${res.status}`)
  const payload = await res.json()
  if (payload?.error) throw new Error(payload.error?.message || 'RPC error')
  return payload?.result
}

// Get a recent blockhash through the same-origin server proxy first
// (server-side RPC key, no browser CORS/403 issues), then fall back to the
// direct browser connection.
async function getLatestBlockhashSmart() {
  try {
    const result = await rpcViaProxy('getLatestBlockhash', [{ commitment: 'confirmed' }])
    const value = result?.value || result
    if (value?.blockhash && value?.lastValidBlockHeight) {
      return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight }
    }
  } catch (e) {
    console.warn('Shield support: proxy getLatestBlockhash failed, falling back to direct RPC', e?.message)
  }
  const connection = getSolanaConnection()
  return await connection.getLatestBlockhash('confirmed')
}

async function confirmContribution(connection, signature, { blockhash, lastValidBlockHeight }) {
  // Poll signature status through the server proxy first (avoids browser 403),
  // then fall back to the local Connection library.
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const result = await rpcViaProxy('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])
      const status = result?.value?.[0]
      if (status) {
        if (status.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`)
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return
      }
    } catch (e) {
      break // proxy unreachable; fall back to direct connection below
    }
    await new Promise((r) => setTimeout(r, 1500))
  }

  try {
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  } catch (err) {
    try {
      const statuses = await connection.getSignatureStatuses([signature])
      const status = statuses?.value?.[0]
      const isConfirmed = status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
      if (isConfirmed) return
    } catch {
      // fall through to the original error
    }
    throw err
  }
}

export default function ShieldSupport({ wallet, treasuryAddress = SHIELD_TREASURY_ADDRESS, onContributionSuccess }) {
  const [selectedPreset, setSelectedPreset] = useState(SHIELD_SUPPORT_PRESETS[0])
  const [customMode, setCustomMode] = useState(false)
  const [customAmount, setCustomAmount] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [status, setStatus] = useState('idle') // idle, confirming, sending, success, error
  const [txSignature, setTxSignature] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const isConnected = !!wallet && !wallet.isDemo
  const provider = typeof window !== 'undefined' ? getSolanaProvider() : null

  const parsedCustom = parseFloat(customAmount)
  const effectiveAmount = customMode
    ? (Number.isFinite(parsedCustom) ? parsedCustom : 0)
    : selectedPreset

  const isValidAmount = Number.isFinite(effectiveAmount) && effectiveAmount >= SHIELD_MIN_CUSTOM_SOL && effectiveAmount <= SHIELD_MAX_CUSTOM_SOL

  const handlePresetClick = (amount) => {
    setSelectedPreset(amount)
    setCustomMode(false)
    setCustomAmount('')
    setShowConfirm(false)
    setStatus('idle')
    setErrorMsg('')
    setTxSignature('')
  }

  const handleCustomSelect = () => {
    setCustomMode(true)
    setShowConfirm(false)
    setStatus('idle')
    setErrorMsg('')
    setTxSignature('')
  }

  const handlePrepare = () => {
    if (!isValidAmount) {
      setErrorMsg(`Please enter a valid amount between ${SHIELD_MIN_CUSTOM_SOL} and ${SHIELD_MAX_CUSTOM_SOL} SOL.`)
      return
    }
    if (!isConnected) {
      setErrorMsg('Please connect a real wallet to contribute.')
      return
    }
    setErrorMsg('')
    setShowConfirm(true)
    setStatus('confirming')
  }

  const handleCancelConfirm = () => {
    setShowConfirm(false)
    setStatus('idle')
  }

  const handleSendContribution = async () => {
    if (!isValidAmount) return
    if (!isConnected || !wallet?.address) {
      setErrorMsg('Wallet not connected.')
      setStatus('error')
      return
    }
    const treasuryPubkeyStr = treasuryAddress || SHIELD_TREASURY_ADDRESS
    let treasuryPubkey
    try {
      treasuryPubkey = new PublicKey(treasuryPubkeyStr)
    } catch {
      setErrorMsg('Invalid treasury address configured.')
      setStatus('error')
      return
    }

    let fromPubkey
    try {
      fromPubkey = new PublicKey(wallet.address)
    } catch {
      setErrorMsg('Invalid wallet address.')
      setStatus('error')
      return
    }

    setStatus('sending')
    setErrorMsg('')
    setTxSignature('')

    try {
      const connection = getSolanaConnection()
      const lamports = Math.round(effectiveAmount * LAMPORTS_PER_SOL)

      // Build transfer
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey,
          toPubkey: treasuryPubkey,
          lamports,
        })
      )
      transaction.feePayer = fromPubkey
      // Blockhash comes from the same-origin server proxy first (uses the
      // server-side RPC/HELIUS_API_KEY), with a direct browser fallback.
      const { blockhash, lastValidBlockHeight } = await getLatestBlockhashSmart()
      transaction.recentBlockhash = blockhash

      let signature

      // Try provider signAndSend or signTransaction
      if (provider) {
        // Some wallets expose signAndSendTransaction
        if (typeof provider.signAndSendTransaction === 'function') {
          const result = await provider.signAndSendTransaction(transaction)
          signature = result?.signature || result
        } else if (typeof provider.signTransaction === 'function') {
          const signed = await provider.signTransaction(transaction)
          signature = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: false,
            maxRetries: 3,
          })
        } else if (typeof provider.sendTransaction === 'function') {
          // Fallback: some adapters
          signature = await provider.sendTransaction(transaction, connection)
        } else {
          throw new Error('Wallet does not support transaction signing.')
        }
      } else {
        throw new Error('No Solana wallet provider found.')
      }

      if (!signature || typeof signature !== 'string') {
        throw new Error('No signature returned from wallet.')
      }

      // Show success only after the transfer is confirmed on-chain.
      await confirmContribution(connection, signature, { blockhash, lastValidBlockHeight })

      setTxSignature(signature)
      setStatus('success')
      setShowConfirm(false)

      // Optional tracking for transparency (on-chain balance is source of truth)
      try {
        await trackShieldContribution({ solAmount: effectiveAmount, signature })
      } catch {}

      if (onContributionSuccess) {
        try { onContributionSuccess({ solAmount: effectiveAmount, signature }) } catch {}
      }
    } catch (err) {
      console.error('Shield contribution failed', err)
      const msg = err?.message || String(err)

      // User cancelled - must not restrict access
      const isCancelled =
        /user rejected|cancelled|canceled|rejected|denied|closed/i.test(msg) ||
        err?.code === 4001

      if (isCancelled) {
        setStatus('idle')
        setShowConfirm(false)
        setErrorMsg('Transaction cancelled. You can continue using RONIN Shield — contributions are optional.')
        return
      }

      setStatus('error')
      setErrorMsg(msg || 'Transaction failed. You can continue using RONIN Shield — contributions are optional and never restrict access.')
      setShowConfirm(false)
    }
  }

  return (
    <div className="surface-card enhanced-card shield-support-card">
      <div className="panel-heading">
        <div>
          <Eyebrow>Support RONIN Shield 🛡️</Eyebrow>
          <h3>Keep Shield free. Support optional.</h3>
        </div>
        <Tag tone="light">100% FREE • OPTIONAL</Tag>
      </div>

      <div className="shield-support-notice">
        <Icon name="info" size={14} />
        <span>
          <strong>RONIN Shield is a free service. Contributions are entirely optional and are used to support the development and operation of RONIN Shield.</strong>
        </span>
      </div>

      <div className="shield-support-amounts">
        <span className="data-label">Select amount</span>
        <div className="shield-preset-row">
          {SHIELD_SUPPORT_PRESETS.map((amt) => (
            <button
              key={amt}
              className={`preset ${!customMode && selectedPreset === amt ? 'active' : ''}`}
              onClick={() => handlePresetClick(amt)}
              type="button"
            >
              {amt} SOL
            </button>
          ))}
          <button
            className={`preset ${customMode ? 'active' : ''}`}
            onClick={handleCustomSelect}
            type="button"
          >
            CUSTOM
          </button>
        </div>

        {customMode && (
          <div className="shield-custom-field">
            <div className={`amount-field ${!isValidAmount && customAmount ? 'amount-field-error' : ''}`}>
              <input
                type="number"
                inputMode="decimal"
                min={SHIELD_MIN_CUSTOM_SOL}
                max={SHIELD_MAX_CUSTOM_SOL}
                step="0.001"
                placeholder="0.01"
                value={customAmount}
                onChange={(e) => {
                  setCustomAmount(e.target.value)
                  setErrorMsg('')
                  setStatus('idle')
                  setTxSignature('')
                }}
              />
              <span>SOL</span>
            </div>
            <small className="muted-caption">Min {SHIELD_MIN_CUSTOM_SOL} • Max {SHIELD_MAX_CUSTOM_SOL} SOL</small>
          </div>
        )}
      </div>

      {/* Pre-approval display */}
      <div className="shield-support-preview">
        <div className="shield-preview-row">
          <span>Destination treasury</span>
          <strong title={treasuryAddress} className="shield-mono">
            {treasuryAddress}
          </strong>
        </div>
        <div className="shield-preview-row">
          <span>Amount</span>
          <strong>{isValidAmount ? `${effectiveAmount} SOL` : '—'}</strong>
        </div>
        <div className="shield-preview-row small">
          <span>Type</span>
          <span>Standard native SOL transfer • Signed by your wallet • No seed phrase ever requested</span>
        </div>
      </div>

      {!showConfirm ? (
        <div className="shield-support-actions">
          <Button icon="coins" onClick={handlePrepare} disabled={!isValidAmount || !isConnected}>
            {isConnected ? `Support with ${isValidAmount ? effectiveAmount : '—'} SOL` : 'Connect wallet to support'}
          </Button>
          {!isConnected && <small className="muted-caption">Connect a real Phantom wallet to contribute. Demo wallets cannot send.</small>}
        </div>
      ) : (
        <div className="shield-confirm-box">
          <div className="shield-confirm-head">
            <Icon name="shield" size={16} />
            <strong>Confirm contribution before approval</strong>
          </div>
          <div className="shield-confirm-details">
            <div>
              <span>Destination treasury address</span>
              <code title={treasuryAddress}>{treasuryAddress}</code>
            </div>
            <div>
              <span>Exact SOL amount</span>
              <strong>{effectiveAmount} SOL ({Math.round(effectiveAmount * LAMPORTS_PER_SOL).toLocaleString()} lamports)</strong>
            </div>
            <div>
              <span>Network</span>
              <span>Solana Mainnet • Standard SystemProgram.transfer</span>
            </div>
          </div>
          <p className="shield-confirm-note">
            Your wallet will prompt you to approve. Verify the destination and amount in your wallet before signing. RONIN Shield will never ask for your seed phrase.
          </p>
          <div className="shield-confirm-actions">
            <Button icon="check" onClick={handleSendContribution} disabled={status === 'sending'}>
              {status === 'sending' ? 'Awaiting wallet approval...' : `Approve ${effectiveAmount} SOL in wallet`}
            </Button>
            <Button variant="outline" icon="close" onClick={handleCancelConfirm} disabled={status === 'sending'}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {status === 'sending' && (
        <div className="notice-box">
          <span className="scan-spinner" />
          <span>Waiting for wallet signature… Please approve the transfer in your wallet. Destination: {shortAddr(treasuryAddress)} • Amount: {effectiveAmount} SOL</span>
        </div>
      )}

      {status === 'success' && txSignature && (
        <div className="shield-success-box">
          <div className="shield-success-head">
            <Icon name="check" size={16} />
            <strong>Contribution confirmed on-chain — thank you! 🛡️</strong>
            <Tag tone="green">CONFIRMED</Tag>
          </div>
          <div className="shield-success-details">
            <div>
              <span>Transaction signature</span>
              <code title={txSignature}>{txSignature}</code>
            </div>
            <div>
              <span>Status</span>
              <span>Confirmed on Solana mainnet • {effectiveAmount} SOL to {shortAddr(treasuryAddress)}</span>
            </div>
            <div className="shield-success-links">
              <a href={`https://explorer.solana.com/tx/${txSignature}`} target="_blank" rel="noreferrer" className="explorer-button">
                <Icon name="external" size={12} /> View on Solana Explorer
              </a>
              <a href={`https://solscan.io/tx/${txSignature}`} target="_blank" rel="noreferrer" className="explorer-button">
                <Icon name="external" size={12} /> View on Solscan
              </a>
            </div>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className={`notice-box ${status === 'error' ? 'notice-box-error' : ''}`}>
          <Icon name={status === 'error' ? 'info' : 'check'} size={14} />
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="shield-support-foot">
        <small>
          Contributions are standard native SOL transfers to the treasury wallet and are signed by your connected wallet. RONIN Shield never requests, transmits, exposes, or stores private keys or seed phrases. Cancelled or failed transactions never restrict access to Shield.
        </small>
      </div>
    </div>
  )
}
