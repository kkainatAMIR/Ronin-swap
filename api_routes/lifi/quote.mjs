import { apiError, json, parseBody, rateLimit } from '../../api/_lib/roninBackend.mjs'
import { createQuoteProof } from '../../api/_lib/ethereum.mjs'
import {
  getApprovedLifiToken,
  isApprovedLifiToken,
  lifiRequest,
  LIFI_INTEGRATOR,
  LIFI_FEE_ENABLED,
  LIFI_FEE_BPS,
  LIFI_FEE_DECIMAL,
  LIFI_FEE_RECEIVER,
  lifiFeeConfigIsValid,
  buildLifiFeeQueryParams,
} from '../../api/_lib/lifi.mjs'

const ROBINHOOD_CHAIN_ID = 4663
const SUPPORTED_CHAINS = new Set([1, ROBINHOOD_CHAIN_ID])
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

function validChain(value) { return SUPPORTED_CHAINS.has(Number(value)) }
function validAmount(value) { return typeof value === 'string' && /^[1-9]\d*$/.test(value) }
function nativeAddress(value) { return String(value || '').toLowerCase() === '0x0000000000000000000000000000000000000000' }
function isLifiFeeNotConfiguredError(message) {
  if (typeof message !== 'string') return false
  return /not\s+configured\s+for\s+collecting\s+fees/i.test(message) || /sign\s+up\s+on\s+https?:\/\/portal\.li\.fi/i.test(message)
}
function isLifiFeeRequiresIntegratorError(message) {
  if (typeof message !== 'string') return false
  return /Argument\s+fee\s+requires\s+integrator/i.test(message)
}
function sumIntegratorFeeFromCosts(feeCosts) {
  if (!Array.isArray(feeCosts)) return 0n
  let total = 0n
  for (const cost of feeCosts) {
    const split = cost?.feeSplit
    const raw = split?.integratorFee
    if (typeof raw === 'string' && /^\d+$/.test(raw)) total += BigInt(raw)
    else if (typeof raw === 'bigint') total += raw
    else if (Number.isFinite(Number(raw)) && Number(raw) > 0) total += BigInt(String(Math.floor(Number(raw))))
  }
  return total
}

function normalizeQuote(body, request, feeContext) {
  const action = body?.action || {}
  const estimate = body?.estimate || {}
  const transactionRequest = body?.transactionRequest || null
  const integratorFeeRaw = sumIntegratorFeeFromCosts(estimate.feeCosts)
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
    integratorFeeApplied: integratorFeeRaw > 0n,
    integratorFeeRaw: integratorFeeRaw.toString(),
    feeConfig: {
      enabled: feeContext?.enabled === true,
      requested: feeContext?.requested === true,
      bps: LIFI_FEE_BPS,
      decimal: LIFI_FEE_DECIMAL,
      receiver: LIFI_FEE_RECEIVER,
      receiverValid: Boolean(feeContext?.receiverValid),
      configValidBeforeRequest: Boolean(feeContext?.configValidBeforeRequest),
    },
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
  const feeCheck = lifiFeeConfigIsValid()
  const feeParams = buildLifiFeeQueryParams()
  const feeContext = {
    enabled: LIFI_FEE_ENABLED,
    requested: feeCheck.ok && Object.prototype.hasOwnProperty.call(feeParams, 'fee'),
    receiverValid: ADDRESS_PATTERN.test(LIFI_FEE_RECEIVER),
    configValidBeforeRequest: feeCheck.ok,
  }
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
    ...feeParams,
  }
  try {
    const quote = await lifiRequest(`/quote?${new URLSearchParams(request)}`)
    if (!quote?.estimate?.toAmount || !quote?.transactionRequest?.to || !nativeAddress(quote.transactionRequest.to) && !ADDRESS_PATTERN.test(quote.transactionRequest.to)) return apiError(res, 502, 'MALFORMED_LIFI_QUOTE', 'LI.FI returned an incomplete transaction quote.')
    if (feeContext.requested) {
      const integratorFeeRaw = sumIntegratorFeeFromCosts(quote?.estimate?.feeCosts)
      if (integratorFeeRaw <= 0n) {
        const detail = [
          `LI.FI fee was requested (bps=${LIFI_FEE_BPS}, integrator=${LIFI_INTEGRATOR}, receiver=${LIFI_FEE_RECEIVER}) but the returned route contains no integrator fee in estimate.feeCosts.`,
          'This typically means the LI.FI portal account for the configured integrator string does not have a fee wallet linked yet.',
          'Action required: confirm the integrator is registered at portal.li.fi with the fee receiver configured and allowed for all target chains (Ethereum + Robinhood Chain).',
        ].join(' ')
        return apiError(res, 502, 'LIFI_FEE_MISSING_FROM_ROUTE', detail)
      }
    }
    const normalized = normalizeQuote(quote, request, feeContext)
    const fromDecimals = Number(quote?.action?.fromToken?.decimals)
    const toDecimals = Number(quote?.action?.toToken?.decimals)
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
      volumeUsd: normalized.volumeUsd,
      fromDecimals: Number.isInteger(fromDecimals) && fromDecimals >= 0 && fromDecimals <= 255 ? fromDecimals : 18,
      toDecimals: Number.isInteger(toDecimals) && toDecimals >= 0 && toDecimals <= 255 ? toDecimals : 18,
    })
    normalized.quoteProof = proof.proof
    normalized.expiresAt = proof.expiresAt
    return json(res, 200, { success: true, quote: normalized, approvedFromToken: getApprovedLifiToken(fromChain, body.fromToken), approvedToToken: getApprovedLifiToken(toChain, body.toToken) })
  } catch (error) {
    const upstreamStatus = Number(error?.status || 0)
    const upstreamMessage = typeof error?.message === 'string' && error.message.trim() ? error.message.replace(/\s+/g, ' ').trim() : null
    let status = 502
    let code = 'LIFI_QUOTE_ERROR'
    let message = 'LI.FI quote service is unavailable.'
    if (upstreamStatus === 404) {
      status = 404
      code = 'NO_ROUTE'
      message = 'No LI.FI route is available for this pair.'
    } else if (upstreamStatus === 429) {
      status = 429
      code = 'LIFI_RATE_LIMITED'
      message = upstreamMessage || 'LI.FI quote service rate limited. Retry shortly.'
    } else if (upstreamStatus >= 400 && upstreamStatus < 500) {
      if (isLifiFeeNotConfiguredError(upstreamMessage)) {
        status = 400
        code = 'LIFI_INTEGRATOR_FEE_NOT_CONFIGURED'
        const hint = [
          `LI.FI rejected fee collection for integrator="${LIFI_INTEGRATOR}" (fee bps=${LIFI_FEE_BPS}, receiver=${LIFI_FEE_RECEIVER}).`,
          'The LI.FI portal account for this integrator string must be fully registered at https://portal.li.fi/ with a linked fee wallet before the fee parameter is accepted.',
          'Fees are NOT silently disabled. Resolve the portal-side configuration and retry.',
        ].join(' ')
        message = upstreamMessage ? `${upstreamMessage} — ${hint}` : hint
      } else if (isLifiFeeRequiresIntegratorError(upstreamMessage)) {
        status = 400
        code = 'LIFI_FEE_PARAM_MISSING_INTEGRATOR'
        message = `LI.FI rejected the fee parameter because no integrator string was sent. integrator="${LIFI_INTEGRATOR}". ${upstreamMessage || ''}`
      } else {
        status = upstreamStatus
        code = 'LIFI_INVALID_REQUEST'
        message = upstreamMessage ? `LI.FI rejected this quote: ${upstreamMessage}` : 'LI.FI rejected this quote request (invalid token, amount, or routing).'
      }
    } else if (upstreamMessage) {
      message = `LI.FI request failed: ${upstreamMessage}`
    }
    return apiError(res, status, code, message)
  }
}