import { apiError, json, parseBody, rateLimit, readUpstream } from '../_lib/roninBackend.mjs'
import { createQuoteProof, ethereumChainId, ethereumRpc, ethereumSwapFeeConfig, fetchZeroEx, isEthereumAddress, isEthereumConfigured, isSupportedEthereumToken } from '../_lib/ethereum.mjs'

const STABLECOINS = new Set(['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7'])

async function tokenDecimals(address) {
  const result = await ethereumRpc('eth_call', [{ to: address, data: '0x313ce567' }, 'latest'])
  const decimals = Number.parseInt(result, 16)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('TOKEN_METADATA_UNAVAILABLE')
  return decimals
}

function usdAmount(rawAmount, decimals) {
  return Number(rawAmount) / (10 ** decimals)
}

function upstreamErrorMessage(result) {
  const detail = result?.data?.details?.[0]
  return detail?.reason || result?.reason || result?.message || result?.raw || 'No Ethereum route is available.'
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'evm-quote', 60)) return apiError(res, 429, 'RATE_LIMITED', 'Too many quote requests. Try again shortly.')
  if (!isEthereumConfigured()) return apiError(res, 503, 'ZEROX_NOT_CONFIGURED', 'Ethereum routing is not configured.')
  const body = parseBody(req) || {}
  const { chainId, sellToken, buyToken, sellAmount, taker, walletAddress, provider } = body
  const requestTaker = taker || walletAddress
  if (Number(chainId) !== ethereumChainId()) return apiError(res, 400, 'INVALID_CHAIN', 'Ethereum Mainnet is required.')
  if (provider != null && provider !== '0x') return apiError(res, 400, 'PROVIDER_CHAIN_MISMATCH', 'Ethereum Mainnet uses the 0x provider.')
  if (!requestTaker || !isEthereumAddress(requestTaker)) return apiError(res, 400, 'INVALID_TAKER', 'A valid Ethereum wallet address is required.')
  const normalizedSellToken = sellToken === 'native' ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : sellToken
  const normalizedBuyToken = buyToken === 'native' ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : buyToken
  if (!isSupportedEthereumToken(sellToken) || !isSupportedEthereumToken(buyToken) || sellToken === buyToken) return apiError(res, 400, 'UNSUPPORTED_TOKEN', 'The requested Ethereum token is not supported.')
  if (!isEthereumAddress(normalizedSellToken) || !isEthereumAddress(normalizedBuyToken) || normalizedSellToken.toLowerCase() === normalizedBuyToken.toLowerCase()) return apiError(res, 400, 'INVALID_TOKENS', 'Valid, different Ethereum token addresses are required.')
  if (!/^\d+$/.test(String(sellAmount || '')) || BigInt(sellAmount) <= 0n) return apiError(res, 400, 'INVALID_AMOUNT', 'sellAmount must be a positive integer in base units.')
  if (requestTaker && !isEthereumAddress(requestTaker)) return apiError(res, 400, 'INVALID_TAKER', 'taker must be a valid Ethereum address.')
  try {
    const fee = ethereumSwapFeeConfig()
    const params = new URLSearchParams({ chainId: '1', sellToken: normalizedSellToken, buyToken: normalizedBuyToken, sellAmount, swapFeeRecipient: fee.recipient, swapFeeBps: String(fee.bps), swapFeeToken: normalizedSellToken })
    if (requestTaker) params.set('taker', requestTaker)
    const upstream = await fetchZeroEx(`/swap/allowance-holder/quote?${params}`)
    const result = await readUpstream(upstream)
    if (!upstream.ok) {
      const status = upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : upstream.status
      const code = upstream.status === 429 ? 'ZEROX_RATE_LIMITED' : 'ZEROX_QUOTE_ERROR'
      return apiError(res, status, code, upstreamErrorMessage(result))
    }
    if (!result?.buyAmount || !result?.transaction?.to || !result?.transaction?.data) return apiError(res, 502, 'INVALID_ZEROX_QUOTE', 'The Ethereum route response was incomplete.')
    let volumeUsd = null
    if (STABLECOINS.has(normalizedSellToken.toLowerCase())) volumeUsd = usdAmount(sellAmount, await tokenDecimals(normalizedSellToken))
    else if (STABLECOINS.has(normalizedBuyToken.toLowerCase())) volumeUsd = usdAmount(result.buyAmount, await tokenDecimals(normalizedBuyToken))
    const transaction = { to: result.transaction.to, data: result.transaction.data, value: result.transaction.value || '0', gas: result.transaction.gas || null, gasPrice: result.transaction.gasPrice || null }
    const allowanceTarget = result.permit2?.allowanceTarget || result.allowanceTarget || null
    if (!isEthereumAddress(transaction.to) || (allowanceTarget && !isEthereumAddress(allowanceTarget)) || allowanceTarget?.toLowerCase() === normalizedSellToken.toLowerCase()) return apiError(res, 502, 'INVALID_ROUTE_TARGET', 'The routing provider returned an invalid transaction target.')
    const expiresAt = result.expiration ? Date.parse(result.expiration) : Date.now() + 5 * 60_000
    const proof = createQuoteProof({ chainId: 1, wallet: requestTaker, sellToken: sellToken === 'native' ? 'native' : normalizedSellToken.toLowerCase(), buyToken: buyToken === 'native' ? 'native' : normalizedBuyToken.toLowerCase(), sellAmount: String(sellAmount), buyAmount: String(result.buyAmount), to: transaction.to.toLowerCase(), data: transaction.data, value: String(transaction.value), volumeUsd: volumeUsd == null ? null : Number(volumeUsd), sellDecimals: sellToken === 'native' ? 18 : await tokenDecimals(normalizedSellToken), buyDecimals: buyToken === 'native' ? 18 : await tokenDecimals(normalizedBuyToken) }, expiresAt)
    return json(res, 200, { chainId: 1, provider: '0x', buyAmount: result.buyAmount, sellAmount: result.sellAmount, volumeUsd, quoteProof: proof.proof, expiresAt: proof.expiresAt, price: result.price || null, liquidityAvailable: true, transaction, allowanceTarget, route: result.route || null, swapFeeBps: fee.bps, swapFeeRecipient: fee.recipient, integratorFee: result.fees?.integratorFee || null })
  } catch (error) {
    console.error('0x quote request failed:', error?.name || 'Error', error?.message || 'Unknown error')
    return apiError(res, error?.name === 'TimeoutError' ? 504 : 502, 'ZEROX_NETWORK_ERROR', 'Ethereum routing is temporarily unavailable. Please try again.')
  }
}