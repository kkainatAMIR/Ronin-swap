import { json } from '../../api/_lib/roninBackend.mjs'
import { isValidPublicKey } from '../../api/_lib/solanaValidation.mjs'

const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env
const TREASURY_ADDRESS = runtimeEnv.RONIN_SHIELD_TREASURY_ADDRESS
  || runtimeEnv.RONIN_SHIELD_TREASURY
  || runtimeEnv.VITE_RONIN_SHIELD_TREASURY
  || ''
const HELIUS_API_KEY = runtimeEnv.HELIUS_API_KEY || ''
const HELIUS_ENHANCED = 'https://api.helius.xyz/v0'
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com'

async function rpc(method, params) {
  const heliusEndpoint = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(HELIUS_API_KEY)}` : ''
  const endpoints = [runtimeEnv.SOLANA_RPC_URL, heliusEndpoint, DEFAULT_RPC_URL]
    .filter((endpoint, index, values) => endpoint && values.indexOf(endpoint) === index)
  const failures = []

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      })
      const text = await response.text()
      let payload
      try { payload = text ? JSON.parse(text) : null } catch { throw new Error(text || `HTTP ${response.status}`) }
      if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `HTTP ${response.status}`)
      return payload.result
    } catch (error) {
      failures.push(error?.message || 'request failed')
    }
  }

  throw new Error(`Solana RPC unavailable: ${failures.join('; ')}`)
}

async function getContributionTotal() {
  if (!HELIUS_API_KEY) return { sol: null, lamports: null, source: 'Treasury total requires HELIUS_API_KEY.' }
  try {
    let before = ''
    let lamports = 0
    let pages = 0
    while (pages < 100) {
      const params = new URLSearchParams({ 'api-key': HELIUS_API_KEY, limit: '100' })
      if (before) params.set('before', before)
      const response = await fetch(`${HELIUS_ENHANCED}/addresses/${TREASURY_ADDRESS}/transactions?${params}`)
      if (!response.ok) throw new Error(`Treasury history returned HTTP ${response.status}.`)
      const transactions = await response.json()
      if (!Array.isArray(transactions) || !transactions.length) break
      for (const transaction of transactions) {
        for (const transfer of transaction.nativeTransfers || []) {
          if (transfer.toUserAccount === TREASURY_ADDRESS && Number.isFinite(Number(transfer.amount))) {
            lamports += Number(transfer.amount)
          }
        }
      }
      before = transactions[transactions.length - 1]?.signature || ''
      if (!before || transactions.length < 100) break
      pages += 1
    }
    return { sol: lamports / 1_000_000_000, lamports, source: 'Helius enhanced transaction history' }
  } catch (error) {
    console.warn('RONIN Shield contribution history unavailable:', error)
    return { sol: null, lamports: null, source: error?.message || 'Contribution history unavailable.' }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' })
  if (!isValidPublicKey(TREASURY_ADDRESS)) {
    return json(res, 503, { error: 'RONIN_SHIELD_TREASURY_ADDRESS is not configured with a valid Solana address.' })
  }

  try {
    const contributions = await getContributionTotal()
    const balance = await rpc('getBalance', [TREASURY_ADDRESS, { commitment: 'confirmed' }])
    return json(res, 200, {
      treasuryAddress: TREASURY_ADDRESS,
      treasuryBalanceSol: Number(balance?.value || 0) / 1_000_000_000,
      totalContributedSol: contributions.sol,
      totalContributedSource: contributions.source,
      updatedAt: Date.now(),
    })
  } catch (error) {
    console.error('RONIN Shield stats failed:', error)
    return json(res, 502, { error: error?.message || 'RONIN Shield public stats are unavailable.' })
  }
}
