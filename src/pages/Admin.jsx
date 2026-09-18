import { useEffect, useState } from 'react'
import Icon from '../components/Icon'
import { Button, Eyebrow, SectionHeading, Tag } from '../components/Layout'
import { isAdminWalletAddress } from '../config/admin'
import { getSolanaProvider, useWallet } from '../context/WalletContext'
import './admin.css'

const emptySettings = { points_enabled: true, minimum_qualifying_swap_usd: 10, points_per_usd: 1, transaction_points_cap_enabled: false, transaction_points_cap: '', campaigns: [], swap_enabled: true, sol_rewards_enabled: false, reward_asset: 'SOL', reward_points_per_unit: 1000, platform_fee_enabled: false, platform_fee_bps: 0 }

function useAdminApi(authenticated) {
  return async (resource, options = {}) => {
    const query = resource ? `?${new URLSearchParams(resource).toString()}` : ''
    const response = await fetch(`/api/admin/dashboard${query}`, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Admin request failed.')
    return body
  }
}

export default function Admin() {
  const { wallet: connectedWallet, connectWallet, openWalletModal } = useWallet()
  const isAuthorizedAdminWallet = Boolean(connectedWallet && !connectedWallet.isDemo && isAdminWalletAddress(connectedWallet.address))
  const [authenticated, setAuthenticated] = useState(false)
  const [authenticating, setAuthenticating] = useState(false)
  const [adminWallet, setAdminWallet] = useState('')
  const [data, setData] = useState(null)
  const [settings, setSettings] = useState(emptySettings)
  const [period, setPeriod] = useState('season')
  const [walletQuery, setWalletQuery] = useState('')
    const [walletResult, setWalletResult] = useState(null)
  const [signature, setSignature] = useState('')
  const [transaction, setTransaction] = useState(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const api = useAdminApi(authenticated)
  const adminRequest = async (url, options = {}) => {
    const response = await fetch(url, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Admin request failed.')
    return body
  }
  useEffect(() => {
    if (!authenticated) return
    api('resource=overview').then((body) => { setData(body); setSettings({ ...emptySettings, ...(body.settings || {}) }) }).catch((err) => setError(err.message))
  }, [authenticated])

  const authenticateWallet = async () => {
    setError(''); setAuthenticating(true)
    try {
      let currentWallet = connectedWallet
      if (!currentWallet || currentWallet.isDemo) { await connectWallet(); currentWallet = null }
      const provider = getSolanaProvider()
      const address = currentWallet?.address || provider?.publicKey?.toString?.()
      if (!address || !provider?.signMessage) throw new Error('Connect a wallet that supports message signing.')
      const challengeResponse = await fetch('/api/admin/auth?action=challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: address }) })
      const challenge = await challengeResponse.json()
      if (!challengeResponse.ok) throw new Error(challenge.error || 'Admin wallet is not authorized.')
      const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), 'utf8')
      const normalizeSignatureBytes = (value) => {
        if (value instanceof Uint8Array) return value
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        if (value instanceof ArrayBuffer) return new Uint8Array(value)
        if (Array.isArray(value)) return Uint8Array.from(value)
        if (typeof value === 'string') {
          const binary = atob(value)
          return Uint8Array.from(binary, (char) => char.charCodeAt(0))
        }
        if (value && typeof value === 'object') {
          const nested = value.signature ?? value.data ?? value.bytes ?? value.value
          if (nested) return normalizeSignatureBytes(nested)
        }
        return new Uint8Array()
      }
      const signatureBytes = normalizeSignatureBytes(signed)
      if (!signatureBytes.length) throw new Error('The connected wallet did not return a valid signature.')
      const signature = btoa(String.fromCharCode(...signatureBytes))
      const verifyResponse = await fetch('/api/admin/auth?action=verify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: address, nonce: challenge.nonce, signature }) })
      const verified = await verifyResponse.json()
      if (!verifyResponse.ok) throw new Error(verified.error || 'Admin signature verification failed.')
      setAdminWallet(verified.wallet); setAuthenticated(true)
    } catch (authError) { setError(authError.message || 'Admin wallet authentication failed.') } finally { setAuthenticating(false) }
  }

  if (!isAuthorizedAdminWallet) {
    return <main className="admin-shell"><section className="admin-login surface-card"><Eyebrow icon="shield">RONIN ADMIN</Eyebrow><h1>Access denied.</h1><p>This area is restricted to the configured administrator wallet.</p>{connectedWallet && <p className="admin-wallet-preview">Connected wallet: {connectedWallet.shortAddress}</p>}<Button icon="home" onClick={() => { window.location.hash = 'home' }}>Return to Ronin</Button>{!connectedWallet && <Button variant="outline" icon="wallet" onClick={openWalletModal}>Open wallet selector</Button>}</section></main>
  }

  if (!authenticated) return <main className="admin-shell"><section className="admin-login surface-card"><Eyebrow icon="shield">RONIN ADMIN</Eyebrow><h1>Secure operations.</h1><p>Connect the approved administrator wallet and sign a one-time login message. No transaction or private key is requested.</p>{connectedWallet && <p className="admin-wallet-preview">Connected: {connectedWallet.shortAddress}</p>}{error && <div className="admin-alert error">{error}</div>}<Button icon="wallet" disabled={authenticating} onClick={authenticateWallet}>{authenticating ? 'Verifying wallet...' : connectedWallet ? 'Sign admin login' : 'Connect admin wallet'}</Button>{!connectedWallet && <Button variant="outline" icon="wallet" onClick={openWalletModal}>Open wallet selector</Button>}</section></main>

  const saveSettings = async () => {
    setError(''); setNotice('')
    try { const body = await api('resource=settings', { method: 'PATCH', body: JSON.stringify(settings) }); setSettings({ ...settings, ...(body.settings || {}) }); setNotice('Settings saved and audit logged.') } catch (err) { setError(err.message) }
  }
    const searchWallet = async () => { try { setWalletResult(await api(`resource=wallet&address=${encodeURIComponent(walletQuery)}`)) } catch (err) { setError(err.message) } }
  const searchTransaction = async () => { try { setTransaction(await api(`resource=transaction&signature=${encodeURIComponent(signature)}`)) } catch (err) { setError(err.message) } }
  const loadLeaderboard = async () => { try { const body = await api(`resource=leaderboard&period=${period}`); setData((current) => ({ ...current, leaderboard: body.rows || [] })) } catch (err) { setError(err.message) } }
  const seasonAction = async (id, action) => { if (!window.confirm(`Confirm ${action} for ${id}?`)) return; try { await adminRequest('/api/admin/samurai/season-action', { method: 'POST', body: JSON.stringify({ id, action }) }); const body = await api('resource=overview'); setData(body); setNotice(`Season ${action} complete.`) } catch (err) { setError(err.message) } }
  const reviewAction = async (resource, payload) => { if (!window.confirm('Confirm this review action? Points will be recalculated.')) return; try { await adminRequest(`/api/admin/samurai/${resource}`, { method: 'POST', body: JSON.stringify(payload) }); setNotice('Review action complete and audit logged.') } catch (err) { setError(err.message) } }
  const addNote = async (payload) => { const note = window.prompt('Private admin note'); if (!note) return; try { await adminRequest('/api/admin/dashboard?resource=notes', { method: 'POST', body: JSON.stringify({ ...payload, note }) }); setNotice('Private note added.') } catch (err) { setError(err.message) } }
  const logout = async () => { await fetch('/api/admin/auth?action=logout', { method: 'POST', credentials: 'same-origin' }); setAuthenticated(false); setAdminWallet(''); setData(null) }

  return <main className="admin-shell">
    <header className="admin-header"><div><Eyebrow icon="settings">RONIN ADMIN / OPERATIONS</Eyebrow><h1>Control room.</h1><small className="admin-wallet-preview">Authorized wallet: {adminWallet}</small></div><Button variant="outline" icon="logOut" onClick={logout}>Sign out</Button></header>
    {error && <div className="admin-alert error">{error}</div>}{notice && <div className="admin-alert">{notice}</div>}
    <section className="admin-status-grid">{[['swap_enabled', 'RONIN SWAP'], ['points_enabled', 'SAMURAI POINTS'], ['sol_rewards_enabled', 'SOL REWARDS'], ['platform_fee_enabled', 'PLATFORM FEE']].map(([key, label]) => <div className="admin-status surface-card" key={key}><span>{label}</span><strong className={settings[key] ? 'on' : 'off'}>{settings[key] ? 'ACTIVE' : 'OFF'}</strong></div>)}</section>
    <section className="admin-metrics">{[['24H SWAP VOLUME', data?.overview?.volume_24h], ['TOTAL SWAP VOLUME', data?.overview?.total_volume], ['TOTAL SWAPS', data?.overview?.total_swaps], ['UNIQUE WALLETS', data?.overview?.unique_wallets], ['SAMURAI POINTS ISSUED', data?.overview?.points_issued], ['FLAGGED ACTIVITY', data?.overview?.flagged_activity], ['PLATFORM FEES', settings.platform_fee_enabled ? 'ENABLED' : 'OFF']].map(([label, value]) => <div className="admin-metric surface-card" key={label}><span>{label}</span><strong>{value == null ? '—' : typeof value === 'number' ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 }) : value}</strong></div>)}</section>
    <section className="admin-grid">
      <div className="surface-card admin-panel"><SectionHeading eyebrow="Points" title="Samurai settings." text="Changes apply server-side to future verified point processing." /><div className="admin-form-grid"><label>Points enabled<input type="checkbox" checked={Boolean(settings.points_enabled)} onChange={(event) => setSettings({ ...settings, points_enabled: event.target.checked })} /></label><label>Minimum qualifying swap<input type="number" min="0" step="0.000001" value={settings.minimum_qualifying_swap_usd} onChange={(event) => setSettings({ ...settings, minimum_qualifying_swap_usd: event.target.value })} /></label><label>Points per USD<input type="number" min="0" step="0.000001" value={settings.points_per_usd} onChange={(event) => setSettings({ ...settings, points_per_usd: event.target.value })} /></label><label>Transaction cap enabled<input type="checkbox" checked={Boolean(settings.transaction_points_cap_enabled)} onChange={(event) => setSettings({ ...settings, transaction_points_cap_enabled: event.target.checked })} /></label><label>Transaction points cap<input type="number" min="0" value={settings.transaction_points_cap || ''} onChange={(event) => setSettings({ ...settings, transaction_points_cap: event.target.value })} /></label></div><Button icon="save" onClick={saveSettings}>Save settings</Button></div>
      <div className="surface-card admin-panel"><SectionHeading eyebrow="Rewards" title="SOL rewards configuration." text="Toggle SOL rewards on/off and configure the points-to-SOL conversion rate. The on-chain Solana program pays out actual SOL when a user claims; the conversion rate is recorded with each claim." /><div className="admin-form-grid"><label>SOL rewards enabled<input type="checkbox" checked={Boolean(settings.sol_rewards_enabled)} onChange={(event) => setSettings({ ...settings, sol_rewards_enabled: event.target.checked })} /></label><label>Reward asset<input type="text" value={settings.reward_asset || 'SOL'} onChange={(event) => setSettings({ ...settings, reward_asset: event.target.value })} placeholder="SOL" /></label><label>Points per {settings.reward_asset || 'SOL'}<input type="number" min="1" step="1" value={settings.reward_points_per_unit || 1000} onChange={(event) => setSettings({ ...settings, reward_points_per_unit: event.target.value })} /></label></div><Button icon="save" onClick={saveSettings}>Save rewards settings</Button></div>
      <div className="surface-card admin-panel"><SectionHeading eyebrow="Campaigns" title="Multiplier rules." text="Existing campaign rules are stored and consumed by the points engine." /><textarea rows="8" value={JSON.stringify(settings.campaigns, null, 2)} onChange={(event) => { try { setSettings({ ...settings, campaigns: JSON.parse(event.target.value) }) } catch {} }} /><Button variant="outline" icon="save" onClick={saveSettings}>Save campaigns</Button></div>
    </section>
    <section className="surface-card admin-panel"><SectionHeading eyebrow="Review" title="Leaderboard and activity." /><div className="admin-toolbar"><select value={period} onChange={(event) => setPeriod(event.target.value)}>{['daily', 'weekly', 'monthly', 'season', 'all-time'].map((item) => <option key={item}>{item}</option>)}</select><Button icon="refresh" onClick={loadLeaderboard}>Load leaderboard</Button></div><div className="admin-table-wrap"><table><thead><tr><th>Rank</th><th>Wallet</th><th>Volume</th><th>Points</th><th>Swaps</th></tr></thead><tbody>{(data?.leaderboard || []).map((row) => <tr key={row.wallet || row.rank}><td>{row.rank}</td><td>{row.wallet}</td><td>{row.verified_volume}</td><td>{row.samurai_points}</td><td>{row.qualifying_swaps}</td></tr>)}</tbody></table></div></section>
    <section className="admin-grid"><div className="surface-card admin-panel"><SectionHeading eyebrow="Wallet review" title="Inspect wallet." /><div className="admin-toolbar"><input value={walletQuery} onChange={(event) => setWalletQuery(event.target.value)} placeholder="Wallet address (Solana or EVM)" /><Button icon="search" onClick={searchWallet}>Search</Button></div>{walletResult?.wallet && <><div className="admin-toolbar"><Button variant="outline" icon="flag" onClick={() => reviewAction('flag', { wallet: walletResult.wallet.wallet_address })}>Flag</Button><Button variant="outline" icon="slash" onClick={() => reviewAction('exclude', { wallet: walletResult.wallet.wallet_address })}>Exclude</Button><Button variant="outline" icon="refresh" onClick={() => reviewAction('restore', { wallet: walletResult.wallet.wallet_address })}>Restore</Button><Button variant="outline" icon="fileText" onClick={() => addNote({ wallet: walletResult.wallet.wallet_address })}>Add note</Button></div><pre>{JSON.stringify(walletResult, null, 2)}</pre></>}</div><div className="surface-card admin-panel"><SectionHeading eyebrow="Transaction review" title="Inspect transaction." /><div className="admin-toolbar"><input value={signature} onChange={(event) => setSignature(event.target.value)} placeholder="Transaction hash or signature" /><Button icon="search" onClick={searchTransaction}>Search</Button></div>{transaction && <><div className="admin-toolbar"><Button variant="outline" icon="flag" onClick={() => reviewAction('flag', { signature })}>Flag</Button><Button variant="outline" icon="slash" onClick={() => reviewAction('exclude', { signature })}>Exclude</Button><Button variant="outline" icon="refresh" onClick={() => reviewAction('restore', { signature })}>Restore</Button><Button variant="outline" icon="fileText" onClick={() => addNote({ signature })}>Add note</Button></div><pre>{JSON.stringify(transaction, null, 2)}</pre></>}</div></section>
    <section className="surface-card admin-panel"><SectionHeading eyebrow="Seasons" title="Lifecycle management." /><div className="admin-season-list">{(data?.seasons || []).map((season) => <div className="admin-season-row" key={season.id}><strong>{season.name}</strong><Tag tone="neutral">{season.status}</Tag><span>{season.id}</span><div>{season.status === 'DRAFT' && <Button variant="outline" onClick={() => seasonAction(season.id, 'activate')}>Activate</Button>}{season.status === 'ACTIVE' && <Button variant="outline" onClick={() => seasonAction(season.id, 'end')}>End</Button>}{season.status === 'ENDED' && <Button variant="outline" onClick={() => seasonAction(season.id, 'freeze')}>Freeze</Button>}{season.status === 'FROZEN' && <Button variant="outline" onClick={() => seasonAction(season.id, 'archive')}>Archive</Button>}</div></div>)}</div></section>
    <section className="surface-card admin-panel admin-disabled-controls"><div><Eyebrow>On-chain payouts</Eyebrow><h2>SOL payouts are server-controlled.</h2><p>SOL rewards are {settings.sol_rewards_enabled ? 'ENABLED — users can claim from the Profile page' : 'currently OFF'} and platform fees are {settings.platform_fee_enabled ? 'enabled by configuration' : 'OFF'}. The backend signs the on-chain payout transaction with the admin keypair configured via SOLANA_REWARDS_ADMIN_KEYPAIR / SOLANA_REWARDS_ADMIN_SECRET_KEY; no private key is exposed to the browser.</p></div><Tag tone={settings.sol_rewards_enabled ? 'green' : 'neutral'}>{settings.sol_rewards_enabled ? 'REWARDS LIVE' : 'SERVER CONTROLLED'}</Tag></section>
  </main>
}