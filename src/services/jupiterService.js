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
  const params = new URLSearchParams({
    inputMint: String(inputMint),
    outputMint: String(outputMint),
    amount: String(amountLamports),
    slippageBps: String(slippageBps),
    swapMode: 'ExactIn',
  })
  if (taker) params.set('taker', String(taker))

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
    throw new JupiterApiError(body?.error || 'Jupiter could not price this swap right now.', { status: response.status, detail: body })
  }

  // Jupiter /swap/v2/order returns `transaction: null` when no `taker` is
  // provided — that is a valid "quote-only" response used by the BuyRonin
  // panel to show a price before the wallet is connected. Only require a
  // transaction when the caller actually passed a `taker` (i.e., they want
  // a signable transaction). Quote-only callers check `quote.transaction`
  // themselves before signing.
  if (body?.errorCode != null || body?.error || body?.errorMessage || (taker && !body?.transaction)) {
    throw new JupiterApiError(body?.errorMessage || body?.error || 'Jupiter could not prepare a signable transaction for this swap.', { detail: body })
  }
  if (!body?.inAmount || !body?.outAmount) throw new JupiterApiError('No route is currently available for this swap. Please try again shortly.', { detail: body })
  return body
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
