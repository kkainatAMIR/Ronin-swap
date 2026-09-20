import { useCallback, useEffect, useState } from 'react'
import { Button, SectionHeading, Tag } from '../components/Layout'
import Icon from '../components/Icon'

// AdminRewardsPanel — REAL on-chain rewards management.
//
// Connects to:
//   GET  /api/admin/rewards/status      — read on-chain program state
//   POST /api/admin/rewards/set-paused  — pause / resume payouts
//   POST /api/admin/rewards/fund-vault  — deposit SOL into the reward vault
//   POST /api/admin/rewards/withdraw-vault — withdraw SOL from the reward vault
//
// All actions perform REAL Solana transactions signed by the backend
// admin keypair. No mock values, no hardcoded amounts.
//
// The user's wallet is NOT the admin signer for these operations — only
// the backend (with the SOLANA_REWARDS_ADMIN_KEYPAIR env var) can sign.
export default function AdminRewardsPanel() {
  const [status, setStatus] = useState(null)
  const [state, setState] = useState('idle') // idle | loading | error
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(null) // 'pause' | 'resume' | 'fund' | 'withdraw'

  // Form state
  const [fundAmount, setFundAmount] = useState('0.1')
  const [withdrawAmount, setWithdrawAmount] = useState('0.05')

  const load = useCallback(async () => {
    setState('loading')
    setError('')
    try {
      const resp = await fetch('/api/admin/rewards/status', { credentials: 'same-origin' })
      const body = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(body?.error || `Failed to load status (HTTP ${resp.status})`)
      setStatus(body)
      setState('idle')
    } catch (e) {
      setError(e?.message || 'Unable to load rewards status.')
      setState('error')
    }
  }, [])

  useEffect(() => { load() }, [load])

  const callAdminEndpoint = async (path, body) => {
    const resp = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await resp.text()
    let parsed
    try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text } }
    if (!resp.ok) {
      throw new Error(parsed?.error || `HTTP ${resp.status}`)
    }
    return parsed
  }

  const handleTogglePause = async (nextPaused) => {
    if (!window.confirm(nextPaused
      ? 'PAUSE rewards? This will reject all user claim attempts on-chain.'
      : 'RESUME rewards? Users will be able to claim again.')) return
    setBusy(nextPaused ? 'pause' : 'resume'); setError(''); setNotice('')
    try {
      const r = await callAdminEndpoint('/api/admin/rewards/set-paused', { paused: nextPaused })
      setNotice(`${nextPaused ? 'Paused' : 'Resumed'} rewards. ${r.signature ? 'Tx: ' + r.signature.slice(0, 8) + '…' : ''}`)
      await load()
    } catch (e) { setError(e?.message || 'Pause/resume failed.') }
    finally { setBusy(null) }
  }

  const handleFund = async () => {
    const amount = Number(fundAmount)
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter a valid SOL amount.'); return }
    if (!window.confirm(`Deposit ${amount} SOL into the reward vault?\n\nThis is a REAL on-chain transaction signed by the backend admin keypair.`)) return
    setBusy('fund'); setError(''); setNotice('')
    try {
      const r = await callAdminEndpoint('/api/admin/rewards/fund-vault', { amountSol: amount })
      setNotice(`Deposited ${r.amount_sol} SOL. Vault: ${r.vault_balance_before_sol} → ${r.vault_balance_after_sol} SOL. Tx: ${r.signature.slice(0, 8)}…`)
      await load()
    } catch (e) { setError(e?.message || 'Deposit failed.') }
    finally { setBusy(null) }
  }

  const handleWithdraw = async () => {
    const amount = Number(withdrawAmount)
    if (!Number.isFinite(amount) || amount <= 0) { setError('Enter a valid SOL amount.'); return }
    if (!window.confirm(`Withdraw ${amount} SOL from the reward vault to the admin wallet?\n\nThis is a REAL on-chain transaction. The SOL will move out of the vault.`)) return
    setBusy('withdraw'); setError(''); setNotice('')
    try {
      const r = await callAdminEndpoint('/api/admin/rewards/withdraw-vault', { amountSol: amount })
      setNotice(`Withdrew ${r.amount_sol} SOL. Vault: ${r.vault_balance_before_sol} → ${r.vault_balance_after_sol} SOL. Tx: ${r.signature.slice(0, 8)}…`)
      await load()
    } catch (e) { setError(e?.message || 'Withdrawal failed.') }
    finally { setBusy(null) }
  }

  if (state === 'loading' && !status) {
    return (
      <section className="surface-card admin-panel">
        <SectionHeading eyebrow="ON-CHAIN" title="Solana rewards management" />
        <div className="admin-rewards-skeleton"><span /><span /><span /></div>
      </section>
    )
  }

  if (state === 'error' && !status) {
    return (
      <section className="surface-card admin-panel">
        <SectionHeading eyebrow="ON-CHAIN" title="Solana rewards management" />
        <div className="admin-alert error">{error}</div>
        <Button icon="refresh" onClick={load}>Retry</Button>
      </section>
    )
  }

  const onChain = status?.onChain
  const dbSettings = status?.dbSettings
  const adminSignerConfigured = Boolean(status?.adminSignerConfigured)

  return (
    <section className="surface-card admin-panel admin-rewards-panel">
      <SectionHeading
        eyebrow="ON-CHAIN"
        title="Solana rewards management"
        text="Real on-chain program state. Admin operations perform live transactions signed by the backend keypair."
      />

      {error && <div className="admin-alert error">{error}</div>}
      {notice && <div className="admin-alert">{notice}</div>}

      <div className="admin-rewards-status-row">
        <Tag tone={status?.network === 'devnet' ? 'neutral' : 'green'}>
          NETWORK: {status?.network?.toUpperCase() || 'UNKNOWN'}
        </Tag>
        {onChain && (
          <Tag tone={onChain.paused ? 'red' : 'green'}>
            {onChain.paused ? 'CONTRACT PAUSED' : 'CONTRACT ACTIVE'}
          </Tag>
        )}
        <Tag tone={adminSignerConfigured ? 'green' : 'red'}>
          ADMIN SIGNER: {adminSignerConfigured ? 'CONFIGURED' : 'MISSING'}
        </Tag>
        {dbSettings && (
          <Tag tone={dbSettings.sol_rewards_enabled ? 'green' : 'neutral'}>
            REWARDS: {dbSettings.sol_rewards_enabled ? 'ENABLED' : 'DISABLED'}
          </Tag>
        )}
      </div>

      <div className="admin-rewards-grid">
        <div className="admin-rewards-stat">
          <span className="profile-data-label">PROGRAM ID</span>
          <strong className="admin-rewards-mono">{status?.programId}</strong>
        </div>
        <div className="admin-rewards-stat">
          <span className="profile-data-label">REWARD CONFIG PDA</span>
          <strong className="admin-rewards-mono">{status?.rewardConfigPda}</strong>
        </div>
        <div className="admin-rewards-stat">
          <span className="profile-data-label">REWARD VAULT PDA</span>
          <strong className="admin-rewards-mono">{status?.rewardVaultPda}</strong>
        </div>
        {onChain && (
          <>
            <div className="admin-rewards-stat">
              <span className="profile-data-label">ON-CHAIN ADMIN</span>
              <strong className="admin-rewards-mono">{onChain.admin}</strong>
              <small>The configured admin keypair pubkey MUST match this.</small>
            </div>
            <div className="admin-rewards-stat admin-rewards-stat-highlight">
              <span className="profile-data-label">VAULT BALANCE</span>
              <strong>{onChain.vaultBalanceSol} SOL</strong>
              <small>{onChain.vaultBalanceLamports.toLocaleString()} lamports</small>
            </div>
            <div className="admin-rewards-stat">
              <span className="profile-data-label">TOTAL CLAIMED</span>
              <strong>{onChain.totalClaimedSol} SOL</strong>
              <small>{onChain.totalClaims} claim{onChain.totalClaims === 1 ? '' : 's'} paid out</small>
            </div>
          </>
        )}
      </div>

      {status?.onChainError && (
        <div className="admin-alert error">
          <Icon name="info" size={14} /> Could not read on-chain state: {status.onChainError}
        </div>
      )}

      {dbSettings && (
        <div className="admin-rewards-dbsettings">
          <span className="profile-data-label">DATABASE SETTINGS</span>
          <div className="admin-rewards-dbsettings-grid">
            <div><strong>Reward asset:</strong> {dbSettings.reward_asset}</div>
            <div><strong>Points per {dbSettings.reward_asset}:</strong> {dbSettings.reward_points_per_unit}</div>
            <div><strong>Rewards enabled:</strong> {dbSettings.sol_rewards_enabled ? 'YES' : 'NO'}</div>
            <div><strong>Swap enabled:</strong> {dbSettings.swap_enabled ? 'YES' : 'NO'}</div>
          </div>
        </div>
      )}

      <div className="admin-rewards-actions">
        <div className="admin-rewards-action-card">
          <h4>Pause / Resume payouts</h4>
          <p>When paused, all user claim_reward() transactions are rejected by the program on-chain.</p>
          <div className="admin-rewards-action-buttons">
            <Button
              variant="outline"
              icon="pause"
              disabled={!onChain || onChain.paused || busy !== null}
              onClick={() => handleTogglePause(true)}
            >{busy === 'pause' ? 'Pausing…' : 'Pause rewards'}</Button>
            <Button
              variant="outline"
              icon="play"
              disabled={!onChain || !onChain.paused || busy !== null}
              onClick={() => handleTogglePause(false)}
            >{busy === 'resume' ? 'Resuming…' : 'Resume rewards'}</Button>
          </div>
        </div>

        <div className="admin-rewards-action-card">
          <h4>Fund reward vault</h4>
          <p>Deposit SOL into the reward vault PDA. The admin keypair supplies the SOL.</p>
          <div className="admin-rewards-action-row">
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)}
              disabled={busy !== null}
            />
            <span>SOL</span>
            <Button icon="arrowDown" disabled={busy !== null || !adminSignerConfigured} onClick={handleFund}>
              {busy === 'fund' ? 'Depositing…' : 'Deposit'}
            </Button>
          </div>
        </div>

        <div className="admin-rewards-action-card">
          <h4>Withdraw from vault</h4>
          <p>Withdraw SOL from the vault PDA back to the admin wallet. The program enforces a rent-exempt minimum.</p>
          <div className="admin-rewards-action-row">
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              disabled={busy !== null}
            />
            <span>SOL</span>
            <Button variant="outline" icon="arrowUp" disabled={busy !== null || !adminSignerConfigured} onClick={handleWithdraw}>
              {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw'}
            </Button>
          </div>
        </div>
      </div>

      <div className="admin-rewards-footer">
        <Button variant="outline" icon="refresh" onClick={load} disabled={state === 'loading'}>
          Refresh on-chain state
        </Button>
        {!adminSignerConfigured && (
          <small className="admin-rewards-warn">
            <Icon name="info" size={12} /> Admin signer not configured.
            Set NEW_SOLANA_REWARDS_ADMIN_SECRET_KEY (or SOLANA_REWARDS_ADMIN_SECRET_KEY) in .env.local
            to enable Pause/Resume/Deposit/Withdraw actions.
          </small>
        )}
      </div>
    </section>
  )
}
