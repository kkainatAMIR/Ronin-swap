import { useEffect, useState } from 'react'
import Icon from '../components/Icon'
import { Button, Eyebrow, SectionHeading, Tag } from '../components/Layout'
import AdminRewardsPanel from '../components/AdminRewardsPanel'
import { isAdminWalletAddress } from '../config/admin'
import { getChain } from '../config/chains'
import { importEvmTokenByAddress, importSolanaTokenByMint } from '../services/tokenImport'
import { getSolanaProvider, useWallet } from '../context/WalletContext'
import { filterAdminHistory, getAdminCampaignStatus, isAdminSeasonActive } from '../utils/adminCampaignSeasonFilters.mjs'
import './admin.css'

const emptySettings = { points_enabled: true, minimum_qualifying_swap_usd: 10, points_per_usd: 1, transaction_points_cap_enabled: false, transaction_points_cap: '', effective_multiplier_ceiling: 3, ronin_buy_multiplier: 2, ronin_sell_multiplier: 0.25, campaigns: [], swap_enabled: true, sol_rewards_enabled: false, reward_asset: 'SOL', reward_points_per_unit: 1000, platform_fee_enabled: false, platform_fee_bps: 0 }
const emptySeasonDraft = { id: '', name: '', startAt: '', endAt: '', minimumQualifyingVolume: '10', rewardPoolAmount: '', claimWindowStart: '', claimWindowEnd: '' }
const campaignChainOptions = [
  { id: 101, name: 'Solana' },
  { id: 1, name: getChain('ethereum').name },
  { id: 4663, name: getChain('robinhood').name },
]

function CampaignTokenField({ campaign, field, chainId, updateCampaign }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const metadataField = field === 'inputMint' ? 'inputTokenMetadata' : 'outputTokenMetadata'
  const metadata = campaign[metadataField]
  const chainKey = Number(chainId) === 101
    ? 'solana'
    : Number(chainId) === 1
      ? 'ethereum'
      : Number(chainId) === 4663
        ? 'robinhood'
        : null
  const address = campaign[field] || ''

  const loadMetadata = async () => {
    setLoading(true)
    setError('')
    try {
      const token = chainKey === 'solana'
        ? await importSolanaTokenByMint(address.trim())
        : await importEvmTokenByAddress(chainKey, address.trim())
      if (!token) throw new Error('No token metadata was found for this address.')
      updateCampaign(metadataField, {
        name: token.name,
        symbol: token.symbol,
        logoURI: token.logoURI || null,
      })
    } catch (lookupError) {
      setError(lookupError?.message || 'Could not load token metadata.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <label>{field === 'inputMint' ? 'Input Token / Mint' : 'Output Token / Mint'}
        <input
          maxLength="128"
          value={address}
          onChange={(event) => {
            updateCampaign(field, event.target.value)
            updateCampaign(metadataField, null)
            setError('')
          }}
        />
      </label>
      <Button
        type="button"
        variant="outline"
        disabled={!chainKey || !address.trim() || loading}
        onClick={loadMetadata}
      >
        {loading ? 'Loading metadata...' : 'Load token metadata'}
      </Button>
      {!chainKey && <small>Select a specific chain above to look up token metadata.</small>}
      {metadata && (
        <div className="admin-campaign-token-metadata">
          {metadata.logoURI
            ? <img src={metadata.logoURI} alt="" width="32" height="32" />
            : <span className="admin-campaign-token-placeholder" aria-hidden="true" />}
          <span><strong>{metadata.name}</strong><small>{metadata.symbol}</small></span>
        </div>
      )}
      {error && <small role="alert">{error}</small>}
    </div>
  )
}

function dateTimeLocal(value) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

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
  const [seasonDraft, setSeasonDraft] = useState(emptySeasonDraft)
  const [seasonRewardDrafts, setSeasonRewardDrafts] = useState({})
  const [seasonClaimDeadlineDrafts, setSeasonClaimDeadlineDrafts] = useState({})
  const [seasonRestartDrafts, setSeasonRestartDrafts] = useState({})
  const [seasonMinimumDrafts, setSeasonMinimumDrafts] = useState({})
  const [seasonClaimReports, setSeasonClaimReports] = useState({})
  const [adminView, setAdminView] = useState(() => window.location.hash === '#history' ? 'history' : 'active')
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyStatus, setHistoryStatus] = useState('ALL')
  const [currentTime, setCurrentTime] = useState(Date.now())

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
  useEffect(() => {
    const syncView = () => setAdminView(window.location.hash === '#history' ? 'history' : 'active')
    window.addEventListener('hashchange', syncView)
    return () => window.removeEventListener('hashchange', syncView)
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const authenticateWallet = async () => {
    setError(''); setAuthenticating(true)
    try {
      let currentWallet = connectedWallet
      if (!currentWallet || currentWallet.isDemo) { await connectWallet(); currentWallet = null }
      let provider = null
      let address = ''
      for (let attempt = 0; attempt < 4; attempt += 1) {
        provider = getSolanaProvider()
        address = provider?.publicKey?.toString?.() || provider?.publicKey || currentWallet?.address || ''
        if (provider?.signMessage && address) break
        if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 150))
      }
      if (provider?.connect && !address && !provider.isConnected) {
        const connection = await provider.connect()
        provider = getSolanaProvider() || provider
        address = provider?.publicKey?.toString?.() || provider?.publicKey || connection?.publicKey?.toString?.() || connection?.publicKey || ''
      }
      if (!address || !provider?.signMessage) {
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
        throw new Error(isMobile
          ? 'Open Ronin Swap inside the Phantom app and reconnect your administrator wallet.'
          : 'Connect a wallet that supports message signing.')
      }
      const challengeResponse = await fetch('/api/admin/auth?action=challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet: address }) })
      const challenge = await challengeResponse.json()
      if (!challengeResponse.ok) throw new Error(challenge.error || 'Admin wallet is not authorized.')
      const messageBytes = new TextEncoder().encode(challenge.message)
      const signed = await provider.signMessage(messageBytes)
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

  const allCampaigns = Array.isArray(settings.campaigns) ? settings.campaigns : []
  const allSeasons = Array.isArray(data?.seasons) ? data.seasons : []
  const activeCampaignEntries = allCampaigns
    .map((campaign, index) => ({ campaign, index }))
    .filter(({ campaign }) => getAdminCampaignStatus(campaign, currentTime) === 'ACTIVE')
  const activeCampaigns = activeCampaignEntries.map(({ campaign }) => campaign)
  const activeSeasons = allSeasons.filter((season) => isAdminSeasonActive(season, currentTime))
  const historicalCampaigns = allCampaigns
    .map((campaign, index) => ({ campaign, index }))
    .filter(({ campaign }) => getAdminCampaignStatus(campaign, currentTime) !== 'ACTIVE')
  const historicalSeasons = allSeasons.filter((season) => !isAdminSeasonActive(season, currentTime))
  const campaignStatuses = [...new Set(historicalCampaigns.map(({ campaign }) => getAdminCampaignStatus(campaign, currentTime)))].sort()
  const seasonStatuses = [...new Set(historicalSeasons.map((season) => season.status || 'UNKNOWN'))].sort()
  const filteredCampaigns = filterAdminHistory(historicalCampaigns, {
    query: historyQuery,
    status: historyStatus,
    getStatus: ({ campaign }) => getAdminCampaignStatus(campaign, currentTime),
    getSearchText: ({ campaign }) => `${campaign.name || ''} ${campaign.id || ''}`,
  })
  const filteredSeasons = filterAdminHistory(historicalSeasons, {
    query: historyQuery,
    status: historyStatus,
    getStatus: (season) => season.status || 'UNKNOWN',
    getSearchText: (season) => `${season.name || ''} ${season.id || ''}`,
  })
  const campaignEntriesToManage = adminView === 'history'
    ? filteredCampaigns
    : activeCampaignEntries

  const saveSettings = async () => {
    setError(''); setNotice('')
    try { const body = await api('resource=settings', { method: 'PATCH', body: JSON.stringify(settings) }); setSettings({ ...settings, ...(body.settings || {}) }); setNotice('Settings saved and audit logged.') } catch (err) { setError(err.message) }
  }
  const updateCampaign = (index, key, value) => {
    setSettings((current) => {
      const campaigns = [...(Array.isArray(current.campaigns) ? current.campaigns : [])]
      campaigns[index] = { ...campaigns[index], [key]: value }
      return { ...current, campaigns }
    })
  }
  const addCampaign = (enabled = true) => setSettings({
    ...settings,
    campaigns: [...(Array.isArray(settings.campaigns) ? settings.campaigns : []), {
      id: `campaign-${Date.now()}`,
      name: '',
      promoCode: '',
      enabled,
      startDate: '',
      endDate: '',
      multiplier: 1,
      source: '',
      direction: 'any',
      chainId: '',
      inputMint: '',
      outputMint: '',
    }],
  })
    const searchWallet = async () => { try { setWalletResult(await api(`resource=wallet&address=${encodeURIComponent(walletQuery)}`)) } catch (err) { setError(err.message) } }
  const searchTransaction = async () => { try { setTransaction(await api(`resource=transaction&signature=${encodeURIComponent(signature)}`)) } catch (err) { setError(err.message) } }
  const loadLeaderboard = async () => { try { const body = await api(`resource=leaderboard&period=${period}`); setData((current) => ({ ...current, leaderboard: body.rows || [] })) } catch (err) { setError(err.message) } }
  const loadSeasonClaimReport = async (season) => {
    setError('')
    try {
      const response = await adminRequest(`/api/admin/seasons?id=${encodeURIComponent(season.id)}&report=claims`)
      setSeasonClaimReports((current) => ({ ...current, [season.id]: response.claimReport }))
    } catch (err) {
      setError(err.message)
    }
  }
  const seasonAction = async (id, action) => {
    const prompt = action === 'finalize_rewards'
      ? `Finalize the SOL reward allocation for ${id}? This creates a durable allocation version from eligible linked-identity points.`
      : action === 'unarchive'
        ? `Unarchive ${id}? It will return to FROZEN status and will not resume points earning.`
        : `Confirm ${action} for ${id}?`
    if (!window.confirm(prompt)) return
    setError('')
    setNotice('')
    try {
      await adminRequest('/api/admin/samurai/season-action', { method: 'POST', body: JSON.stringify({ id, action }) })
      const body = await api('resource=overview')
      setData(body)
      setNotice(action === 'finalize_rewards' ? 'Season rewards finalized.' : action === 'unarchive' ? 'Season restored to frozen status.' : `Season ${action} complete.`)
    } catch (err) {
      setError(err.message)
      try {
        const body = await api('resource=overview')
        setData(body)
      } catch (refreshError) {
        console.error('Failed to refresh seasons after action error:', refreshError?.message || refreshError)
      }
    }
  }
  const configureSeasonRewards = async (season) => {
    const rewardDraft = seasonRewardDrafts[season.id] || {}
    try {
      await adminRequest('/api/admin/seasons', {
        method: 'POST',
        body: JSON.stringify({
          id: season.id,
          action: 'configure_rewards',
          rewardPoolAmount: rewardDraft.amount || '',
          claimWindowStart: rewardDraft.claimWindowStart || '',
          claimWindowEnd: rewardDraft.claimWindowEnd || '',
        }),
      })
      const body = await api('resource=overview')
      setData(body)
      setNotice(`SOL reward pool configured for ${season.name}.`)
    } catch (err) { setError(err.message) }
  }
  const extendSeasonClaimWindow = async (season) => {
    const deadline = seasonClaimDeadlineDrafts[season.id]
    const deadlineTimestamp = Date.parse(deadline)
    if (!Number.isFinite(deadlineTimestamp) || deadlineTimestamp <= Date.now()
      || deadlineTimestamp <= Date.parse(season.claim_window_end)) {
      setError('Choose a new claim deadline later than the current deadline and in the future.')
      return
    }
    if (!window.confirm(`Extend ${season.name}'s claim deadline to ${new Date(deadlineTimestamp).toLocaleString()}? The finalized allocations and reward amounts will not change.`)) return
    setError('')
    setNotice('')
    try {
      await adminRequest('/api/admin/samurai/season-action', {
        method: 'POST',
        body: JSON.stringify({
          id: season.id,
          action: 'extend_claim_window',
          claimWindowEnd: new Date(deadlineTimestamp).toISOString(),
        }),
      })
      const body = await api('resource=overview')
      setData(body)
      setSeasonClaimDeadlineDrafts((current) => ({ ...current, [season.id]: '' }))
      setNotice(`Claim window extended for ${season.name}.`)
    } catch (err) {
      setError(err.message)
      try {
        const body = await api('resource=overview')
        setData(body)
      } catch (refreshError) {
        console.error('Failed to refresh seasons after claim-window update error:', refreshError?.message || refreshError)
      }
    }
  }
  const restartFinalizedSeason = async (season) => {
    const draft = seasonRestartDrafts[season.id] || {}
    const endAt = Date.parse(draft.endAt)
    const claimWindowStart = Date.parse(draft.claimWindowStart)
    const claimWindowEnd = Date.parse(draft.claimWindowEnd)
    if (!Number.isFinite(endAt) || endAt <= Date.now()
      || !Number.isFinite(claimWindowStart) || claimWindowStart < endAt
      || !Number.isFinite(claimWindowEnd) || claimWindowEnd <= claimWindowStart) {
      setError('Choose a future season end, then a claim window starting on or after that end.')
      return
    }
    const confirmation = `Restart ${season.name} for earning until ${new Date(endAt).toLocaleString()}? New verified points will be included in a new reward allocation version. The current reward pool is unchanged, previous allocations remain recorded, and restart is blocked if any reward was paid or is in progress.`
    if (!window.confirm(confirmation)) return
    setError('')
    setNotice('')
    try {
      await adminRequest('/api/admin/samurai/season-action', {
        method: 'POST',
        body: JSON.stringify({
          id: season.id,
          action: 'restart_finalized',
          endAt: new Date(endAt).toISOString(),
          claimWindowStart: new Date(claimWindowStart).toISOString(),
          claimWindowEnd: new Date(claimWindowEnd).toISOString(),
        }),
      })
      const body = await api('resource=overview')
      setData(body)
      setSeasonRestartDrafts((current) => ({ ...current, [season.id]: {} }))
      setNotice(`${season.name} restarted. Earning is active until the new end date; finalize again after it ends.`)
    } catch (err) {
      setError(err.message)
      try {
        const body = await api('resource=overview')
        setData(body)
      } catch (refreshError) {
        console.error('Failed to refresh seasons after restart error:', refreshError?.message || refreshError)
      }
    }
  }
  const updateSeasonMinimum = async (season) => {
    const minimumQualifyingVolume = seasonMinimumDrafts[season.id] ?? String(season.minimum_qualifying_volume ?? 10)
    if (minimumQualifyingVolume === '' || !Number.isFinite(Number(minimumQualifyingVolume)) || Number(minimumQualifyingVolume) < 0) {
      setError('Enter a non-negative minimum qualifying swap amount.')
      return
    }
    setError('')
    setNotice('')
    try {
      await adminRequest('/api/admin/seasons', {
        method: 'POST',
        body: JSON.stringify({
          id: season.id,
          action: 'update_minimum',
          minimumQualifyingVolume: Number(minimumQualifyingVolume),
        }),
      })
      const body = await api('resource=overview')
      setData(body)
      setSeasonMinimumDrafts((current) => {
        const next = { ...current }
        delete next[season.id]
        return next
      })
      setNotice(`Minimum qualifying swap for ${season.name} is now $${Number(minimumQualifyingVolume)}.`)
    } catch (err) {
      setError(err.message)
    }
  }
  const createSeasonRecord = async () => {
    setError(''); setNotice('')
    const startAt = Date.parse(seasonDraft.startAt)
    const endAt = Date.parse(seasonDraft.endAt)
    if (!seasonDraft.id.trim() || !seasonDraft.name.trim() || !Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt
      || seasonDraft.minimumQualifyingVolume === '' || !Number.isFinite(Number(seasonDraft.minimumQualifyingVolume)) || Number(seasonDraft.minimumQualifyingVolume) < 0) {
      setError('Enter a season ID, name, non-negative minimum qualifying amount, and a valid date range with the end after the start.')
      return
    }
    const rewardPoolEnabled = Boolean(seasonDraft.rewardPoolAmount.trim())
    const claimWindowStart = Date.parse(seasonDraft.claimWindowStart)
    const claimWindowEnd = Date.parse(seasonDraft.claimWindowEnd)
    if (rewardPoolEnabled && (!Number.isFinite(Number(seasonDraft.rewardPoolAmount)) || Number(seasonDraft.rewardPoolAmount) <= 0
      || !Number.isFinite(claimWindowStart) || !Number.isFinite(claimWindowEnd) || claimWindowEnd <= claimWindowStart)) {
      setError('Enter a positive SOL reward pool and a valid claim window.')
      return
    }
    try {
      await adminRequest('/api/admin/seasons', {
        method: 'POST',
        body: JSON.stringify({
          id: seasonDraft.id.trim(),
          name: seasonDraft.name.trim(),
          startAt: new Date(startAt).toISOString(),
          endAt: new Date(endAt).toISOString(),
          minimumQualifyingVolume: Number(seasonDraft.minimumQualifyingVolume),
          ...(rewardPoolEnabled ? {
            rewardPoolAmount: seasonDraft.rewardPoolAmount,
            claimWindowStart: new Date(claimWindowStart).toISOString(),
            claimWindowEnd: new Date(claimWindowEnd).toISOString(),
          } : {}),
        }),
      })
      const body = await api('resource=overview')
      setData(body)
      setSeasonDraft(emptySeasonDraft)
      setNotice('Draft season created.')
    } catch (err) { setError(err.message) }
  }
  const reviewAction = async (resource, payload) => { if (!window.confirm('Confirm this review action? Points will be recalculated.')) return; try { await adminRequest(`/api/admin/samurai/${resource}`, { method: 'POST', body: JSON.stringify(payload) }); setNotice('Review action complete and audit logged.') } catch (err) { setError(err.message) } }
  const addNote = async (payload) => { const note = window.prompt('Private admin note'); if (!note) return; try { await adminRequest('/api/admin/dashboard?resource=notes', { method: 'POST', body: JSON.stringify({ ...payload, note }) }); setNotice('Private note added.') } catch (err) { setError(err.message) } }
  const logout = async () => { await fetch('/api/admin/auth?action=logout', { method: 'POST', credentials: 'same-origin' }); setAuthenticated(false); setAdminWallet(''); setData(null) }

  const openAdminView = (view) => {
    const hash = view === 'history' ? '#history' : '#active'
    if (window.location.hash !== hash) window.location.hash = hash
    else setAdminView(view)
    setHistoryQuery('')
    setHistoryStatus('ALL')
  }

  return <main className="admin-shell">
    <header className="admin-header"><div><Eyebrow icon="settings">RONIN ADMIN / OPERATIONS</Eyebrow><h1>{adminView === 'history' ? 'Campaign & Season History.' : 'Active Campaigns & Seasons.'}</h1><small className="admin-wallet-preview">Authorized wallet: {adminWallet}</small></div><Button variant="outline" icon="logOut" onClick={logout}>Sign out</Button></header>
    <nav className="admin-season-navigation" aria-label="Campaign and season management">
      <button type="button" className={adminView === 'active' ? 'active' : ''} aria-current={adminView === 'active' ? 'page' : undefined} onClick={() => openAdminView('active')}>Active</button>
      <button type="button" className={adminView === 'history' ? 'active' : ''} aria-current={adminView === 'history' ? 'page' : undefined} onClick={() => openAdminView('history')}>History</button>
    </nav>
    {error && <div className="admin-alert error">{error}</div>}{notice && <div className="admin-alert">{notice}</div>}
    {adminView === 'active' ? (
      <>
        <section className="surface-card admin-panel admin-active-seasons">
          <SectionHeading eyebrow="Live management" title="Active Campaigns & Seasons" text="Only currently active records are shown here. Expired and other non-active records remain available in History." />
          <div className="admin-active-records">
            {activeSeasons.map((season) => (
              <article className="admin-active-record" key={`season-${season.id}`}>
                <div><Tag tone="green">ACTIVE SEASON</Tag><h3>{season.name}</h3><small>{season.id}</small></div>
                <p>Start: {new Date(season.start_at).toLocaleString()}</p>
                <p>End: {new Date(season.end_at).toLocaleString()}</p>
                <p>Reward pool: {season.reward_pool_status && season.reward_pool_status !== 'UNCONFIGURED' ? `${season.reward_pool_amount} SOL · ${season.reward_pool_status}` : 'Not configured'}</p>
                <label>Minimum qualifying swap (USD)
                  <input
                    type="number"
                    min="0"
                    step="0.000001"
                    value={seasonMinimumDrafts[season.id] ?? String(season.minimum_qualifying_volume ?? 10)}
                    onChange={(event) => setSeasonMinimumDrafts((current) => ({ ...current, [season.id]: event.target.value }))}
                  />
                </label>
                <div className="admin-season-actions">
                  <Button variant="outline" icon="save" onClick={() => updateSeasonMinimum(season)}>Save minimum</Button>
                  <Button variant="outline" icon="close" onClick={() => seasonAction(season.id, 'end')}>End season</Button>
                </div>
              </article>
            ))}
            {activeCampaigns.map((campaign) => (
              <article className="admin-active-record" key={`campaign-${campaign.id}`}>
                <div><Tag tone="green">ACTIVE CAMPAIGN</Tag><h3>{campaign.name || campaign.id}</h3><small>{campaign.id}</small></div>
                <p>Start: {campaign.startDate || campaign.start_at ? new Date(campaign.startDate || campaign.start_at).toLocaleString() : 'Open'}</p>
                <p>End: {campaign.endDate || campaign.end_at ? new Date(campaign.endDate || campaign.end_at).toLocaleString() : 'Open-ended'}</p>
                <p>Multiplier: ×{campaign.multiplier ?? 1}</p>
                <Button variant="outline" icon="settings" onClick={() => document.getElementById(`campaign-${campaign.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>Manage</Button>
              </article>
            ))}
            {activeSeasons.length === 0 && activeCampaigns.length === 0 && (
              <div className="admin-active-empty">
                <p>No active campaigns or seasons.</p>
                <Button variant="outline" icon="history" onClick={() => openAdminView('history')}>View Campaign & Season History</Button>
              </div>
            )}
          </div>
        </section>
        <section className="admin-status-grid">{[['swap_enabled', 'RONIN SWAP'], ['points_enabled', 'SAMURAI POINTS'], ['sol_rewards_enabled', 'SOL REWARDS'], ['platform_fee_enabled', 'PLATFORM FEE']].map(([key, label]) => <div className="admin-status surface-card" key={key}><span>{label}</span><strong className={settings[key] ? 'on' : 'off'}>{settings[key] ? 'ACTIVE' : 'OFF'}</strong></div>)}</section>
        <section className="admin-metrics">{[['24H SWAP VOLUME', data?.overview?.volume_24h], ['TOTAL SWAP VOLUME', data?.overview?.total_volume], ['TOTAL SWAPS', data?.overview?.total_swaps], ['UNIQUE WALLETS', data?.overview?.unique_wallets], ['SAMURAI POINTS ISSUED', data?.overview?.points_issued], ['FLAGGED ACTIVITY', data?.overview?.flagged_activity], ['PLATFORM FEES', settings.platform_fee_enabled ? 'ENABLED' : 'OFF']].map(([label, value]) => <div className="admin-metric surface-card" key={label}><span>{label}</span><strong>{value == null ? '—' : typeof value === 'number' ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 }) : value}</strong></div>)}</section>
      </>
    ) : (
      <section className="surface-card admin-panel admin-history-filters">
        <SectionHeading eyebrow="Management archive" title="Campaign & Season History" text="Draft, upcoming, ended, frozen, finalized, archived, disabled, and other non-active records remain manageable here." />
        <div className="admin-history-controls">
          <label>Search<input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="Search season or campaign name / ID" /></label>
          <label>Status<select value={historyStatus} onChange={(event) => setHistoryStatus(event.target.value)}>
            <option value="ALL">All non-active statuses</option>
            {[...new Set([...campaignStatuses, ...seasonStatuses])].sort().map((status) => <option key={status} value={status}>{status}</option>)}
          </select></label>
        </div>
        <small>{filteredCampaigns.length} campaigns · {filteredSeasons.length} seasons</small>
      </section>
    )}
    <section className="admin-grid">
      {adminView === 'active' && (
        <>
      <div className="surface-card admin-panel"><SectionHeading eyebrow="Points" title="Samurai settings." text="Changes apply server-side to future verified point processing." /><div className="admin-form-grid"><label>Points enabled<input type="checkbox" checked={Boolean(settings.points_enabled)} onChange={(event) => setSettings({ ...settings, points_enabled: event.target.checked })} /></label><label>Minimum qualifying swap<input type="number" min="0" step="0.000001" value={settings.minimum_qualifying_swap_usd} onChange={(event) => setSettings({ ...settings, minimum_qualifying_swap_usd: event.target.value })} /><small>An active season’s own minimum takes precedence; edit it in the season card below.</small></label><label>Points per USD<input type="number" min="0" step="0.000001" value={settings.points_per_usd} onChange={(event) => setSettings({ ...settings, points_per_usd: event.target.value })} /></label><label>Effective multiplier ceiling<input type="number" min="0.000001" step="0.000001" value={settings.effective_multiplier_ceiling} onChange={(event) => setSettings({ ...settings, effective_multiplier_ceiling: event.target.value })} /><small>Maximum combined directional and campaign multiplier.</small></label><label>RONIN buy multiplier<input type="number" min="0" step="0.000001" value={settings.ronin_buy_multiplier} onChange={(event) => setSettings({ ...settings, ronin_buy_multiplier: event.target.value })} /></label><label>RONIN sell multiplier<input type="number" min="0" step="0.000001" value={settings.ronin_sell_multiplier} onChange={(event) => setSettings({ ...settings, ronin_sell_multiplier: event.target.value })} /></label><label>Transaction cap enabled<input type="checkbox" checked={Boolean(settings.transaction_points_cap_enabled)} onChange={(event) => setSettings({ ...settings, transaction_points_cap_enabled: event.target.checked })} /></label><label>Transaction points cap<input type="number" min="0" value={settings.transaction_points_cap || ''} onChange={(event) => setSettings({ ...settings, transaction_points_cap: event.target.value })} /></label></div><Button icon="save" onClick={saveSettings}>Save settings</Button></div>
      <div className="surface-card admin-panel"><SectionHeading eyebrow="Rewards" title="SOL rewards configuration." text="Toggle SOL rewards on/off and configure the points-to-SOL conversion rate. The on-chain Solana program pays out actual SOL when a user claims; the conversion rate is recorded with each claim." /><div className="admin-form-grid"><label>SOL rewards enabled<input type="checkbox" checked={Boolean(settings.sol_rewards_enabled)} onChange={(event) => setSettings({ ...settings, sol_rewards_enabled: event.target.checked })} /></label><label>Reward asset<input type="text" value={settings.reward_asset || 'SOL'} onChange={(event) => setSettings({ ...settings, reward_asset: event.target.value })} placeholder="SOL" /></label><label>Points per {settings.reward_asset || 'SOL'}<input type="number" min="1" step="1" value={settings.reward_points_per_unit || 1000} onChange={(event) => setSettings({ ...settings, reward_points_per_unit: event.target.value })} /></label></div><Button icon="save" onClick={saveSettings}>Save rewards settings</Button></div>
        </>
      )}
      <div className="surface-card admin-panel admin-campaigns-panel">
        <SectionHeading eyebrow={adminView === 'history' ? 'Campaign history' : 'Active campaigns'} title={adminView === 'history' ? 'Manage non-active campaigns.' : 'Manage active campaigns.'} text="Promo multipliers apply after the configured source multiplier. Eligibility is rechecked against each verified transaction." />
        {campaignEntriesToManage.map(({ campaign, index }) => (
          <fieldset id={`campaign-${campaign.id}`} key={campaign.id || index} className="admin-form-grid admin-campaign-card">
            <legend>{campaign.name || campaign.id || `Campaign ${index + 1}`} <Tag tone={getAdminCampaignStatus(campaign, currentTime) === 'ACTIVE' ? 'green' : 'neutral'}>{getAdminCampaignStatus(campaign, currentTime)}</Tag></legend>
            <label>Campaign ID<input required maxLength="80" value={campaign.id || ''} onChange={(event) => updateCampaign(index, 'id', event.target.value)} /></label>
            <label>Campaign Name<input maxLength="120" value={campaign.name || ''} onChange={(event) => updateCampaign(index, 'name', event.target.value)} /></label>
            <label>Promo Code<input maxLength="64" value={campaign.promoCode ?? campaign.promo_code ?? ''} onChange={(event) => updateCampaign(index, 'promoCode', event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))} /></label>
            <label className="admin-campaign-enabled">Campaign enabled<input type="checkbox" checked={campaign.enabled !== false} onChange={(event) => updateCampaign(index, 'enabled', event.target.checked)} /></label>
            <label>Start Date<input type="datetime-local" value={dateTimeLocal(campaign.startDate || campaign.start_at)} onChange={(event) => updateCampaign(index, 'startDate', event.target.value ? new Date(event.target.value).toISOString() : '')} /></label>
            <label>End Date<input type="datetime-local" value={dateTimeLocal(campaign.endDate || campaign.end_at)} onChange={(event) => updateCampaign(index, 'endDate', event.target.value ? new Date(event.target.value).toISOString() : '')} /></label>
            <label>Campaign Multiplier<input type="number" min={campaign.promoCode ? '1' : '0.000001'} step="0.000001" value={campaign.multiplier ?? 1} onChange={(event) => updateCampaign(index, 'multiplier', event.target.value)} /></label>
            <label>Source<select value={campaign.source || ''} onChange={(event) => updateCampaign(index, 'source', event.target.value)}><option value="">All sources</option><option value="SWAP">SWAP</option><option value="RONIN_BUY">RONIN_BUY</option><option value="RONIN_SELL">RONIN_SELL</option></select></label>
            <label>Direction<select value={campaign.direction || 'any'} onChange={(event) => updateCampaign(index, 'direction', event.target.value)}><option value="any">Either</option><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
            <label>Chain<select value={campaign.chainId ?? ''} onChange={(event) => {
              updateCampaign(index, 'chainId', event.target.value)
              updateCampaign(index, 'inputTokenMetadata', null)
              updateCampaign(index, 'outputTokenMetadata', null)
            }}><option value="">All chains</option>{campaignChainOptions.map((chain) => <option key={chain.id} value={chain.id}>{chain.name}</option>)}</select></label>
            <CampaignTokenField campaign={campaign} field="inputMint" chainId={campaign.chainId} updateCampaign={(key, value) => updateCampaign(index, key, value)} />
            <CampaignTokenField campaign={campaign} field="outputMint" chainId={campaign.chainId} updateCampaign={(key, value) => updateCampaign(index, key, value)} />
            <Button variant="outline" onClick={() => setSettings({ ...settings, campaigns: settings.campaigns.filter((_, itemIndex) => itemIndex !== index) })}>Remove campaign</Button>
          </fieldset>
        ))}
        {campaignEntriesToManage.length === 0 && <p>{adminView === 'history' ? 'No campaigns match the selected history filters.' : 'There are no currently active campaigns.'}</p>}
        <div className="admin-toolbar admin-campaign-actions"><Button variant="outline" onClick={() => addCampaign(adminView !== 'history')}>Add campaign</Button><Button icon="save" onClick={saveSettings}>Save campaigns</Button></div>
      </div>
    </section>
    {adminView === 'active' && (
      <>
    <section className="surface-card admin-panel"><SectionHeading eyebrow="Review" title="Leaderboard and activity." /><div className="admin-toolbar"><select value={period} onChange={(event) => setPeriod(event.target.value)}>{['daily', 'weekly', 'monthly', 'season', 'all-time'].map((item) => <option key={item}>{item}</option>)}</select><Button icon="refresh" onClick={loadLeaderboard}>Load leaderboard</Button></div><div className="admin-table-wrap"><table><thead><tr><th>Rank</th><th>Wallet</th><th>Volume</th><th>Points</th><th>Swaps</th></tr></thead><tbody>{(data?.leaderboard || []).map((row) => <tr key={row.wallet || row.rank}><td>{row.rank}</td><td>{row.wallet}</td><td>{row.verified_volume}</td><td>{row.samurai_points}</td><td>{row.qualifying_swaps}</td></tr>)}</tbody></table></div></section>
    <section className="admin-grid"><div className="surface-card admin-panel"><SectionHeading eyebrow="Wallet review" title="Inspect wallet." /><div className="admin-toolbar"><input value={walletQuery} onChange={(event) => setWalletQuery(event.target.value)} placeholder="Wallet address (Solana or EVM)" /><Button icon="search" onClick={searchWallet}>Search</Button></div>{walletResult?.wallet && <><div className="admin-toolbar"><Button variant="outline" icon="flag" onClick={() => reviewAction('flag', { wallet: walletResult.wallet.wallet_address })}>Flag</Button><Button variant="outline" icon="slash" onClick={() => reviewAction('exclude', { wallet: walletResult.wallet.wallet_address })}>Exclude</Button><Button variant="outline" icon="refresh" onClick={() => reviewAction('restore', { wallet: walletResult.wallet.wallet_address })}>Restore</Button><Button variant="outline" icon="fileText" onClick={() => addNote({ wallet: walletResult.wallet.wallet_address })}>Add note</Button></div><pre>{JSON.stringify(walletResult, null, 2)}</pre></>}</div><div className="surface-card admin-panel"><SectionHeading eyebrow="Transaction review" title="Inspect transaction." /><div className="admin-toolbar"><input value={signature} onChange={(event) => setSignature(event.target.value)} placeholder="Transaction hash or signature" /><Button icon="search" onClick={searchTransaction}>Search</Button></div>{transaction && <><div className="admin-toolbar"><Button variant="outline" icon="flag" onClick={() => reviewAction('flag', { signature })}>Flag</Button><Button variant="outline" icon="slash" onClick={() => reviewAction('exclude', { signature })}>Exclude</Button><Button variant="outline" icon="refresh" onClick={() => reviewAction('restore', { signature })}>Restore</Button><Button variant="outline" icon="fileText" onClick={() => addNote({ signature })}>Add note</Button></div><pre>{JSON.stringify(transaction, null, 2)}</pre></>}</div></section>
    <AdminRewardsPanel />
      </>
    )}
    {adminView === 'history' && (
      <>
    <section className="surface-card admin-panel admin-seasons-panel">
      <SectionHeading eyebrow="Seasons" title="Lifecycle management." text="Create draft seasons and manage their lifecycle. Only one season can be active at a time." />
      <div className="admin-form-grid admin-season-create-grid">
        <label>Season ID<input value={seasonDraft.id} onChange={(event) => setSeasonDraft({ ...seasonDraft, id: event.target.value })} placeholder="season-2026-01" /></label>
        <label>Season name<input value={seasonDraft.name} onChange={(event) => setSeasonDraft({ ...seasonDraft, name: event.target.value })} placeholder="Season 1" /></label>
        <label>Start date and time<input type="datetime-local" value={seasonDraft.startAt} onChange={(event) => setSeasonDraft({ ...seasonDraft, startAt: event.target.value })} /></label>
        <label>End date and time<input type="datetime-local" value={seasonDraft.endAt} onChange={(event) => setSeasonDraft({ ...seasonDraft, endAt: event.target.value })} /></label>
        <label>Minimum qualifying swap (USD)<input type="number" min="0" step="0.000001" value={seasonDraft.minimumQualifyingVolume} onChange={(event) => setSeasonDraft({ ...seasonDraft, minimumQualifyingVolume: event.target.value })} /></label>
        <label>SOL reward pool (optional)<input type="number" min="0.000000001" step="0.000000001" value={seasonDraft.rewardPoolAmount} onChange={(event) => setSeasonDraft({ ...seasonDraft, rewardPoolAmount: event.target.value })} placeholder="100" /></label>
        <label>Reward claim window starts<input type="datetime-local" value={seasonDraft.claimWindowStart} onChange={(event) => setSeasonDraft({ ...seasonDraft, claimWindowStart: event.target.value })} /></label>
        <label>Reward claim window ends<input type="datetime-local" value={seasonDraft.claimWindowEnd} onChange={(event) => setSeasonDraft({ ...seasonDraft, claimWindowEnd: event.target.value })} /></label>
      </div>
      <div className="admin-season-create-action"><Button icon="save" onClick={createSeasonRecord}>Create draft season</Button></div>
      <div className="admin-season-list">
        {filteredSeasons.map((season) => (
          <div id={`season-${season.id}`} className="admin-season-row admin-season-card" key={season.id}>
            <strong>{season.name} <span>({season.id})</span></strong>
            <Tag tone={season.status === 'ACTIVE' ? 'green' : 'neutral'}>{season.status}</Tag>
            <span>{new Date(season.start_at).toLocaleString()} – {new Date(season.end_at).toLocaleString()}</span>
            {['ACTIVE', 'DRAFT'].includes(season.status) && (
              <div className="admin-form-grid">
                <label>Minimum qualifying swap (USD)
                  <input
                    type="number"
                    min="0"
                    step="0.000001"
                    value={seasonMinimumDrafts[season.id] ?? String(season.minimum_qualifying_volume ?? 10)}
                    onChange={(event) => setSeasonMinimumDrafts((current) => ({ ...current, [season.id]: event.target.value }))}
                  />
                </label>
                <Button variant="outline" icon="save" onClick={() => updateSeasonMinimum(season)}>Save season minimum</Button>
              </div>
            )}
            {season.reward_pool_status !== 'UNCONFIGURED' && <span>SOL pool: {season.reward_pool_amount} SOL · {season.reward_pool_status}</span>}
            {season.reward_pool_status === 'FINALIZED' && <span>{Number(season.total_eligible_points || 0).toLocaleString()} eligible points · {Number(season.eligible_wallet_count || 0).toLocaleString()} wallets · Finalized {new Date(season.reward_finalized_at).toLocaleString()}</span>}
            {season.reward_pool_status === 'FINALIZED' && season.allocation_version != null && <span>Reward allocation version {season.allocation_version}</span>}
            {season.reward_pool_status === 'FINALIZED' && <span>Claim window ends {new Date(season.claim_window_end).toLocaleString()}</span>}
            {season.reward_pool_status === 'FINALIZED' && (
              <div className="admin-season-claim-report">
                <Button variant="outline" icon="search" onClick={() => loadSeasonClaimReport(season)}>
                  {seasonClaimReports[season.id] ? 'Refresh claim report' : 'Load claim report'}
                </Button>
                {seasonClaimReports[season.id] && (() => {
                  const report = seasonClaimReports[season.id]
                  const totals = report.totals
                  return (
                    <>
                      <p>Allocation version {report.allocationVersion}: {totals.claimedWallets} of {totals.allocatedWallets} wallets claimed ({totals.claimedSol.toLocaleString(undefined, { maximumFractionDigits: 9 })} / {totals.allocatedSol.toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL allocated).</p>
                      <p>{totals.pendingWallets} pending ({totals.pendingSol.toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL); {totals.remainingWallets} remaining/unclaimed ({totals.remainingSol.toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL).</p>
                      {totals.remainingWallets > 0 && (
                        <div className="admin-table-wrap">
                          <table>
                            <thead><tr><th>Wallet</th><th>Eligible points</th><th>Allocated SOL</th><th>Claim status</th></tr></thead>
                            <tbody>{report.wallets.filter((wallet) => !['COMPLETED', 'ENTITLED', 'PENDING_PAYOUT'].includes(wallet.claimStatus)).map((wallet) => (
                              <tr key={wallet.walletAddress}>
                                <td>{wallet.walletAddress}</td>
                                <td>{wallet.eligiblePoints.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                                <td>{wallet.rewardAmount.toLocaleString(undefined, { maximumFractionDigits: 9 })}</td>
                                <td>{wallet.claimStatus}</td>
                              </tr>
                            ))}</tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>
            )}
            <div className="admin-season-actions">
              {season.status === 'DRAFT' && <Button variant="outline" icon="check" onClick={() => seasonAction(season.id, 'activate')}>Activate</Button>}
              {season.status === 'ACTIVE' && <Button variant="outline" icon="close" onClick={() => seasonAction(season.id, 'end')}>End</Button>}
              {season.status === 'ENDED' && <Button variant="outline" icon="lock" onClick={() => seasonAction(season.id, 'freeze')}>Freeze</Button>}
              {season.reward_pool_status === 'CONFIGURED' && season.status === 'FROZEN' && <Button variant="outline" icon="check" onClick={() => seasonAction(season.id, 'finalize_rewards')}>Finalize rewards</Button>}
              {season.status === 'FROZEN' && <Button variant="outline" icon="scroll" onClick={() => seasonAction(season.id, 'archive')}>Archive</Button>}
              {season.status === 'ARCHIVED' && <Button variant="outline" icon="refresh" onClick={() => seasonAction(season.id, 'unarchive')}>Unarchive</Button>}
            </div>
            {season.reward_pool_status === 'FINALIZED' && ['ENDED', 'FROZEN', 'ARCHIVED'].includes(season.status) && (
              <div className="admin-form-grid">
                <label>Restart earning until
                  <input
                    type="datetime-local"
                    min={dateTimeLocal(new Date().toISOString())}
                    value={seasonRestartDrafts[season.id]?.endAt || ''}
                    onChange={(event) => setSeasonRestartDrafts((current) => ({
                      ...current,
                      [season.id]: { ...current[season.id], endAt: event.target.value },
                    }))}
                  />
                </label>
                <label>Next claim window starts
                  <input
                    type="datetime-local"
                    min={dateTimeLocal(seasonRestartDrafts[season.id]?.endAt)}
                    value={seasonRestartDrafts[season.id]?.claimWindowStart || ''}
                    onChange={(event) => setSeasonRestartDrafts((current) => ({
                      ...current,
                      [season.id]: { ...current[season.id], claimWindowStart: event.target.value },
                    }))}
                  />
                </label>
                <label>Next claim window ends
                  <input
                    type="datetime-local"
                    min={dateTimeLocal(seasonRestartDrafts[season.id]?.claimWindowStart)}
                    value={seasonRestartDrafts[season.id]?.claimWindowEnd || ''}
                    onChange={(event) => setSeasonRestartDrafts((current) => ({
                      ...current,
                      [season.id]: { ...current[season.id], claimWindowEnd: event.target.value },
                    }))}
                  />
                </label>
                <Button
                  variant="outline"
                  icon="refresh"
                  disabled={!seasonRestartDrafts[season.id]?.endAt
                    || !seasonRestartDrafts[season.id]?.claimWindowStart
                    || !seasonRestartDrafts[season.id]?.claimWindowEnd}
                  onClick={() => restartFinalizedSeason(season)}
                >
                  Restart season with new reward version
                </Button>
              </div>
            )}
            {season.reward_pool_status === 'FINALIZED' && (
              <div className="admin-form-grid">
                <label>New claim deadline (must be later)
                  <input
                    type="datetime-local"
                    min={dateTimeLocal(new Date().toISOString())}
                    value={seasonClaimDeadlineDrafts[season.id] || ''}
                    onChange={(event) => setSeasonClaimDeadlineDrafts({ ...seasonClaimDeadlineDrafts, [season.id]: event.target.value })}
                  />
                </label>
                <Button
                  variant="outline"
                  icon="refresh"
                  disabled={!seasonClaimDeadlineDrafts[season.id]}
                  onClick={() => extendSeasonClaimWindow(season)}
                >
                  Extend / reopen claim window
                </Button>
              </div>
            )}
            {season.status === 'DRAFT' && season.reward_pool_status === 'UNCONFIGURED' && (
              <div className="admin-form-grid">
                <label>SOL reward pool<input type="number" min="0.000000001" step="0.000000001" value={seasonRewardDrafts[season.id]?.amount || ''} onChange={(event) => setSeasonRewardDrafts({ ...seasonRewardDrafts, [season.id]: { ...seasonRewardDrafts[season.id], amount: event.target.value } })} /></label>
                <label>Claim window starts<input type="datetime-local" value={seasonRewardDrafts[season.id]?.claimWindowStart || ''} onChange={(event) => setSeasonRewardDrafts({ ...seasonRewardDrafts, [season.id]: { ...seasonRewardDrafts[season.id], claimWindowStart: event.target.value } })} /></label>
                <label>Claim window ends<input type="datetime-local" value={seasonRewardDrafts[season.id]?.claimWindowEnd || ''} onChange={(event) => setSeasonRewardDrafts({ ...seasonRewardDrafts, [season.id]: { ...seasonRewardDrafts[season.id], claimWindowEnd: event.target.value } })} /></label>
                <Button variant="outline" icon="save" onClick={() => configureSeasonRewards(season)}>Configure SOL pool</Button>
              </div>
            )}
          </div>
        ))}
        {filteredSeasons.length === 0 && <p>{allSeasons.length === 0 ? 'No seasons have been created.' : 'No seasons match the selected history filters.'}</p>}
      </div>
    </section>
    <section className="surface-card admin-panel admin-disabled-controls"><div><Eyebrow>On-chain payouts</Eyebrow><h2>SOL payouts are server-controlled.</h2><p>SOL rewards are {settings.sol_rewards_enabled ? 'ENABLED — users can claim from the Profile page' : 'currently OFF'} and platform fees are {settings.platform_fee_enabled ? 'enabled by configuration' : 'OFF'}. The backend signs the on-chain payout transaction with the admin keypair configured via SOLANA_REWARDS_ADMIN_KEYPAIR / SOLANA_REWARDS_ADMIN_SECRET_KEY; no private key is exposed to the browser.</p></div><Tag tone={settings.sol_rewards_enabled ? 'green' : 'neutral'}>{settings.sol_rewards_enabled ? 'REWARDS LIVE' : 'SERVER CONTROLLED'}</Tag></section>
      </>
    )}
  </main>
}