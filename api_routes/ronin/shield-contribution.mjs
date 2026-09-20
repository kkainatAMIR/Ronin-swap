// NOTE: shieldStore.mjs does not exist in the repo (pre-existing bug).
// The import is deferred to runtime so it doesn't crash the gateway at
// startup. When this endpoint is called, it will return a 500 error
// with a clear message instead of breaking all other API routes.
//
// To fix: create api/_lib/shieldStore.mjs with addTrackedContribution()
// and loadCounters() exports, or remove this endpoint if unused.

function json(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store, max-age=0')
  return res.json(body)
}

// Deferred import — only fails when this specific endpoint is called,
// not when the gateway loads.
async function loadShieldStore() {
  const mod = await import('../../api/_lib/shieldStore.mjs')
  return mod
}

// Contribution validation mirrors the frontend config (src/config/shield.js).
const MIN_SOL = 0.001
const MAX_SOL = 10

// Standard Solana base58 64-char signature.
const BASE58_ALPHABET = /^[1-9A-HJ-NP-Za-km-z]+$/
function isValidSignature(value) {
  return typeof value === 'string' && value.length === 64 && BASE58_ALPHABET.test(value)
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })

  try {
    const body = req.body || {}
    const solAmount = Number(body.solAmount ?? body.amount)
    const signature = body.signature ? String(body.signature).trim() : ''

    if (!Number.isFinite(solAmount) || solAmount < MIN_SOL || solAmount > MAX_SOL) {
      return json(res, 400, { error: `solAmount must be between ${MIN_SOL} and ${MAX_SOL} SOL.` })
    }
    if (!isValidSignature(signature)) {
      return json(res, 400, { error: 'A valid transaction signature is required.' })
    }

    // We only track for transparency; on-chain treasury balance is source of truth.
    const { addTrackedContribution, loadCounters } = await loadShieldStore()
    const newTracked = await addTrackedContribution(solAmount)
    const counters = await loadCounters()

    return json(res, 200, {
      ok: true,
      solAmount,
      signature,
      totalContributionsTracked: newTracked,
      walletsScanned: counters.walletsScanned,
      updatedAt: Date.now(),
    })
  } catch (error) {
    console.error('shield-contribution endpoint failed', error)
    return json(res, 500, { error: error?.message || 'Contribution tracking unavailable.' })
  }
}
