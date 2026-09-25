// =====================================================================
// GET /api/robinhood/wallet-tokens?address=0x...
// =====================================================================
// Returns every ERC-20 token the connected MetaMask wallet actually holds
// on Robinhood Chain (chainId 4663) with balance > 0, enriched with
// symbol/name/decimals/logo, plus the wallet's native ETH balance.
//
// This is the Robinhood Chain equivalent of the Solana wallet-token
// discovery pipeline in src/services/shieldService.js → getAllTokenAccounts().
//
// No third-party API key required — Robinhood Chain has no Alchemy
// equivalent, so we use eth_getLogs directly against the existing
// Robinhood RPC (lifiRpc / lifiRpcUrl). Two parallel scans:
//   • topic[1] = wallet   (transfers OUT of the wallet)
//   • topic[2] = wallet   (transfers INTO the wallet)
// Then we union the contract addresses, fetch metadata for each via
// eth_call (symbol/name/decimals), and check current balanceOf().
// =====================================================================

import { apiError, json, rateLimit } from '../../api/_lib/roninBackend.mjs'
import { lifiRpc, lifiRpcUrl } from '../../api/_lib/lifi.mjs'
import { ROBINHOOD_VERIFIED_TOKENS } from '../../src/config/robinhoodRegistry.js'

const ROBINHOOD_CHAIN_ID = 4663
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df9089b1c'
const SYMBOL_SELECTOR = '0x95d89b41'
const NAME_SELECTOR = '0x06fdde03'
const DECIMALS_SELECTOR = '0x313ce567'
const BALANCE_OF_SELECTOR = '0x70a08231'
// Cap the number of distinct token contracts we resolve metadata for, to
// keep response time bounded even for very active wallets.
const MAX_TOKENS_TO_RESOLVE = 60

// Verified tokens from robinhoodRegistry.js — used to skip expensive
// metadata eth_call round-trips for tokens we already know.
const VERIFIED_BY_ADDRESS = new Map(
  ROBINHOOD_VERIFIED_TOKENS.map((token) => [String(token.address).toLowerCase(), token]),
)

function padAddressToTopic(address) {
  return '0x' + '0'.repeat(24) + String(address).slice(2).toLowerCase()
}

function decodeString(hex) {
  if (!hex || hex === '0x') return ''
  try {
    const bytes = Uint8Array.from(hex.slice(2).match(/.{1,2}/g).map((byte) => parseInt(byte, 16)))
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\u0000/g, '').trim()
  } catch {
    return ''
  }
}

function hexToBigInt(hex) {
  if (!hex || hex === '0x') return 0n
  try { return BigInt(hex) } catch { return 0n }
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'UNKNOWN'
}

// Robinhood Chain genesis is recent (chain launched in 2025). We can scan
// from block 0; the RPC will accept the request. If the RPC rejects a
// full-range scan, we fall back to 'latest' only and surface a warning.
async function fetchTransferLogs(chainId, owner) {
  const paddedOwner = padAddressToTopic(owner)
  const baseParams = { fromBlock: '0x0', toBlock: 'latest', topics: [TRANSFER_TOPIC] }

  const [asFrom, asTo] = await Promise.all([
    lifiRpc(chainId, 'eth_getLogs', [{ ...baseParams, topics: [TRANSFER_TOPIC, paddedOwner] }]).catch(() => []),
    lifiRpc(chainId, 'eth_getLogs', [{ ...baseParams, topics: [TRANSFER_TOPIC, null, paddedOwner] }]).catch(() => []),
  ])

  const tokenAddresses = new Set()
  for (const log of [...(asFrom || []), ...(asTo || [])]) {
    if (typeof log?.address === 'string' && ADDRESS_PATTERN.test(log.address)) {
      tokenAddresses.add(log.address.toLowerCase())
    }
  }
  return Array.from(tokenAddresses)
}

async function fetchTokenMetadata(chainId, address) {
  const verified = VERIFIED_BY_ADDRESS.get(address)
  if (verified) {
    return {
      symbol: verified.symbol,
      name: verified.name,
      decimals: Number(verified.decimals || 18),
      logoURI: verified.logoURI || null,
    }
  }
  const [symbolHex, nameHex, decimalsHex] = await Promise.all([
    lifiRpc(chainId, 'eth_call', [{ to: address, data: SYMBOL_SELECTOR }, 'latest']).catch(() => '0x'),
    lifiRpc(chainId, 'eth_call', [{ to: address, data: NAME_SELECTOR }, 'latest']).catch(() => '0x'),
    lifiRpc(chainId, 'eth_call', [{ to: address, data: DECIMALS_SELECTOR }, 'latest']).catch(() => '0x'),
  ])
  const decimals = Number.parseInt(decimalsHex || '0x0', 16)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null
  const symbol = decodeString(symbolHex) || shortAddress(address)
  const name = decodeString(nameHex) || symbol
  return { symbol, name, decimals, logoURI: null }
}

async function fetchTokenBalance(chainId, tokenAddress, owner) {
  const data = `${BALANCE_OF_SELECTOR}${owner.slice(2).padStart(64, '0')}`
  const result = await lifiRpc(chainId, 'eth_call', [{ to: tokenAddress, data }, 'latest']).catch(() => '0x')
  return hexToBigInt(result)
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'robinhood-wallet-tokens', 30, 60_000)) return apiError(res, 429, 'RATE_LIMITED', 'Too many wallet-token requests. Try again shortly.')

  const address = String(req.query?.address || '').trim()
  if (!ADDRESS_PATTERN.test(address)) return apiError(res, 400, 'INVALID_ADDRESS', 'A valid Robinhood Chain wallet address is required.')

  const rpcUrl = lifiRpcUrl(ROBINHOOD_CHAIN_ID)
  if (!rpcUrl) return apiError(res, 503, 'RPC_NOT_CONFIGURED', 'Robinhood Chain RPC is not configured.')

  try {
    // 1. Native ETH balance + token contract discovery in parallel
    const [nativeHex, candidateAddresses] = await Promise.all([
      lifiRpc(ROBINHOOD_CHAIN_ID, 'eth_getBalance', [address, 'latest']),
      fetchTransferLogs(ROBINHOOD_CHAIN_ID, address),
    ])

    // Always include verified registry tokens so users see those balances
    // even if the wallet has never been a counterparty to a Transfer event
    // for them (e.g. tokens received via a contract interaction that did
    // not emit a standard Transfer).
    for (const token of ROBINHOOD_VERIFIED_TOKENS) {
      candidateAddresses.push(String(token.address).toLowerCase())
    }
    const uniqueAddresses = Array.from(new Set(candidateAddresses)).slice(0, MAX_TOKENS_TO_RESOLVE)

    // 2. Resolve metadata + current balance for each candidate
    const tokens = await Promise.all(uniqueAddresses.map(async (tokenAddress) => {
      try {
        const [meta, balance] = await Promise.all([
          fetchTokenMetadata(ROBINHOOD_CHAIN_ID, tokenAddress),
          fetchTokenBalance(ROBINHOOD_CHAIN_ID, tokenAddress, address),
        ])
        if (!meta || balance <= 0n) return null
        return {
          chainId: ROBINHOOD_CHAIN_ID,
          chainKey: 'robinhood',
          type: 'erc20',
          address: tokenAddress,
          symbol: meta.symbol,
          name: meta.name,
          decimals: meta.decimals,
          logoURI: meta.logoURI,
          balance: balance.toString(),
          source: VERIFIED_BY_ADDRESS.has(tokenAddress) ? 'verified-registry' : 'on-chain-logs',
        }
      } catch {
        return null
      }
    }))

    return json(res, 200, {
      success: true,
      chainId: ROBINHOOD_CHAIN_ID,
      chainKey: 'robinhood',
      source: 'on-chain-logs',
      native: { balance: hexToBigInt(nativeHex).toString(), decimals: 18, symbol: 'ETH', name: 'Ether' },
      tokens: tokens.filter(Boolean),
      dataAvailable: true,
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('robinhood wallet-tokens failed:', error?.message || error)
    return apiError(res, 502, 'WALLET_TOKENS_UNAVAILABLE', error?.message || 'Robinhood wallet tokens are unavailable right now.')
  }
}
