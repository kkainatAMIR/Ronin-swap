import { ETHEREUM_CHAIN_ID } from '../config/ethereumRegistry'
import { CHAIN_IDS, getChain } from '../config/chains'

export function getEthereumProvider() {
  if (typeof window === 'undefined') return null
  const injected = window.ethereum
  const providers = Array.isArray(injected?.providers) ? injected.providers : []
  const metaMask = providers.find((provider) => provider?.isMetaMask && !provider?.isPhantom)
    || (injected?.isMetaMask && !injected?.isPhantom ? injected : null)
  return metaMask || null
}

function isMobileBrowser() {
  return typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
}

function openMetaMaskMobile() {
  if (typeof window === 'undefined') return false
  const currentPath = `${window.location.host}${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.href = `https://metamask.app.link/dapp/${currentPath}`
  return true
}

export async function connectEthereumWallet() {
  const provider = getEthereumProvider()
  if (!provider) {
    if (isMobileBrowser()) {
      openMetaMaskMobile()
      return null
    }
    throw new Error('MetaMask is not installed.')
  }
  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  if (!accounts?.[0]) throw new Error('MetaMask did not return an account.')
  await ensureEthereumMainnet(provider)
  return accounts[0]
}

export async function ensureEthereumMainnet(provider = getEthereumProvider()) {
  if (!provider) throw new Error('MetaMask is not installed.')
  const chainId = await provider.request({ method: 'eth_chainId' })
  if (chainId !== '0x1') {
    try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }) } catch (error) {
      if (error?.code === 4001) throw new Error('Ethereum Mainnet network switch was rejected.')
      throw new Error('Please switch MetaMask to Ethereum Mainnet.')
    }
  }
  const confirmed = await provider.request({ method: 'eth_chainId' })
  if (confirmed !== '0x1') throw new Error('Ethereum Mainnet is required for this swap.')
  return ETHEREUM_CHAIN_ID
}

export async function getEthereumQuote(request) {
  const response = await fetch('/api/evm/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.error || 'Ethereum quote unavailable.')
    error.code = body.code || `HTTP_${response.status}`
    throw error
  }
  return body
}

export async function getErc20Decimals(provider, address) {
  const result = await provider.request({ method: 'eth_call', params: [{ to: address, data: '0x313ce567' }, 'latest'] })
  const decimals = Number.parseInt(result, 16)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Ethereum token metadata is unavailable.')
  return decimals
}

export async function getEthereumTokenPrices(tokens) {
  const prices = new Map()
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')
    const body = await response.json()
    const price = Number(body?.ethereum?.usd)
    if (Number.isFinite(price)) prices.set('native', price)
  } catch {}

  await Promise.all(tokens.filter((token) => token.type === 'erc20').map(async (token) => {
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.address}`)
      const body = await response.json()
      const pair = body?.pairs?.find((item) => item?.chainId === 'ethereum' && Number.isFinite(Number(item?.priceUsd)))
      if (pair) prices.set(token.address, Number(pair.priceUsd))
    } catch {}
  }))
  return prices
}

export async function getEthereumTokenBalances(provider, owner, tokens) {
  const entries = await Promise.all(tokens.map(async (token) => {
    try {
      if (token.type === 'native') {
        const raw = await provider.request({ method: 'eth_getBalance', params: [owner, 'latest'] })
        return [token.address || 'native', { raw: BigInt(raw), decimals: 18 }]
      }
      const decimals = await getErc20Decimals(provider, token.address)
      const data = `0x70a08231${owner.slice(2).padStart(64, '0')}`
      const raw = await provider.request({ method: 'eth_call', params: [{ to: token.address, data }, 'latest'] })
      return [token.address, { raw: BigInt(raw), decimals }]
    } catch {
      return [token.address || 'native', { raw: 0n, decimals: token.type === 'native' ? 18 : 0 }]
    }
  }))
  return new Map(entries)
}

export function evmAmount(value, decimals) {
  const text = String(value || '').trim()
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > decimals) return null
  return `0x${(BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString(16)}`
}

export function formatEvmAmount(value, decimals) {
  const amount = BigInt(value)
  const scale = 10n ** BigInt(decimals)
  const fraction = amount % scale
  const fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${amount / scale}${fractionText ? `.${fractionText.slice(0, 8)}` : ''}`
}

export async function getEthereumChainId(provider = getEthereumProvider()) {
  if (!provider) throw new Error('MetaMask is not installed.')
  return Number.parseInt(await provider.request({ method: 'eth_chainId' }), 16)
}

export async function ensureRobinhoodChain(provider = getEthereumProvider()) {
  if (!provider) throw new Error('MetaMask is not installed.')
  const chain = getChain('robinhood')
  if (!chain.rpcUrl) throw new Error('Robinhood Chain RPC is not configured yet.')
  const chainId = `0x${Number(CHAIN_IDS.ROBINHOOD).toString(16)}`
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
  } catch (error) {
    if (error?.code === 4902) {
      await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: chain.configuredName, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [chain.rpcUrl], ...(chain.explorer ? { blockExplorerUrls: [chain.explorer] } : {}) }] })
    } else if (error?.code === 4001) {
      throw new Error('Robinhood Chain network switch was rejected.')
    } else {
      throw new Error('Please switch MetaMask to Robinhood Chain.')
    }
  }
  const confirmed = await getEthereumChainId(provider)
  if (confirmed !== CHAIN_IDS.ROBINHOOD) throw new Error('Robinhood Chain is required.')
  return confirmed
}

export async function connectRobinhoodWallet() {
  const provider = getEthereumProvider()
  if (!provider) {
    if (isMobileBrowser()) {
      openMetaMaskMobile()
      return null
    }
    throw new Error('MetaMask is not installed.')
  }
  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  if (!accounts?.[0]) throw new Error('MetaMask did not return an account.')
  await ensureRobinhoodChain(provider)
  return accounts[0]
}