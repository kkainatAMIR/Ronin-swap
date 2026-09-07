import { useState, useEffect } from 'react'
import { getSolanaProvider, useWallet } from '../context/WalletContext'
import Icon from '../components/Icon'
import { Button, Eyebrow, PageHero, SectionHeading, Tag, ContractVerifyNote } from '../components/Layout'
import { scanWalletLive as scanWallet } from '../services/shieldLiveService'
import { getShieldStats, supportShield } from '../services/shieldSupportService'

// Score labels can contain spaces ("NO KNOWN ISSUES"); map them to the
// dashed class names used by the score pill styles.
const scoreLabelClass = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const SCAN_STEPS = [
  { id: 'walletAge', label: 'Checking wallet activity' },
  { id: 'solBalance', label: 'Checking SOL balance' },
  { id: 'tokenAccounts', label: 'Checking token accounts' },
  { id: 'transactions', label: 'Checking recent transactions' },
  { id: 'suspicious', label: 'Checking suspicious interactions' },
  { id: 'report', label: 'Building security report' },
]

function formatSol(sol) {
  if (sol == null || isNaN(sol)) return '—'
  return `${sol.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`
}

function formatDate(date) {
  if (!date) return '—'
  try {
    return new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  } catch { return '—' }
}

function formatDateTime(ts) {
  if (!ts) return '—'
  try { return new Date(ts).toLocaleString() } catch { return '—' }
}

function shortSig(sig) {
  if (!sig) return '—'
  if (sig.length <= 16) return sig
  return `${sig.slice(0, 6)}...${sig.slice(-6)}`
}

const SUPPORT_PRESETS = ['0.01', '0.05', '0.1']
const EXPLORER_TX_URL = (signature) => `https://explorer.solana.com/tx/${signature}?cluster=mainnet`

export default function Shield() {
  const { wallet, openWalletModal, disconnect, hasSolanaProvider } = useWallet()
  const [scanState, setScanState] = useState('idle')
  const [scanProgress, setScanProgress] = useState({})
  const [scanResult, setScanResult] = useState(null)
  const [scanError, setScanError] = useState('')
  const [isDemoWarning, setIsDemoWarning] = useState(false)
  const [shieldStats, setShieldStats] = useState(null)
  const [supportAmount, setSupportAmount] = useState('')
  const [supportState, setSupportState] = useState('idle')
  const [supportError, setSupportError] = useState('')
  const [supportSignature, setSupportSignature] = useState('')

  const isConnected = !!wallet
  const isRealWallet = wallet && !wallet.isDemo
  const walletAddress = wallet?.address || ''

  useEffect(() => setIsDemoWarning(!!wallet?.isDemo), [wallet])
  useEffect(() => {
    getShieldStats().then(setShieldStats).catch((error) => console.warn('Shield public stats unavailable', error))
  }, [])
  useEffect(() => {
    if (!wallet) {
      setScanState('idle'); setScanResult(null); setScanProgress({}); setScanError('')
    }
  }, [wallet])

  const updateProgress = (stepId, status) => setScanProgress((prev) => ({ ...prev, [stepId]: status }))

  const handleScan = async () => {
    if (!walletAddress) return setScanError('No wallet connected')
    if (wallet?.isDemo) return setScanError('RONIN SHIELD requires a real Phantom wallet. Demo profile cannot be scanned on-chain. Please connect a real wallet.')
    setScanState('scanning'); setScanError(''); setScanResult(null)
    const initialProgress = {}; SCAN_STEPS.forEach((s) => (initialProgress[s.id] = 'pending')); setScanProgress(initialProgress)
    try {
      updateProgress('walletAge', 'loading')
      const result = await scanWallet(walletAddress)
      updateProgress('walletAge', result.walletAge ? 'done' : 'error')
      updateProgress('solBalance', result.solBalance ? 'done' : 'error')
      updateProgress('tokenAccounts', result.tokenAccounts ? 'done' : 'error')
      updateProgress('transactions', result.transactions?.transactions?.length ? 'done' : 'error')
      updateProgress('suspicious', result.security ? 'done' : 'error')
      updateProgress('report', 'done')
      setScanResult(result); setScanState('ready')
      if (Object.keys(result.errors || {}).length) console.warn('Shield scan partial errors', result.errors)
    } catch (e) {
      console.error('Shield scan failed', e); setScanError(e?.message || 'Unable to retrieve wallet activity.'); setScanState('error')
      SCAN_STEPS.forEach((s) => setScanProgress((prev) => ({ ...prev, [s.id]: prev[s.id] === 'done' ? 'done' : 'error' })))
    }
  }

  const handleRescan = () => handleScan()
  const handleDisconnect = () => { setScanResult(null); setScanState('idle'); setScanProgress({}); setScanError(''); disconnect() }

  const handleSupport = async () => {
    const amount = Number(supportAmount)
    if (!wallet || wallet.isDemo) return setSupportError('Connect a real Solana wallet before contributing.')
    if (!shieldStats?.treasuryAddress) return setSupportError('Support is temporarily unavailable because the Shield treasury is not configured.')
    if (!Number.isFinite(amount) || amount <= 0) return setSupportError('Enter a positive SOL amount.')
    setSupportState('sending'); setSupportError(''); setSupportSignature('')
    try {
      const signature = await supportShield({ provider: getSolanaProvider(), fromAddress: walletAddress, treasuryAddress: shieldStats.treasuryAddress, solAmount: amount })
      setSupportSignature(signature); setSupportState('success')
      getShieldStats().then(setShieldStats).catch(() => {})
    } catch (error) {
      setSupportState('idle')
      setSupportError(error?.code === 4001 ? 'Contribution cancelled in wallet.' : error?.message || 'Contribution failed. Shield access is unchanged.')
    }
  }

  const security = scanResult?.security
  const tokenAccounts = scanResult?.tokenAccounts
  const transactions = scanResult?.transactions
  const walletAge = scanResult?.walletAge
  const solBalance = scanResult?.solBalance

  return (
    <>
      <PageHero eyebrow="RONIN SHIELD / 09" title="RONIN" titleAccent="SHIELD." text="Read-only wallet security scanner. No signatures. No seed phrases. Just truth, verified on-chain via Helius." image="/images/hero-ronin.jpg" className="shield-hero" petals={false}>
        <div className="page-hero-ref-actions"><Tag tone="light">READ-ONLY • NO SIGNING</Tag><Tag tone="red">🛡️ NEVER ENTER YOUR SEED PHRASE</Tag></div>
      </PageHero>

      <section className="section shield-warning-section"><div className="container"><div className="shield-warning-card"><div className="shield-warning-icon">🛡️</div><div><strong>NEVER ENTER YOUR SEED PHRASE</strong><p>RONIN will never ask for your seed phrase, private key, or secret recovery phrase. Shield scan is read-only and uses only your public wallet address.</p></div><div className="shield-warning-badge"><Icon name="shield" size={24} /><span>READ-ONLY SCAN</span></div></div></div></section>

      <section className="section shield-connect-section enhanced-section"><div className="enhanced-bg" style={{ backgroundImage: "url('/images/forge.jpg')" }} /><div className="enhanced-ink">盾</div><div className="container" style={{ position: 'relative', zIndex: 1 }}>
        <div className="section-row"><SectionHeading eyebrow="Wallet security" title="Scan your wallet." text="Connect Phantom to run a read-only security scan. No transaction signature required. Uses your public address only via existing Helius RPC." /><Tag tone="red">Solana Mainnet • Helius live</Tag></div>
        <div className="shield-connect-grid">
          <div className="surface-card enhanced-card shield-connect-card"><div className="panel-heading"><div><Eyebrow>RONIN SHIELD</Eyebrow><h3>{isConnected ? 'Wallet Connected' : 'Connect Wallet'}</h3></div><span className="shield-seal"><Icon name="shield" size={18} /></span></div>
            {!isConnected ? <><p className="shield-connect-lead">Connect Phantom to start a read-only security scan. We only use your public address.</p><div className="shield-connect-actions"><Button icon="wallet" onClick={openWalletModal}>CONNECT WALLET</Button>{!hasSolanaProvider && <p className="wallet-hint">No Solana wallet detected. Install Phantom to use Shield, or use demo to explore UI (demo cannot be scanned).</p>}</div><div className="shield-security-note"><Icon name="info" size={14} /><span>🛡️ NEVER ENTER YOUR SEED PHRASE. RONIN will never ask for it.</span></div></> : <>
              <div className="connected-card shield-connected-card"><div className="connected-avatar">盾</div><div><span className="data-label">{wallet.isDemo ? 'Demo wallet (not scannable)' : 'Connected wallet'}</span><strong style={{ fontFamily: 'var(--mono)', fontSize: '13px' }}>{wallet.shortAddress}</strong><small style={{ fontSize: '9px', color: 'var(--muted-light)', display: 'block', marginTop: '4px', wordBreak: 'break-all' }}>{walletAddress}</small></div><Tag tone={wallet.isDemo ? 'red' : 'green'}>{wallet.isDemo ? 'DEMO' : 'CONNECTED'}</Tag></div>
              {isDemoWarning && <div className="notice-box notice-box-error"><Icon name="info" size={16} /><span>Demo profile is not a real Solana address and cannot be scanned. Please connect a real Phantom wallet on mainnet to run Shield.</span></div>}
              <div className="shield-connect-actions"><Button icon="shield" onClick={handleScan} disabled={scanState === 'scanning' || wallet?.isDemo}>{scanState === 'scanning' ? 'SCANNING...' : 'SCAN WALLET'}</Button><Button variant="outline" icon="close" onClick={handleDisconnect}>DISCONNECT WALLET</Button></div>
              {scanState === 'idle' && !isDemoWarning && <div className="shield-security-note"><Icon name="check" size={14} /><span>Read-only scan • No signature required • Uses public address only</span></div>}
            </>}
          </div>

          <div className="surface-card enhanced-card shield-scan-preview"><div className="panel-heading"><div><Eyebrow>Scanning experience</Eyebrow><h3>{scanState === 'scanning' ? 'SCANNING WALLET...' : scanState === 'ready' ? 'SCAN COMPLETE' : 'READY TO SCAN'}</h3></div><Icon name={scanState === 'ready' ? 'check' : scanState === 'scanning' ? 'activity' : 'shield'} size={18} /></div>
            {scanState === 'idle' && <div className="shield-idle-list"><p>After connection, Shield will check:</p><ul>{SCAN_STEPS.map((step) => <li key={step.id}><Icon name="check" size={12} /> {step.label}</li>)}</ul><div className="shield-before-sign"><strong>BEFORE YOU SIGN ANYTHING</strong><ul><li>❌ RONIN SHIELD will NEVER ask for seed phrase, private key, secret recovery phrase</li><li>✓ Always verify the official contract address before signing</li><li>✓ Verify what you're signing</li><li>✓ Check destination/program</li><li>✓ Review in Phantom</li></ul><ContractVerifyNote compact /></div></div>}
            {scanState === 'scanning' && <div className="shield-scanning-list">{SCAN_STEPS.map((step) => { const status = scanProgress[step.id] || 'pending'; return <div key={step.id} className={`scan-step ${status}`}><span className="scan-step-icon">{status === 'done' ? <Icon name="check" size={14} /> : status === 'loading' ? <span className="scan-spinner" /> : status === 'error' ? <Icon name="info" size={14} /> : <span className="scan-dot" />}</span><span>{step.label}</span><span className="scan-step-status">{status.toUpperCase()}</span></div> })}<div className="scan-progress-bar"><div className="progress-track"><span className="progress-fill red" style={{ width: `${(Object.values(scanProgress).filter((s) => s === 'done').length / SCAN_STEPS.length) * 100}%` }} /></div></div></div>}
            {scanState === 'ready' && scanResult && <div className="shield-ready-summary"><div className="shield-summary-grid"><div><span>WALLET AGE</span><strong>{walletAge?.available ? walletAge.ageText : 'Unavailable'}</strong></div><div><span>SOL BALANCE</span><strong>{solBalance ? formatSol(solBalance.sol) : '—'}</strong></div><div><span>TOKEN ACCOUNTS</span><strong>{tokenAccounts?.count ?? '—'}</strong></div><div><span>SECURITY SCORE</span><strong>{security?.score != null ? `${security.score} / 100` : 'Unavailable'}</strong></div></div><div className="shield-summary-actions"><Button variant="outline" icon="activity" onClick={handleRescan}>RESCAN WALLET</Button><Button variant="outline" icon="close" onClick={handleDisconnect}>DISCONNECT</Button></div></div>}
            {scanState === 'error' && <div className="shield-error-box"><Icon name="info" size={18} /><div><strong>Unable to retrieve wallet activity.</strong><p>{scanError || 'RPC or Helius failure. Please try again.'}</p><div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}><Button variant="outline" icon="activity" onClick={handleRescan}>RETRY SCAN</Button><Button variant="outline" icon="close" onClick={handleDisconnect}>DISCONNECT</Button></div></div></div>}
          </div>
        </div>
      </div></section>

      {scanState === 'ready' && scanResult && <>
        <section className="section shield-stats-section"><div className="container"><div className="shield-stats-grid">
          <div className="surface-card enhanced-card shield-stat-card"><div className="shield-stat-head"><Eyebrow>Wallet age</Eyebrow><Icon name="clock" size={16} /></div>{walletAge?.available ? <><strong className="shield-stat-value">{walletAge.ageText}</strong><span className="shield-stat-detail">First activity:<br />{formatDate(walletAge.firstActivity)}</span><small className="muted-caption">Sig: {shortSig(walletAge.firstSignature)} • {walletAge.totalSignaturesScanned} txs scanned {walletAge.isApproximate ? '(approx, 5000+)' : ''}</small></> : <><strong className="shield-stat-value">Unavailable</strong><span className="shield-stat-detail">{walletAge?.reason || 'No activity found'}</span></>}</div>
          {/* <div className="surface-card enhanced-card shield-stat-card"><div className="shield-stat-head"><Eyebrow>SOL balance</Eyebrow><Icon name="coins" size={16} /></div>{solBalance ? <><strong className="shield-stat-value">{formatSol(solBalance.sol)}</strong><span className="shield-stat-detail">{solBalance.lamports.toLocaleString()} lamports</span><small className="muted-caption">Live via {solBalance.updatedAt ? new Date(solBalance.updatedAt).toLocaleTimeString() : 'RPC'}</small></> : <><strong className="shield-stat-value">—</strong><span className="shield-stat-detail">{scanResult.errors?.solBalance || 'Unable to fetch'}</span></>}</div> */}
          <div className="surface-card enhanced-card shield-stat-card"><div className="shield-stat-head"><Eyebrow>SOL balance</Eyebrow><Icon name="coins" size={16} /></div>{solBalance ? <><strong className="shield-stat-value">{formatSol(solBalance.sol)}</strong><small className="muted-caption">Live via {solBalance.updatedAt ? new Date(solBalance.updatedAt).toLocaleTimeString() : 'RPC'}</small></> : <><strong className="shield-stat-value">—</strong><span className="shield-stat-detail">{scanResult.errors?.solBalance || 'Unable to fetch'}</span></>}</div>
          <div className="surface-card enhanced-card shield-stat-card score-card"><div className="shield-stat-head"><Eyebrow>RONIN SHIELD SCORE</Eyebrow><Icon name="shield" size={16} /></div>{security?.score != null ? <><strong className="shield-stat-value score-value">{security.score} / 100</strong><span className={`shield-score-label ${scoreLabelClass(security.scoreLabel)}`}>{security.scoreLabel}</span><span className="shield-stat-detail">{security.summary}</span></> : <><strong className="shield-stat-value">Unavailable</strong><span className="shield-stat-detail">Not enough data to calculate</span></>}<div className="score-ring"><div className="score-ring-fill" style={{ '--score': security?.score != null ? security.score : 0 }} /><span>{security?.score != null ? security.score : '—'}</span></div></div>
        </div><p className="shield-scan-disclaimer"><Icon name="info" size={14} /><span>Review your wallet security status. Shield performs an on-chain analysis and reports what it finds — it cannot guarantee that any wallet is completely safe. Always verify the official contract address before signing.</span></p></div></section>

        <section className="section shield-tokens-section enhanced-section cream-enhanced"><div className="enhanced-bg" style={{ backgroundImage: "url('/images/game-landscape.jpg')" }} /><div className="container" style={{ position: 'relative', zIndex: 1 }}><div className="section-row"><SectionHeading eyebrow="Token accounts" title="What this wallet holds." text={`Found ${tokenAccounts?.count || 0} SPL token account(s). All values from blockchain. No hardcoded token info.`} /><Tag tone="light">{tokenAccounts?.count || 0} accounts • Helius + RPC</Tag></div>{tokenAccounts?.accounts?.length ? <div className="shield-token-list">{tokenAccounts.accounts.map((token, idx) => { const risk = security?.tokenRisks?.find((r) => r.mint === token.mint)?.risk || { label: '🟡 CAUTION', reason: 'Unknown' }; return <div key={`${token.mint}-${idx}`} className="surface-card enhanced-card shield-token-card"><div className="shield-token-head"><div className="shield-token-icon">{token.logo ? <img src={token.logo} alt="" /> : <span>{token.symbol?.[0] || '?'}</span>}</div><div><strong>{token.name || token.symbol || 'UNKNOWN TOKEN'}</strong><small>{token.symbol ? `${token.symbol} • ${token.mint.slice(0, 6)}...${token.mint.slice(-4)}` : `${token.mint.slice(0, 8)}...${token.mint.slice(-8)}`}</small></div><Tag tone={risk.level === 'KNOWN' ? 'green' : risk.level === 'CAUTION' ? 'neutral' : 'red'}>{risk.label}</Tag></div><div className="shield-token-details"><div><span>Mint</span><strong title={token.mint}>{shortSig(token.mint)}</strong></div><div><span>Balance</span><strong>{token.uiAmountString || token.uiAmount || token.amount || '—'}</strong></div><div><span>Decimals</span><strong>{token.decimals ?? '—'}</strong></div><div><span>Risk</span><small>{risk.reason}</small></div></div><div className="shield-token-foot"><a href={`https://solscan.io/token/${token.mint}`} target="_blank" rel="noreferrer" className="explorer-button"><Icon name="external" size={12} /> View on Solscan</a></div></div>})}</div> : <div className="surface-card enhanced-card shield-empty"><Icon name="info" size={18} /><span>{scanResult.errors?.tokenAccounts ? `Error: ${scanResult.errors.tokenAccounts}` : tokenAccounts?.partial ? 'Could not reach the Solana RPC or Helius right now, so token accounts could not be verified. This is likely a temporary network/RPC issue — please try SCAN WALLET again.' : 'No token accounts found for this wallet.'}</span></div>}</div></section>

        <section className="section shield-tx-section"><div className="container"><div className="section-row"><SectionHeading eyebrow="Recent activity" title="Recent transactions." text={`Last ${transactions?.transactions?.length || 0} transactions via ${transactions?.source || 'Helius'}. Each links to Solscan. Transaction labels are parsed from live Helius data.`} /><Tag tone="neutral">{transactions?.source || 'Helius'} • {transactions?.transactions?.length || 0} txs</Tag></div>{transactions?.transactions?.length ? <div className="shield-tx-list surface-card enhanced-card"><div className="table-head shield-tx-grid"><span>Type</span><span>Amount / Detail</span><span>Time</span><span>Status</span><span>Signature</span><span>Explorer</span></div>{transactions.transactions.map((tx) => <div key={tx.signature} className="table-row shield-tx-grid"><span className="shield-tx-type"><strong>{tx.type || 'TRANSACTION'}</strong><small title={tx.description}>{tx.description ? tx.description.slice(0, 60) : shortSig(tx.signature)}</small></span><span>{tx.tokenTransfers?.length ? `${tx.tokenTransfers.length} token transfer(s)` : tx.nativeTransfers?.length ? `${tx.nativeTransfers.length} SOL transfer(s)` : '—'}{tx.fee ? <small> Fee: {(tx.fee / 1e9).toFixed(6)} SOL</small> : null}</span><span>{formatDateTime(tx.timestamp)}</span><Tag tone={tx.status === 'Success' ? 'green' : 'red'}>{tx.status || 'Unknown'}</Tag><span title={tx.signature} style={{ fontFamily: 'var(--mono)', fontSize: '10px' }}>{shortSig(tx.signature)}</span><a href={`https://solscan.io/tx/${tx.signature}`} target="_blank" rel="noreferrer" className="explorer-button"><Icon name="external" size={12} /> VIEW ON SOLSCAN</a></div>)}</div> : <div className="surface-card enhanced-card shield-empty"><Icon name="info" size={18} /><span>{scanResult.errors?.transactions ? `Error: ${scanResult.errors.transactions}` : 'No transaction history found.'}</span></div>}</div></section>

        <section className="section shield-analysis-section enhanced-section"><div className="enhanced-bg" style={{ backgroundImage: "url('/images/hero-ronin.jpg')" }} /><div className="enhanced-ink">分析</div><div className="container" style={{ position: 'relative', zIndex: 1 }}><div className="section-row"><SectionHeading eyebrow="Security analysis" title="Known / suspicious interactions." text="Conservative analysis based only on actual wallet data. No 100% SAFE claims. Uses 🟢 KNOWN, 🟡 CAUTION, 🔴 HIGH RISK only where justified." /><Tag tone={security?.suspicious?.length ? 'red' : 'green'}>{security?.summary || 'No known issues detected'}</Tag></div><div className="shield-analysis-grid"><div className="surface-card enhanced-card"><div className="panel-heading"><div><Eyebrow>Token risk breakdown</Eyebrow><h3>{security.knownCount} known, {security.cautionCount} caution</h3></div><Icon name="shield" size={16} /></div><div className="shield-risk-list">{security.tokenRisks.slice(0, 20).map((tr, i) => <div key={i} className="shield-risk-item"><span>{tr.symbol || tr.name || shortSig(tr.mint)}</span><small>{tr.mint.slice(0, 4)}...{tr.mint.slice(-4)} • {tr.uiAmountString || tr.uiAmount}</small><Tag tone={tr.risk.level === 'KNOWN' ? 'green' : 'neutral'}>{tr.risk.label}</Tag></div>)}{security.tokenRisks.length === 0 && <p className="muted-caption">No token accounts to analyze.</p>}</div></div><div className="surface-card enhanced-card"><div className="panel-heading"><div><Eyebrow>Detected signals</Eyebrow><h3>{security.suspicious.length ? `${security.suspicious.length} signals` : 'No known issues detected'}</h3></div><Icon name="search" size={16} /></div>{security.suspicious.length ? <ul className="shield-suspicious-list">{security.suspicious.map((s, i) => <li key={i}><span className="suspicious-icon">{s.type === 'unknown_tokens' ? '🟡' : s.type === 'failed_txs' ? '🔴' : '⚠️'}</span><span>{s.message}</span></li>)}</ul> : <div className="shield-no-threat"><span className="shield-no-threat-icon">🟢</span><strong>No known issues detected</strong><p>Based on current scan, no suspicious token accounts or failed suspicious transactions were found. Always verify before signing.</p></div>}<div className="shield-analysis-foot"><small>Analysis is conservative and based on verifiable on-chain data only. Unable to determine risk where data is insufficient.</small></div></div></div></div></section>

        <section className="section shield-checklist-section"><div className="container"><div className="shield-checklist-grid"><div className="surface-card enhanced-card"><div className="panel-heading"><div><Eyebrow>Security checklist</Eyebrow><h3>What was checked.</h3></div><Tag tone="green">READ-ONLY</Tag></div><ul className="checklist"><li className={isRealWallet ? 'done' : ''}><Icon name={isRealWallet ? 'check' : 'info'} size={14} /> Wallet connected (read-only)</li><li className="done"><Icon name="check" size={14} /> Read-only wallet scan</li><li className="done"><Icon name="check" size={14} /> Seed phrase never requested</li><li className="done"><Icon name="check" size={14} /> No transaction signature required for scan</li><li className={solBalance ? 'done' : ''}><Icon name={solBalance ? 'check' : 'info'} size={14} /> SOL balance checked {solBalance ? formatSol(solBalance.sol) : ''}</li><li className={tokenAccounts ? 'done' : ''}><Icon name={tokenAccounts ? 'check' : 'info'} size={14} /> Token accounts checked {tokenAccounts ? tokenAccounts.count : ''}</li><li className={transactions ? 'done' : ''}><Icon name={transactions ? 'check' : 'info'} size={14} /> Recent activity checked {transactions ? transactions.transactions.length : ''}</li>{security?.unknownCount > 0 && <li className="warn"><Icon name="info" size={14} /> {security.unknownCount} unknown token accounts</li>}{security?.failedTxs > 0 && <li className="warn"><Icon name="info" size={14} /> {security.failedTxs} failed transactions</li>}</ul></div><div className="surface-card enhanced-card shield-guidance"><div className="panel-heading"><div><Eyebrow>Before you sign anything</Eyebrow><h3>Stay safe.</h3></div><Icon name="shield" size={16} /></div><div className="guidance-content"><div className="guidance-never"><strong>RONIN SHIELD will NEVER ask for:</strong><ul><li>❌ Seed phrase</li><li>❌ Private key</li><li>❌ Secret recovery phrase</li></ul></div><div className="guidance-do"><strong>Before signing a transaction:</strong><ul><li>✓ Always verify the official contract address before signing</li><li>✓ Verify what you're signing</li><li>✓ Check the destination/program</li><li>✓ Review the transaction in Phantom</li><li>✓ Never approve something you don't understand</li><li>✓ Be careful with unknown websites and tokens</li></ul></div><div className="shield-warning-card small"><div className="shield-warning-icon">🛡️</div><div><strong>NEVER ENTER YOUR SEED PHRASE</strong><p>RONIN will never ask for your seed phrase, private key, or secret recovery phrase.</p></div></div></div></div></div><div className="shield-bottom-actions"><Button icon="activity" onClick={handleRescan}>RESCAN WALLET</Button><Button variant="outline" icon="close" onClick={handleDisconnect}>DISCONNECT WALLET</Button><span className="muted-caption">Scan uses public address only • Helius RPC • No signing • {scanResult ? new Date(scanResult.timestamp).toLocaleString() : ''}</span></div></div></section>
        <section className="section shield-support-section"><div className="container"><div className="shield-support-grid"><div className="surface-card enhanced-card shield-support-card"><div className="panel-heading"><div><Eyebrow>Optional support</Eyebrow><h3>Support RONIN Shield 🛡️</h3></div><Icon name="shield" size={18} /></div><p>RONIN Shield is a free service. Contributions are entirely optional and are used to support the development and operation of RONIN Shield.</p><div className="shield-support-presets">{SUPPORT_PRESETS.map((preset) => <button key={preset} type="button" className={supportAmount === preset ? 'active' : ''} onClick={() => { setSupportAmount(preset); setSupportError('') }}>{preset} SOL</button>)}<label><span>Custom SOL</span><input inputMode="decimal" min="0.000000001" step="0.001" value={supportAmount} onChange={(event) => { setSupportAmount(event.target.value); setSupportError('') }} placeholder="0.00" /></label></div>{shieldStats?.treasuryAddress && supportAmount && <div className="shield-support-review"><strong>Review before wallet approval</strong><span>Destination: <code>{shieldStats.treasuryAddress}</code></span><span>Exact amount: <strong>{supportAmount} SOL</strong></span></div>}<Button icon="shield" onClick={handleSupport} disabled={supportState === 'sending' || !supportAmount || !shieldStats?.treasuryAddress}>{supportState === 'sending' ? 'WAITING FOR CONFIRMATION...' : supportState === 'success' ? 'CONTRIBUTION CONFIRMED' : 'SUPPORT WITH SOL'}</Button>{supportError && <div className="notice-box notice-box-error"><Icon name="info" size={16} /><span>{supportError}</span></div>}{supportSignature && <div className="shield-support-success"><Icon name="check" size={16} /><span>Contribution confirmed: <a href={EXPLORER_TX_URL(supportSignature)} target="_blank" rel="noreferrer">{shortSig(supportSignature)} <Icon name="external" size={12} /></a></span></div>}<small className="muted-caption">Standard native SOL transfer. Phantom approval is required. Shield access is never restricted by a cancelled or failed contribution.</small></div></div></div></section>
      </>}
    </>
  )
}
