// RoninSamurai.com — Jupiter Swap V2 integration (frontend side).
//
// All calls go through the RONIN backend proxy so the Jupiter API key stays
// server-side. Every eligible /order request carries the RoninSamurai.com
// referral account + 50 bps referral fee.
//
// The backend is the source of truth for the referral config (server env).
// These frontend constants mirror it for UI labelling and verification.

export const SOL_MINT = 'So11111111111111111111111111111111111111112'
export const LAMPORTS_PER_SOL = 1_000_000_000
export const DEFAULT_SLIPPAGE_BPS = 100 // 1%

// Jupiter Swap V2 / Ultra referral account for RoninSamurai.com.
// Keep this aligned with the server-side JUPITER_REFERRAL_ACCOUNT.
export const JUPITER_REFERRAL_ACCOUNT = 'VF1nw8cRfFKJeqW7kCsthWy1NirCF4B31YocUKZrbB7'
export const JUPITER_REFERRAL_FEE_BPS = 50 // 0.5%

async function parseJsonSafely(response) {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { raw: text }
  }
}

/** Read the server-side referral config so the UI always mirrors the backend. */
export async function getJupiterReferralConfig() {
  try {
    const response = await fetch('/api/health', { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error('health failed')
    const body = await parseJsonSafely(response)
    return {
      referralAccount: body?.referralAccount || JUPITER_REFERRAL_ACCOUNT,
      referralFeeBps: Number(body?.referralFeeBps) || JUPITER_REFERRAL_FEE_BPS,
    }
  } catch {
    return {
      referralAccount: JUPITER_REFERRAL_ACCOUNT,
      referralFeeBps: JUPITER_REFERRAL_FEE_BPS,
    }
  }
}

/** Fetch a quote (and, when taker is provided, an assembled transaction) via Swap V2 /order.
 *
 *  Parameters:
 *   - requireTransaction: when true, do NOT auto-retry without taker on failure.
 *     Use this at sign-time so the real Jupiter error (e.g. "Insufficient funds",
 *     "Failed to get quotes") surfaces to the user instead of being masked by
 *     a quote-only retry. Default false (price-preview calls use the retry).
 */
export async function getJupiterOrder({ inputMint, outputMint, amountLamports, slippageBps = DEFAULT_SLIPPAGE_BPS, taker, signal, requireTransaction = false }) {
  const buildParams = (includeTaker) => {
    const params = new URLSearchParams({
      inputMint: String(inputMint),
      outputMint: String(outputMint),
      amount: String(amountLamports),
      slippageBps: String(slippageBps),
      swapMode: 'ExactIn',
    })
    if (includeTaker && taker) params.set('taker', String(taker))
    return params
  }

  const fetchOnce = async (includeTaker) => {
    const params = buildParams(includeTaker)
    let response
    try {
      response = await fetch(`/api/jupiter/order?${params.toString()}`, { signal })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      throw new JupiterApiError('Could not reach the RONIN swap service. Please try again.', { detail: error })
    }
    const body = await parseJsonSafely(response)
    if (!response.ok) {
      if (response.status === 400 && /referralAccount is initialized/i.test(body?.error || body?.detail?.error || '')) {
        throw new JupiterApiError('Jupiter referral setup is incomplete. The referral account needs to be initialized for the Swap V2 / Ultra referral project before a fee-applied order can be created.', { status: response.status, detail: body })
      }
      if (response.status === 404 || /no route|not found|could not find any route/i.test(body?.error || body?.detail?.error || '')) {
        throw new JupiterApiError('No route is currently available for this swap. Please try again shortly.', { status: response.status, detail: body })
      }
      // Surface Jupiter's actual error message + status so callers can retry
      // with a different strategy (e.g. drop the taker) if they want to.
      const err = new JupiterApiError(body?.error || 'Jupiter could not price this swap right now.', { status: response.status, detail: body })
      err.httpStatus = response.status
      err.jupiterError = body?.error || ''
      throw err
    }

    // Jupiter /swap/v2/order returns quote data (inAmount + outAmount +
    // routePlan + priceImpactPct) in THREE different shapes, ALL HTTP 200:
    //
    //   1. No taker  → HTTP 200, transaction: null     ← "quote-only"
    //   2. Taker + enough SOL  → HTTP 200, transaction: "base64..."  ← signable
    //   3. Taker + insufficient SOL → HTTP 200, transaction: "" (empty string),
    //      errorCode: 1, error: "Insufficient funds"   ← price shown, can't sign
    //
    // For (1) and (2) the response is obviously usable. For (3), the UI should
    // STILL show the price — Jupiter is telling us "here's the rate, but the
    // connected wallet can't actually pay for it". Downstream consumers
    // (Swap.jsx handleSwapAction, BuyRonin executeSwap) already check
    // `quote.transaction` before signing, so the empty-transaction case is
    // safely blocked at sign time with a clear "insufficient balance" message.
    //
    // The ONLY case where we throw here is when Jupiter returned NO quote data
    // at all (no inAmount/outAmount) — that means a real error like
    // "Failed to get quotes" (invalid taker) or "No route found".
    if (!body?.inAmount || !body?.outAmount) {
      const err = new JupiterApiError(
        body?.errorMessage || body?.error || 'No route is currently available for this swap. Please try again shortly.',
        { status: response.status, detail: body }
      )
      err.httpStatus = response.status
      err.jupiterError = body?.error || ''
      throw err
    }
    return body
  }

  // Price previews do not need a taker and are more reliable without one.
  // Jupiter can reject a taker-bearing quote-only request with "Failed to get
  // quotes" even though the same pair has a valid route. Only sign-time
  // requests need the taker because Jupiter must assemble a transaction for
  // that wallet.
  //
  // If the no-taker v2 attempt ALSO fails (rare — usually means Jupiter is
  // having a real routing issue, OR the amount is too small for /swap/v2/order
  // to price), fall back to /api/jupiter/quote (the v1 endpoint), which is
  // more lenient and returns just a quote (no signable transaction). The user
  // still sees a price; sign-time will surface a clear error.
  //
  // The only errors we DON'T retry on are:
  //   - AbortError (caller cancelled the request)
  //   - requireTransaction=true (sign-time — need the real error)
  try {
    return await fetchOnce(requireTransaction && Boolean(taker))
  } catch (error) {
    // Never retry if the caller aborted, or if the caller explicitly asked
    // for the real error (sign-time).
    if (error?.name === 'AbortError' || requireTransaction) throw error
    // Sign-time errors must remain visible to the caller so it can try the
    // v1 transaction builder. Preview requests are already quote-only here.
    if (requireTransaction && taker) {
      try {
        return await fetchOnce(false)
      } catch (retryError) {
        if (retryError?.name === 'AbortError') throw retryError
        // Fall through to v1 fallback below.
      }
    }
    // Last-resort fallback: hit /api/jupiter/quote (v1), which uses a
    // different Jupiter endpoint and is more lenient. It returns just a
    // quote (transaction: null), so sign-time will need a fresh with-taker
    // call — but at least the user sees a price instead of an error.
    try {
      const v1Params = new URLSearchParams({
        inputMint: String(inputMint),
        outputMint: String(outputMint),
        amount: String(amountLamports),
        slippageBps: String(slippageBps),
        swapMode: 'ExactIn',
      })
      const v1Response = await fetch(`/api/jupiter/quote?${v1Params.toString()}`, { signal })
      if (v1Response.ok) {
        const v1Body = await parseJsonSafely(v1Response)
        if (v1Body?.inAmount && v1Body?.outAmount) {
          // v1 doesn't return a transaction. Mark as quote-only so the
          // sign-time check on quote.transaction surfaces a clear message.
          return { ...v1Body, transaction: null, source: 'v1-fallback' }
        }
      }
    } catch (v1Error) {
      if (v1Error?.name === 'AbortError') throw v1Error
    }
    // All retries failed — throw the original error (most informative).
    throw error
  }
}

/**
 * Build a signable transaction from a v1 quote + user public key.
 *
 * Used as a fallback at sign-time when Jupiter's v2 /swap/v2/order refuses
 * to build a transaction for a specific taker address (returns HTTP 400
 * "Failed to get quotes"). The v1 flow is:
 *
 *   1. GET /api/jupiter/quote  (v1 quote — already proven to work for this
 *                              wallet in the price-preview path)
 *   2. POST /api/jupiter/swap  (v1 swap — assembles a signable transaction
 *                              from the quote + userPublicKey)
 *
 * Returns the v1 swap response, which contains `swapTransaction` (base64)
 * and other metadata. The caller is responsible for signing and submitting.
 */
export async function getJupiterSwapTransaction({ quoteResponse, userPublicKey, signal }) {
  if (!quoteResponse || typeof quoteResponse !== 'object') {
    throw new JupiterApiError('A Jupiter v1 quoteResponse object is required.')
  }
  if (!userPublicKey) {
    throw new JupiterApiError('A userPublicKey is required to build a swap transaction.')
  }

  const response = await fetch('/api/jupiter/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse, userPublicKey }),
    signal,
  })

  const body = await parseJsonSafely(response)
  if (!response.ok) {
    throw new JupiterApiError(body?.error || body?.message || 'Jupiter could not build a swap transaction from this quote.', { status: response.status, detail: body })
  }
  if (!body?.swapTransaction) {
    throw new JupiterApiError(body?.error || body?.message || 'Jupiter did not return a signable swap transaction.', { detail: body })
  }
  return body
}

/**
 * v1 fallback for sign-time: fetch a v1 quote, then build a signable
 * transaction from that quote + userPublicKey. Used when /swap/v2/order
 * refuses to build a transaction for a specific taker (returns "Failed to
 * get quotes" — Jupiter's v2 endpoint is stricter than v1 about which
 * wallets it will build transactions for).
 *
 * Returns an object shaped like the v2 /order response (so callers can
 * treat it the same way):
 *   {
 *     transaction: "<base64 swapTransaction from v1 /swap>",
 *     inAmount, outAmount, otherAmountThreshold,
 *     slippageBps, swapMode, routePlan,
 *     lastValidBlockHeight: null (v1 /swap doesn't return this),
 *     requestId: null,
 *     source: 'v1-fallback',
 *   }
 *
 * The caller signs the transaction and submits it via /api/jupiter/execute
 * (v2 /execute accepts any signed transaction by requestId — but v1 doesn't
 * return a requestId, so the caller must use signAndSendTransaction
 * through the wallet provider directly instead).
 */
export async function getJupiterOrderV1Fallback({ inputMint, outputMint, amountLamports, slippageBps = DEFAULT_SLIPPAGE_BPS, userPublicKey, signal }) {
  // Step 1: fetch v1 quote
  const quoteParams = new URLSearchParams({
    inputMint: String(inputMint),
    outputMint: String(outputMint),
    amount: String(amountLamports),
    slippageBps: String(slippageBps),
    swapMode: 'ExactIn',
  })
  const quoteResponse = await fetch(`/api/jupiter/quote?${quoteParams.toString()}`, { signal })
  const quoteBody = await parseJsonSafely(quoteResponse)
  if (!quoteResponse.ok || !quoteBody?.inAmount || !quoteBody?.outAmount) {
    throw new JupiterApiError(quoteBody?.error || 'Jupiter v1 quote failed.', { status: quoteResponse.status, detail: quoteBody })
  }

  // Step 2: build swap transaction from the quote
  const swapBody = await getJupiterSwapTransaction({ quoteResponse: quoteBody, userPublicKey, signal })

  // Step 3: shape the response like v2 /order so callers can treat it the same
  // CRITICAL: include inputMint, outputMint, and taker — these are checked by
  // isQuoteCurrentForRequest() in Swap.jsx. Without them, the validation fails
  // with "Quote is missing or stale" even though the quote is fresh.
  return {
    transaction: swapBody.swapTransaction,
    inAmount: quoteBody.inAmount,
    outAmount: quoteBody.outAmount,
    otherAmountThreshold: quoteBody.otherAmountThreshold,
    slippageBps: quoteBody.slippageBps,
    swapMode: quoteBody.swapMode,
    priceImpactPct: quoteBody.priceImpactPct,
    routePlan: quoteBody.routePlan,
    lastValidBlockHeight: swapBody.lastValidBlockHeight || null,
    requestId: null,  // v1 /swap doesn't return a requestId
    feeBps: null,
    feeMint: null,
    platformFee: null,
    // Fields needed by isQuoteCurrentForRequest() validation:
    inputMint: String(inputMint),
    outputMint: String(outputMint),
    taker: String(userPublicKey),
    source: 'v1-fallback',
  }
}

/** Execute a signed Swap V2 order through the RONIN backend (proxied to Jupiter /execute). */
export async function executeJupiterOrder({ signedTransaction, requestId, lastValidBlockHeight, signal }) {
  if (!signedTransaction || !requestId) throw new JupiterApiError('A signed transaction and requestId are required.')

  const response = await fetch('/api/jupiter/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedTransaction, requestId, lastValidBlockHeight }),
    signal,
  })

  const body = await parseJsonSafely(response)
  if (!response.ok || (!body?.signature && body?.status !== 'Success')) {
    throw new JupiterApiError(body?.error || body?.message || 'The swap could not be executed.', { status: response.status, detail: body })
  }
  return body
}

export async function verifySwapTransaction({ signature, wallet, signal }) {
  if (!signature || !wallet) throw new JupiterApiError('A transaction signature and wallet are required for verification.')

  const response = await fetch('/api/swap/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature, wallet }),
    signal,
  })

  const body = await parseJsonSafely(response)
  if (!response.ok && body?.reason !== 'TRANSACTION_NOT_FOUND' && body?.reason !== 'TRANSACTION_PENDING' && body?.reason !== 'TRANSACTION_FAILED' && body?.reason !== 'WALLET_MISMATCH') {
    throw new JupiterApiError(body?.error || body?.message || 'The transaction could not be verified.', { status: response.status, detail: body })
  }
  return body
}

export async function recordVerifiedSwap({ signature, wallet, signal }) {
  if (!signature || !wallet) throw new JupiterApiError('A transaction signature and wallet are required for persistence.')

  const response = await fetch('/api/swap/record', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature, wallet }),
    signal,
  })
  const body = await parseJsonSafely(response)
  if (!response.ok) throw new JupiterApiError(body?.error || 'The verified swap could not be persisted.', { status: response.status, detail: body })
  return body
}

export async function processSamuraiPoints({ signature, signal }) {
  if (!signature) throw new JupiterApiError('A transaction signature is required for Samurai Points processing.')
  const response = await fetch('/api/swap/points', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signature }),
    signal,
  })
  const body = await parseJsonSafely(response)
  if (!response.ok) throw new JupiterApiError(body?.error || 'Samurai Points could not be processed.', { status: response.status, detail: body })
  return body
}

export function lamportsToSol(lamports) {
  return Number(lamports) / LAMPORTS_PER_SOL
}

export function solToLamports(sol) {
  return Math.round(Number(sol) * LAMPORTS_PER_SOL)
}

export class JupiterApiError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message)
    this.name = 'JupiterApiError'
    this.status = status
    this.detail = detail
  }
}
