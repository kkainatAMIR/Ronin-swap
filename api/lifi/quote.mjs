import { apiError, json, parseBody, rateLimit } from '../_lib/roninBackend.mjs'
import { createQuoteProof } from '../_lib/ethereum.mjs'
import { getApprovedLifiToken, isApprovedLifiToken, lifiRequest, LIFI_FEE_BPS, LIFI_FEE_ENABLED, LIFI_INTEGRATOR } from '../_lib/lifi.mjs'

const ROBINHOOD_CHAIN_ID = 4663
const SUPPORTED_CHAINS = new Set([1, ROBINHOOD_CHAIN_ID])
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

function validChain(value) { return SUPPORTED_CHAINS.has(Number(value)) }
function validAmount(value) { return typeof value === 'string' && /^[1-9]\d*$/.test(value) }
function nativeAddress(value) { return String(value || '').toLowerCase() === '0x0000000000000000000000000000000000000000' }

function normalizeQuote(body, request) {
  const action = body?.action || {}
  const estimate = body?.estimate || {}
  const transactionRequest = body?.transactionRequest || null
  return {
    provider: 'lifi',
    quoteId: body?.id || body?.toolDetails?.key || null,
    source: { chainId: request.fromChain, token: request.fromToken, amount: request.fromAmount },
    destination: { chainId: request.toChain, token: request.toToken, amount: estimate.toAmount || action.toAmount || null },
    inputAmount: request.fromAmount,
    expectedOutput: estimate.toAmount || action.toAmount || null,
    volumeUsd: estimate.fromAmountUSD == null ? null : Number(estimate.fromAmountUSD),
    minimumReceived: estimate.toAmountMin || null,
    priceImpact: estimate.priceImpact ?? null,
    gasCost: estimate.gasCosts || [],
    fees: estimate.feeCosts || [],
    executionDuration: estimate.executionDuration || null,
    routeSteps: body?.steps || [],
    transactionRequest,
    quoteProof: null,
    tool: body?.tool || body?.toolDetails || null,
    integrator: LIFI_INTEGRATOR,
    raw: body,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!rateLimit(req, 'lifi-quote', 30)) return apiError(res, 429, 'RATE_LIMITED', 'Too many LI.FI quote requests.')
  const body = parseBody(req) || {}
  const fromChain = Number(body.fromChain)
  const toChain = Number(body.toChain)
  const fields = [body.fromToken, body.toToken, body.fromAddress, body.toAddress]
  if (!validChain(fromChain) || !validChain(toChain) || !fields.every((value) => ADDRESS_PATTERN.test(String(value || ''))) || !validAmount(body.fromAmount)) return apiError(res, 400, 'INVALID_LIFI_QUOTE', 'A valid chain-aware LI.FI quote request is required.')
  const [fromApproved, toApproved] = await Promise.all([isApprovedLifiToken(fromChain, body.fromToken), isApprovedLifiToken(toChain, body.toToken)])
  if (!fromApproved || !toApproved) return apiError(res, 403, 'UNSUPPORTED_TOKEN', 'This token is not approved for RONIN LI.FI routing.')
  const request = {
    fromChain,
    toChain,
    fromToken: body.fromToken,
    toToken: body.toToken,
    fromAmount: body.fromAmount,
    fromAddress: body.fromAddress,
    toAddress: body.toAddress,
    slippage: Number(body.slippage ?? 0.005),
    integrator: LIFI_INTEGRATOR,
    ...(LIFI_FEE_ENABLED && (fromChain === ROBINHOOD_CHAIN_ID || toChain === ROBINHOOD_CHAIN_ID) ? { fee: String(LIFI_FEE_BPS / 10_000) } : {}),
  }
  try {
    const quote = await lifiRequest(`/quote?${new URLSearchParams(request)}`)
    if (!quote?.estimate?.toAmount || !quote?.transactionRequest?.to || !nativeAddress(quote.transactionRequest.to) && !ADDRESS_PATTERN.test(quote.transactionRequest.to)) return apiError(res, 502, 'MALFORMED_LIFI_QUOTE', 'LI.FI returned an incomplete transaction quote.')
    const normalized = normalizeQuote(quote, request)
    const fromDecimals = Number(quote?.action?.fromToken?.decimals)
    const proof = createQuoteProof({
      provider: 'lifi',
      fromChain,
      toChain,
      wallet: body.fromAddress,
      fromToken: body.fromToken.toLowerCase(),
      toToken: body.toToken.toLowerCase(),
      fromAmount: body.fromAmount,
      toAmount: normalized.expectedOutput,
      transactionTo: quote.transactionRequest.to.toLowerCase(),
      transactionData: String(quote.transactionRequest.data || '').toLowerCase(),
      transactionValue: String(quote.transactionRequest.value || '0x0'),
      // Carried through (not part of the verified-match fields) so completion
      // can calculate Samurai Points without re-deriving them from scratch.
      volumeUsd: normalized.volumeUsd,
      fromDecimals: Number.isInteger(fromDecimals) && fromDecimals >= 0 && fromDecimals <= 255 ? fromDecimals : 18,
    })
    normalized.quoteProof = proof.proof
    normalized.expiresAt = proof.expiresAt
    return json(res, 200, { success: true, quote: normalized, approvedFromToken: getApprovedLifiToken(fromChain, body.fromToken), approvedToToken: getApprovedLifiToken(toChain, body.toToken) })
  } catch (error) {
    const status = error?.status === 404 ? 404 : error?.status === 429 ? 429 : 502
    return apiError(res, status, status === 404 ? 'NO_ROUTE' : 'LIFI_QUOTE_ERROR', status === 404 ? 'No LI.FI route is available for this pair.' : 'LI.FI quote service is unavailable.')
  }
}