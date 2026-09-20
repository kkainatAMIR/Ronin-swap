import { RONIN_MINT as MINT } from '../../api/_lib/roninBackend.mjs'

const DEFAULT_BURN_ADDRESS = '9jRsw55MwR5L8yTneLLjWNfjdThX4v687CuHo7moRUCi'
const API_KEY = process.env.HELIUS_API_KEY || ''
const BURN_ADDRESS = process.env.RONIN_BURN_ADDRESS || DEFAULT_BURN_ADDRESS
const RPC = `https://mainnet.helius-rpc.com/?api-key=${API_KEY}`

function json(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store, max-age=0')
  return res.json(body)
}

async function rpc(method, params) {
  if (!API_KEY) throw new Error('HELIUS_API_KEY is not configured.')
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `Helius RPC returned ${response.status}.`)
  return payload.result
}

function tokenBalance(tx, address) {
  const pre = tx?.meta?.preTokenBalances || []
  const post = tx?.meta?.postTokenBalances || []
  const byIndex = new Map()
  for (const item of pre) byIndex.set(`${item.accountIndex}:pre`, item)
  for (const item of post) byIndex.set(`${item.accountIndex}:post`, item)
  let burned = 0n
  let decimals = 6
  for (const item of byIndex.values()) {
    if (item.mint !== MINT) continue
    decimals = Number(item.uiTokenAmount?.decimals ?? decimals)
    const preAmount = BigInt(pre.find((x) => x.accountIndex === item.accountIndex && x.mint === MINT)?.uiTokenAmount?.amount || '0')
    const postAmount = BigInt(post.find((x) => x.accountIndex === item.accountIndex && x.mint === MINT)?.uiTokenAmount?.amount || '0')
    if (preAmount > postAmount) burned += preAmount - postAmount
  }
  return { burned, decimals }
}

function uiAmount(raw, decimals) {
  return Number(raw) / 10 ** decimals
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' })
  try {
    const signatures = await rpc('getSignaturesForAddress', [BURN_ADDRESS, { limit: 20, commitment: 'confirmed' }])
    const latest = []
    for (const item of signatures || []) {
      if (item?.err) continue
      const tx = await rpc('getTransaction', [item.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null)
      if (!tx?.meta || tx.meta.err) continue
      const result = tokenBalance(tx, BURN_ADDRESS)
      if (result.burned <= 0n) continue
      latest.push({
        signature: item.signature,
        timestamp: tx.blockTime ? tx.blockTime * 1000 : null,
        wallet: tx.transaction?.message?.accountKeys?.find((key) => key.signer)?.pubkey || null,
        amount: uiAmount(result.burned, result.decimals),
        rawAmount: result.burned.toString(),
      })
      if (latest.length >= 10) break
    }
    return json(res, 200, {
      mint: MINT,
      burnAddress: BURN_ADDRESS,
      events: latest,
      source: 'Helius Solana RPC burn-address transaction history',
      updatedAt: Date.now(),
    })
  } catch (error) {
    console.error('RONIN burn history endpoint failed:', error)
    return json(res, 500, { error: error?.message || 'Live burn history unavailable.' })
  }
}
