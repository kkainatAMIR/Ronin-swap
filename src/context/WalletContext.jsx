import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { PublicKey } from '@solana/web3.js'
import { demoProfile } from '../data'
import { getRoninBalance, getRoninSupply, getLiveRoninStats } from '../services/roninService'

const WalletContext = createContext(null)

// localStorage key for the user's known EVM wallet addresses (Ethereum
// Mainnet + Robinhood Chain — both use the same MetaMask account but are
// tracked separately per-chain on the backend). The Profile page reads
// this list to aggregate samurai points across ALL of the user's
// connected wallets, not just the Phantom (Solana) one.
//
// Without this, a user who swaps on Ethereum with MetaMask sees 0 points
// on their profile page (which only queries the Phantom address).
const EVM_WALLETS_STORAGE_KEY = 'ronin.evmWallets.v1'
const EVM_WALLETS_MAX = 10  // safety cap

function readStoredEvmWallets() {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(EVM_WALLETS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Validate each entry is a 0x... 40-hex address
    return parsed.filter((addr) => typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr)).slice(0, EVM_WALLETS_MAX)
  } catch {
    return []
  }
}

function writeStoredEvmWallets(addresses) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(EVM_WALLETS_STORAGE_KEY, JSON.stringify(addresses.slice(0, EVM_WALLETS_MAX)))
  } catch {
    // localStorage may be unavailable (private mode) — silently fail.
  }
}

const shortAddress = (address = '') => {
  if (address.length <= 12) return address
  return `${address.slice(0, 4)}...${address.slice(-4)}`
}

function isRealSolanaWalletAddress(address) {
  try {
    const publicKey = new PublicKey(address)
    return PublicKey.isOnCurve(publicKey.toBytes())
  } catch {
    return false
  }
}

export const getSolanaProvider = () => {
  if (typeof window === 'undefined') return null;
  // Standard Phantom detection
  if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
  // Fallback for older Phantom or other compliant wallets
  if (window.solana?.isPhantom) return window.solana;
  // Generic solana provider
  return window.solana || null;
}

export function WalletProvider({ children }) {
  const [wallet, setWallet] = useState(null)
  const [profile, setProfile] = useState(null)
  const [connectionState, setConnectionState] = useState('idle')
  const [walletDataState, setWalletDataState] = useState('idle')
  const [walletDataError, setWalletDataError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(null)
  const [tokenSupply, setTokenSupply] = useState(null)
  // EVM wallets (MetaMask) the user has ever connected on any swap tab.
  // These are tracked separately from the Phantom (Solana) wallet
  // because the backend's samurai_points table is keyed on wallet_address
  // — a Solana address and a MetaMask address are different rows even
  // if they belong to the same user.
  const [evmWallets, setEvmWallets] = useState(readStoredEvmWallets)
  const [tokenSupplyState, setTokenSupplyState] = useState('loading')
  const [liveStats, setLiveStats] = useState(null)
  const [liveStatsState, setLiveStatsState] = useState('loading')
  const [error, setError] = useState('')
  const [walletModalOpen, setWalletModalOpen] = useState(false)
  const [buyModalOpen, setBuyModalOpen] = useState(false)
  const [notice, setNotice] = useState('')

  const hasSolanaProvider = Boolean(getSolanaProvider())
  const isMobileDevice = useMemo(() => typeof window !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent), [])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 4200)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    let cancelled = false
    getRoninSupply()
      .then((supply) => {
        if (!cancelled) {
          setTokenSupply(supply)
          setTokenSupplyState('ready')
        }
      })
      .catch(() => {
        if (!cancelled) setTokenSupplyState('error')
      })
    return () => { cancelled = true }
  }, [])

  // Live stats come from one backend response shared by Home and Dashboard.
  // In particular, `burned` is global on-chain data and is never derived from
  // the connected wallet. Poll every 30 seconds so burns made elsewhere
  // eventually appear here too.
  useEffect(() => {
    let cancelled = false
    async function fetchLive() {
      setLiveStatsState('loading')
      try {
        const stats = await getLiveRoninStats()
        if (!cancelled) {
          setLiveStats(stats)
          if (stats?.supply) {
            setTokenSupply(stats.supply)
            setTokenSupplyState('ready')
          }
          setLiveStatsState('ready')
        }
      } catch (statsError) {
        console.warn('global live stats fetch failed', statsError)
        if (!cancelled) {
          // Clear the last response instead of leaving stale/partial burn data
          // looking current. The UI will show its loading/error state.
          setLiveStats(null)
          setLiveStatsState('error')
        }
      }
    }
    fetchLive()
    const interval = window.setInterval(fetchLive, 30_000) // refresh every 30s
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [])

  const refreshWalletData = useCallback(async (address) => {
    if (!address) return
    setWalletDataState('loading')
    setWalletDataError('')
    try {
      const tokenBalance = await getRoninBalance(address)
      setProfile((current) => ({
        ...(current || {}),
        balance: tokenBalance.amount,
        rawBalance: tokenBalance.rawAmount,
        decimals: tokenBalance.decimals,
        nfts: null,
        level: null,
        xp: null,
        yieldLocked: null,
        balanceSource: tokenBalance.source,
        lastUpdated: tokenBalance.updatedAt,
        isLive: true,
      }))
      setLastUpdated(tokenBalance.updatedAt)
      setWalletDataState('ready')
    } catch (dataError) {
      setWalletDataState('error')
      setWalletDataError(dataError?.message || 'The live $RONIN balance could not be read.')
    }
  }, [])

  useEffect(() => {
    if (!wallet || wallet.isDemo) return undefined
    refreshWalletData(wallet.address)
    const interval = window.setInterval(() => refreshWalletData(wallet.address), 30_000)
    return () => window.clearInterval(interval)
  }, [wallet?.address, wallet?.isDemo, refreshWalletData])

  useEffect(() => {
    const provider = getSolanaProvider()
    if (!provider) return undefined

    const adoptConnectedAccount = (publicKey) => {
      const address = publicKey?.toString?.() || publicKey
      if (!address) {
        setWallet(null)
        setProfile(null)
        setWalletDataState('idle')
        setConnectionState('idle')
        return
      }
      if (!isRealSolanaWalletAddress(address)) {
        setWallet(null)
        setProfile(null)
        setConnectionState('error')
        setError('The connected wallet returned an invalid off-curve address. Disconnect and reconnect Phantom.')
        return
      }
      setWallet({ address, shortAddress: shortAddress(address), provider: 'Solana wallet', isDemo: false })
      setProfile(null)
      setWalletDataState('loading')
      setWalletDataError('')
      setLastUpdated(null)
      setConnectionState('connected')
    }

    const handleDisconnect = () => adoptConnectedAccount(null)
    if (provider.isConnected && provider.publicKey) {
      adoptConnectedAccount(provider.publicKey)
    } else {
      provider.connect({ onlyIfTrusted: true })
        .then((res) => { if (res.publicKey) adoptConnectedAccount(res.publicKey) })
        .catch(() => {})
    }
    provider.on?.('accountChanged', adoptConnectedAccount)
    provider.on?.('disconnect', handleDisconnect)

    return () => {
      const removeListener = provider.removeListener || provider.off
      removeListener?.call(provider, 'accountChanged', adoptConnectedAccount)
      removeListener?.call(provider, 'disconnect', handleDisconnect)
    }
  }, [])

  const connectDemo = () => {
    setError('')
    setWallet({
      address: '7A3fKQ9dM2vR8xT1pL0sN4cF6bY0F4',
      shortAddress: '7A3f...0F4',
      provider: 'Demo profile',
      isDemo: true,
    })
    setProfile({ ...demoProfile, isLive: false, balanceSource: 'Demo fallback' })
    setWalletDataState('ready')
    setWalletDataError('')
    setLastUpdated(Date.now())
    setConnectionState('connected')
    setWalletModalOpen(false)
    setNotice('Demo profile connected. Live wallet reads are clearly marked throughout the app.')
  }

  const connectWallet = async () => {
    setError('')
    setConnectionState('connecting')
    try {
      const provider = getSolanaProvider()
      if (!provider) {
        if (isMobileDevice) {
          const url = window.location.href;
          const ref = window.location.origin;
          window.location.href = `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;
          setConnectionState('idle');
          return;
        }
        throw new Error('No Solana wallet was detected in this browser.')
      }
      const response = await provider.connect()
      const address = response?.publicKey?.toString?.() || response?.publicKey
      if (!address) throw new Error('The wallet did not return a public key.')
      if (!isRealSolanaWalletAddress(address)) throw new Error('The wallet returned an invalid off-curve address. Disconnect and reconnect Phantom.')
      setWallet({ address, shortAddress: shortAddress(address), provider: 'Solana wallet', isDemo: false })
      setProfile(null)
      setWalletDataState('loading')
      setWalletDataError('')
      setLastUpdated(null)
      setConnectionState('connected')
      setWalletModalOpen(false)
      setNotice('Wallet connected. Fetching your live $RONIN balance from Solana mainnet…')
    } catch (connectError) {
      setConnectionState('error')
      setError(connectError?.message || 'The wallet could not be connected.')
    }
  }

  const disconnect = () => {
    try {
      if (wallet && !wallet.isDemo) getSolanaProvider()?.disconnect?.()
    } catch {
      // State is still cleared if a provider does not expose disconnect().
    }
    setWallet(null)
    setProfile(null)
    setWalletDataState('idle')
    setWalletDataError('')
    setLastUpdated(null)
    setConnectionState('idle')
    setError('')
    setNotice('Wallet disconnected.')
  }

  // ---- EVM (MetaMask) wallet tracking ----
  //
  // The Swap page's Ethereum and Robinhood panels call addEvmWallet(address)
  // whenever the user connects MetaMask. We persist the address to
  // localStorage so the Profile page can read it on subsequent loads even
  // if the user hasn't reconnected MetaMask yet — points earned by an
  // EVM wallet are forever tied to that address, so we need to remember it.
  const addEvmWallet = useCallback((address) => {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return
    const normalized = address.toLowerCase()
    setEvmWallets((current) => {
      if (current.includes(normalized)) return current  // already tracked
      const next = [...current, normalized]
      writeStoredEvmWallets(next)
      return next
    })
  }, [])

  // Removes an EVM wallet from the tracked list + localStorage.
  // Called when the user explicitly disconnects MetaMask from the
  // Ethereum or Robinhood swap panels.
  const removeEvmWallet = useCallback((address) => {
    if (!address) return
    const normalized = address.toLowerCase()
    setEvmWallets((current) => {
      const next = current.filter((addr) => addr !== normalized)
      writeStoredEvmWallets(next)
      return next
    })
  }, [])

  // Auto-detect a previously-authorized MetaMask account on mount.
  // This makes the EVM wallet available to the Profile page without
  // requiring the user to click CONNECT on the swap tab first.
  // Uses eth_accounts (silent, no popup) — only requests accounts if
  // the user has previously authorized this dapp.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const injected = window.ethereum
    if (!injected) return undefined
    // Find the MetaMask provider (skip Phantom, which also injects window.ethereum)
    const providers = Array.isArray(injected?.providers) ? injected.providers : []
    const metaMask = providers.find((p) => p?.isMetaMask && !p?.isPhantom)
      || (injected?.isMetaMask && !injected?.isPhantom ? injected : null)
    if (!metaMask) return undefined

    let cancelled = false
    metaMask.request({ method: 'eth_accounts' })
      .then((accounts) => {
        if (cancelled) return
        if (Array.isArray(accounts) && accounts[0]) {
          addEvmWallet(accounts[0])
        }
      })
      .catch(() => {
        // User hasn't authorized MetaMask yet — that's fine, the Swap
        // page will call addEvmWallet when they click CONNECT.
      })

    // Listen for account changes — if the user switches MetaMask account,
    // track the new one too (and keep the old one tracked, since its
    // historical points are still associated with that address).
    const handleAccountsChanged = (accounts) => {
      if (cancelled) return
      if (Array.isArray(accounts) && accounts[0]) {
        addEvmWallet(accounts[0])
      }
    }
    metaMask.on?.('accountsChanged', handleAccountsChanged)
    return () => {
      cancelled = true
      metaMask.removeListener?.('accountsChanged', handleAccountsChanged)
    }
  }, [addEvmWallet])

  const value = useMemo(() => ({
    wallet,
    profile,
    connectionState,
    walletDataState,
    walletDataError,
    lastUpdated,
    tokenSupply,
    tokenSupplyState,
    liveStats,
    liveStatsState,
    error,
    hasSolanaProvider,
    isMobileDevice,
    walletModalOpen,
    // EVM wallet tracking — used by the Profile page to aggregate
    // samurai points across ALL connected wallets (Phantom + MetaMask).
    evmWallets,
    addEvmWallet,
    removeEvmWallet,
    // Convenience: returns ALL known wallet addresses (Phantom + EVM)
    // for the current user. Used by the Profile page to fetch
    // aggregated stats. The Phantom address comes first if connected.
    allWalletAddresses: [
      ...(wallet?.address && !wallet.isDemo ? [wallet.address] : []),
      ...evmWallets,
    ],
    openWalletModal: () => { setError(''); setWalletModalOpen(true) },
    closeWalletModal: () => setWalletModalOpen(false),
    buyModalOpen,
    openBuyModal: () => setBuyModalOpen(true),
    closeBuyModal: () => setBuyModalOpen(false),
    connectDemo,
    connectWallet,
    refreshWalletData: () => wallet && !wallet.isDemo ? refreshWalletData(wallet.address) : undefined,
    refreshLiveStats: async () => {
      setLiveStatsState('loading')
      try {
        const stats = await getLiveRoninStats()
        setLiveStats(stats)
        if (stats.supply) {
          setTokenSupply(stats.supply)
          setTokenSupplyState('ready')
        }
        setLiveStatsState('ready')
      } catch (statsError) {
        console.warn('global live stats refresh failed', statsError)
        setLiveStats(null)
        setLiveStatsState('error')
      }
    },
    disconnect,
    notice,
  }), [wallet, profile, connectionState, walletDataState, walletDataError, lastUpdated, tokenSupply, tokenSupplyState, liveStats, liveStatsState, error, hasSolanaProvider, isMobileDevice, walletModalOpen, buyModalOpen, notice, refreshWalletData, evmWallets, addEvmWallet, removeEvmWallet])

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet() {
  const context = useContext(WalletContext)
  if (!context) throw new Error('useWallet must be used inside WalletProvider')
  return context
}
