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

/** Fetch a quote (and, when taker is provided, an assembled transaction) via Swap V2 /order. */
export async function getJupiterOrder({ inputMint, outputMint, amountLamports, slippageBps = DEFAULT_SLIPPAGE_BPS, taker, signal }) {
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

  // First attempt: include the taker if the caller provided one. If Jupiter
  // rejects the with-taker request for ANY reason (HTTP 400 "Failed to get
  // quotes" for an off-curve taker, HTTP 500 transient error, etc.), retry
  // WITHOUT the taker so the user still sees a price. The sign-time check
  // on `quote.transaction` (empty/null → "Insufficient SOL") blocks execution;
  // we never silently let them sign an unbuildable transaction.
  //
  // The only errors we DON'T retry on are:
  //   - AbortError (caller cancelled the request)
  //   - The second (no-taker) attempt also fails (real upstream issue)
  try {
    return await fetchOnce(Boolean(taker))
  } catch (error) {
    // Never retry if the caller aborted, or if we never had a taker to drop.
    if (error?.name === 'AbortError' || !taker) throw error
    // Any other error from the with-taker attempt → retry without taker.
    // Quote-only mode doesn't depend on the connected wallet's on-chain
    // state, so it succeeds in virtually every case where the with-taker
    // call failed.
    try {
      return await fetchOnce(false)
    } catch (retryError) {
      // If the retry ALSO fails, throw the ORIGINAL error (not the retry
      // error) so the caller sees the most informative message from the
      // first attempt. But if the retry was aborted, propagate that.
      if (retryError?.name === 'AbortError') throw retryError
      throw error
    }
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
