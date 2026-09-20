import { apiError, json, rateLimit } from '../../api/_lib/roninBackend.mjs'
import { lifiRpc, lifiRpcUrl } from '../../api/_lib/lifi.mjs'
import { getRobinhoodMarketPairs, isMemeToken, pairActivity, rankingScore, tokenLogoUri } from '../../api/_lib/robinhoodMarket.mjs'
import { ROBINHOOD_TOKEN_CANDIDATES } from '../../src/config/robinhoodRegistry.js'

const CHAIN_ID = 4663
const MAX_LISTED = 60
const MAX_POPULAR = 12
const DECIMALS_SELECTOR = '0x313ce567'

function registryCandidates() {
  return ROBINHOOD_TOKEN_CANDIDATES.filter((token) => token.address && token.verification === 'verified' && token.productionEnabled)
}

async function validateToken(token) {
  const address = String(token.address || '').toLowerCase()
  if (!address) return null
  const code = await lifiRpc(CHAIN_ID, 'eth_getCode', [address, 'latest']).catch(() => '0x')
  if (!code || code === '0x') return null
  const decimalsRaw = await lifiRpc(CHAIN_ID, 'eth_call', [{ to: address, data: DECIMALS_SELECTOR }, 'latest']).catch(() => null)
  const decimals = Number.isInteger(Number.parseInt(decimalsRaw, 16)) ? Number.parseInt(decimalsRaw, 16) : Number(token.decimals ?? 0)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null
  return { ...token, decimals }
}

function toToken(token, pair) {
  const activity = pair ? pairActivity(pair) : null
  return {
    chainId: CHAIN_ID,
    chainKey: 'robinhood',
    type: 'erc20',
    address: token.address,
    symbol: token.symbol || 'UNKNOWN',
    name: token.name || token.symbol || 'Unknown token',
    decimals: Number(token.decimals),
    logoURI: tokenLogoUri(token, pair),
    categories: token.categories || [],
    isMeme: Boolean(token.isMeme || isMemeToken(token)),
    verification: token.verification,
    productionEnabled: Boolean(token.productionEnabled),
    hasMarket: Boolean(pair),
    activity,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'robinhood-tokens', 30, 60_000)) return apiError(res, 429, 'RATE_LIMITED', 'Token list is temporarily rate limited.')

  try {
    if (!lifiRpcUrl(CHAIN_ID)) {
      return json(res, 200, {
        success: false,
        chainId: CHAIN_ID,
        source: 'Robinhood registry',
        generatedAt: new Date().toISOString(),
        native: null,
        sections: { all: [], tokens: [], memes: [], popular: [], pop: [] },
        dataAvailable: false,
        warnings: ['Robinhood RPC is not configured.'],
      })
    }

    const candidates = registryCandidates()
    const validated = (await Promise.all(candidates.map((token) => validateToken(token)))).filter(Boolean)
    const pairsByAddress = await getRobinhoodMarketPairs(validated).catch(() => new Map())

    const native = {
      chainId: CHAIN_ID,
      chainKey: 'robinhood',
      type: 'native',
      address: null,
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      logoURI: null,
      isMeme: false,
      hasMarket: true,
      activity: null,
    }

    const all = validated
      .map((token) => toToken(token, pairsByAddress.get(String(token.address).toLowerCase())))
      .slice(0, MAX_LISTED)
    const tokens = all.filter((token) => !token.isMeme)
    const memes = all.filter((token) => token.isMeme)
    const popular = all
      .filter((token) => token.hasMarket && token.activity?.liquidityUsd > 0)
      .sort((left, right) => rankingScore(right.activity) - rankingScore(left.activity))
      .slice(0, MAX_POPULAR)

    return json(res, 200, {
      success: true,
      chainId: CHAIN_ID,
      source: 'Client-approved Robinhood registry + Robinhood RPC + DexScreener markets',
      generatedAt: new Date().toISOString(),
      native,
      sections: { all, tokens, memes, popular, pop: popular },
      dataAvailable: all.length > 0,
    })
  } catch (error) {
    console.error('Robinhood token registry unavailable:', error?.message || error)
    return json(res, 200, {
      success: false,
      chainId: CHAIN_ID,
      source: 'Client-approved Robinhood registry + Robinhood RPC + DexScreener markets',
      generatedAt: new Date().toISOString(),
      native: null,
      sections: { all: [], tokens: [], memes: [], popular: [], pop: [] },
      dataAvailable: false,
      warnings: ['Robinhood token registry is currently unavailable.'],
    })
  }
}
