const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'
const ALLOWED_METHODS = new Set([
  'getBalance',
  'getTokenAccountsByOwner',
  'getTokenLargestAccounts',
  'getTokenSupply',
  'getSignaturesForAddress',
  'getTransaction',
  'getLatestBlockhash',
  'getSignatureStatuses',
  'getBlockHeight',
  'sendTransaction',
])
const RPC_TIMEOUT_MS = 10_000

// Use globalThis.__RONIN_LOCAL_ENV__ (set by Vite's localApiPlugin) with
// process.env fallback — same pattern as supabaseBackend.mjs. This is
// critical for Vite dev SSR, where process.env is not reliably populated.
const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

function json(res, status, body) {
  res.status(status)
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  return res.json(body)
}

function parseBody(req) {
  if (!req.body) return null
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) } catch { return null }
  }
  return req.body
}

function endpointLabel(endpoint) {
  try { return new URL(endpoint).hostname } catch { return 'configured endpoint' }
}

function rpcEndpoints() {
  const heliusEndpoint = runtimeEnv.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(runtimeEnv.HELIUS_API_KEY)}`
    : ''
  return [runtimeEnv.SOLANA_RPC_URL, heliusEndpoint, DEFAULT_RPC_URL]
    .filter((endpoint, index, endpoints) => endpoint && endpoints.indexOf(endpoint) === index)
}

async function callRpc(endpoint, requestBody) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload = null
    try { payload = text ? JSON.parse(text) : null } catch { /* handled below */ }
    return { response, payload }
  } finally {
    clearTimeout(timeout)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' })

  const body = parseBody(req)
  if (!body || typeof body.method !== 'string' || !ALLOWED_METHODS.has(body.method) || !Array.isArray(body.params)) {
    return json(res, 400, { error: 'A supported Solana JSON-RPC method and params array are required.' })
  }

  const requestBody = {
    jsonrpc: '2.0',
    id: body.id ?? Date.now(),
    method: body.method,
    params: body.params,
  }
  const failures = []

  for (const endpoint of rpcEndpoints()) {
    const label = endpointLabel(endpoint)
    try {
      const { response, payload } = await callRpc(endpoint, requestBody)
      if (!response.ok) {
        failures.push(`${label} returned HTTP ${response.status}`)
        continue
      }
      if (!payload || typeof payload !== 'object') {
        failures.push(`${label} returned an invalid JSON-RPC response`)
        continue
      }
      // Keep JSON-RPC application errors intact. The browser client can show
      // the actual RPC message instead of mistaking it for a transport error.
      return json(res, 200, payload)
    } catch (error) {
      failures.push(`${label}: ${error.name === 'AbortError' ? `timed out after ${RPC_TIMEOUT_MS / 1000}s` : error.message || 'request failed'}`)
    }
  }

  console.error(`Solana RPC proxy failed for ${body.method}:`, failures.join('; '))
  return json(res, 502, {
    error: `No server-side Solana RPC endpoint responded for ${body.method}.`,
    attempts: failures,
  })
}
