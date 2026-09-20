import { RONIN_MINT } from '../../api/_lib/roninBackend.mjs'

const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env
const DEFAULT_BURN_ADDRESS = '9jRsw55MwR5L8yTneLLjWNfjdThX4v687CuHo7moRUCi'
const HELIUS_API_KEY = runtimeEnv.HELIUS_API_KEY || ''
const RONIN_BURN_ADDRESS = runtimeEnv.RONIN_BURN_ADDRESS || DEFAULT_BURN_ADDRESS
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
const HELIUS_ENHANCED = 'https://api.helius.xyz/v0'
const BURN_PAGE_SIZE = 100
const MAX_BURN_PAGES = Math.max(1, Number(runtimeEnv.RONIN_BURN_MAX_PAGES || 10))
const BURN_REQUEST_TIMEOUT_MS = 8_000

function json(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store, max-age=0')
  return res.json(body)
}

async function heliusRpc(method, params) {
  if (!HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is not configured.')
  const response = await fetch(HELIUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  if (!response.ok) throw new Error(`Helius RPC returned ${response.status}.`)
  const payload = await response.json()
  if (payload.error) throw new Error(payload.error.message || 'Helius RPC request failed.')
  return payload.result
}

function rawToUiAmount(rawAmount, decimals) {
  const raw = typeof rawAmount === 'bigint' ? rawAmount : BigInt(rawAmount || 0)
  return Number(raw) / (10 ** Number(decimals || 0))
}

function uiAmountToRaw(uiAmount, decimals) {
  if (uiAmount == null || uiAmount === '') return 0n
  const clean = String(uiAmount).replace(/^\+/, '')
  if (!/^\d+(?:\.\d+)?$/.test(clean)) return 0n
  const [whole, fraction = ''] = clean.split('.')
  const decimalCount = Number(decimals || 0)
  const paddedFraction = fraction.slice(0, decimalCount).padEnd(decimalCount, '0')
  return BigInt(`${whole}${paddedFraction}` || '0')
}

function transferRawAmount(transfer, fallbackDecimals) {
  const raw = transfer?.rawTokenAmount?.tokenAmount
  if (raw != null && /^\d+$/.test(String(raw))) return BigInt(String(raw))
  return uiAmountToRaw(transfer?.tokenAmount, transfer?.rawTokenAmount?.decimals ?? fallbackDecimals)
}

async function getSupply() {
  const result = await heliusRpc('getTokenSupply', [RONIN_MINT, { commitment: 'confirmed' }])
  const tokenAmount = result?.value
  if (!tokenAmount) throw new Error('Token supply was not returned.')
  const decimals = Number(tokenAmount.decimals || 0)
  const rawAmount = String(tokenAmount.amount || '0')
  return {
    amount: Number(tokenAmount.uiAmountString || tokenAmount.uiAmount || rawToUiAmount(rawAmount, decimals)),
    rawAmount,
    decimals,
    updatedAt: Date.now(),
    source: 'Helius Solana mainnet RPC',
  }
}

async function getHolders() {
  let cursor = null
  let pages = 0
  const owners = new Set()

  do {
    const params = {
      mint: RONIN_MINT,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
      options: { showZeroBalance: false },
    }
    const result = await heliusRpc('getTokenAccounts', params)
    for (const account of result?.token_accounts || []) {
      if (Number(account?.amount || 0) > 0 && account?.owner) owners.add(account.owner)
    }
    cursor = result?.cursor || null
    pages += 1
  } while (cursor && pages < 50)

  return {
    count: owners.size,
    complete: !cursor,
    source: 'Helius indexed token accounts',
  }
}

/**
 * Read the configured ecosystem burn wallet directly from Solana. Tokens
 * held by this address are intentionally removed from circulation; this
 * balance is global and has no relationship to the visitor's wallet.
 */
async function getBurnWalletBalance(decimals) {
  const result = await heliusRpc('getTokenAccountsByOwner', [
    RONIN_BURN_ADDRESS,
    { mint: RONIN_MINT },
    { encoding: 'jsonParsed' },
  ])

  let rawAmount = 0n
  for (const account of result?.value || []) {
    const tokenAmount = account?.account?.data?.parsed?.info?.tokenAmount
    if (tokenAmount?.amount != null) rawAmount += BigInt(tokenAmount.amount)
  }

  return {
    rawAmount: rawAmount.toString(),
    amount: rawToUiAmount(rawAmount, decimals),
    address: RONIN_BURN_ADDRESS,
    source: 'Helius Solana mainnet RPC burn-wallet balance',
  }
}

function nextBeforeSignature(message = '') {
  return message.match(/`before-signature`\s+(?:parameter\s+)?set\s+to\s+([A-Za-z0-9]+)/i)?.[1]
    || message.match(/before-signature(?:`)?\s+(?:parameter\s+)?set\s+to\s+([A-Za-z0-9]+)/i)?.[1]
}

/**
 * Sum every successful SPL BURN event for the RONIN mint. This is a global
 * scan keyed by the mint, never by the connected browser wallet. The history
 * is paged to exhaustion so the returned value is not just a recent-window
 * estimate. A safety limit fails closed rather than returning a partial sum.
 */
async function getBurnHistory(decimals) {
  if (!HELIUS_API_KEY) throw new Error('HELIUS_API_KEY is not configured.')

  const events = []
  const seenSignatures = new Set()
  let beforeSignature = null
  let totalBurnedRaw = 0n
  let pages = 0
  let complete = false

  while (pages < MAX_BURN_PAGES) {
    const params = new URLSearchParams({
      'api-key': HELIUS_API_KEY,
      type: 'BURN',
      limit: String(BURN_PAGE_SIZE),
    })
    if (beforeSignature) params.set('before-signature', beforeSignature)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), BURN_REQUEST_TIMEOUT_MS)
    let response
    try {
      response = await fetch(`${HELIUS_ENHANCED}/addresses/${RONIN_MINT}/transactions?${params.toString()}`, { signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
    const data = await response.json().catch(() => null)
    pages += 1

    if (!response.ok) {
      const message = typeof data?.error === 'string'
        ? data.error
        : data?.error?.message || ''
      const suggestedBefore = nextBeforeSignature(message)

      // Helius can return a 404 when a filtered page has no matching event.
      // Its error may include a cursor that lets us continue to older history.
      if (suggestedBefore && suggestedBefore !== beforeSignature) {
        beforeSignature = suggestedBefore
        continue
      }
      if (response.status === 404) {
        complete = true
        break
      }
      throw new Error(`Helius burn history returned ${response.status}: ${message || 'request failed'}`)
    }

    if (!Array.isArray(data)) throw new Error('Helius burn history returned an invalid response.')
    if (!data.length) {
      complete = true
      break
    }

    for (const tx of data) {
      if (!tx?.signature || seenSignatures.has(tx.signature)) continue
      seenSignatures.add(tx.signature)
      if (tx.transactionError || tx.type !== 'BURN') continue

      const transfers = (tx.tokenTransfers || []).filter((item) => item?.mint === RONIN_MINT)
      if (!transfers.length) continue

      let eventRawAmount = 0n
      let eventDecimals = decimals
      let eventWallet = tx.feePayer || null
      for (const transfer of transfers) {
        const transferDecimals = Number(transfer?.rawTokenAmount?.decimals ?? decimals)
        const amountRaw = transferRawAmount(transfer, transferDecimals)
        if (amountRaw <= 0n) continue
        eventDecimals = transferDecimals
        eventWallet = transfer.fromUserAccount || eventWallet

        // A token already represented by the configured dead/burn wallet must
        // not be counted a second time if Helius classifies a route to or
        // from that wallet as a BURN event.
        const usesConfiguredBurnWallet = transfer.fromUserAccount === RONIN_BURN_ADDRESS
          || transfer.toUserAccount === RONIN_BURN_ADDRESS
        if (!usesConfiguredBurnWallet) {
          totalBurnedRaw += amountRaw
          eventRawAmount += amountRaw
        }
      }
      if (eventRawAmount <= 0n) continue

      events.push({
        signature: tx.signature,
        timestamp: tx.timestamp ? tx.timestamp * 1000 : null,
        wallet: eventWallet,
        amount: rawToUiAmount(eventRawAmount, eventDecimals),
        rawAmount: eventRawAmount.toString(),
      })
    }

    const lastSignature = data[data.length - 1]?.signature || null
    if (!lastSignature || lastSignature === beforeSignature) {
      complete = true
      break
    }
    beforeSignature = lastSignature
  }

  if (!complete) {
    throw new Error(`Global RONIN burn history exceeded the ${MAX_BURN_PAGES}-page safety limit; refusing to return a partial total.`)
  }

  return {
    rawAmount: totalBurnedRaw.toString(),
    amount: rawToUiAmount(totalBurnedRaw, decimals),
    events: events.slice(0, 12),
    complete: true,
    pages,
    source: 'Helius enhanced global SPL BURN history',
  }
}

async function getGlobalBurns(decimals) {
  const [historyResult, burnWalletResult] = await Promise.allSettled([
    getBurnHistory(decimals),
    getBurnWalletBalance(decimals),
  ])
  const burnWallet = burnWalletResult.status === 'fulfilled' ? burnWalletResult.value : null
  if (historyResult.status !== 'fulfilled') {
    console.warn('RONIN historical burn scan unavailable:', historyResult.reason?.message || historyResult.reason)
    return {
      burned: null,
      burnedRaw: null,
      burnHistoryBurned: null,
      burnHistoryBurnedRaw: null,
      burnWalletBalance: burnWallet?.amount ?? null,
      burnWalletBalanceRaw: burnWallet?.rawAmount ?? null,
      burnWalletAddress: burnWallet?.address || RONIN_BURN_ADDRESS,
      events: [],
      complete: false,
      source: 'RONIN supply and burn-wallet data available; historical burn scan incomplete',
    }
  }
  if (!burnWallet) throw new Error('RONIN burn-wallet balance unavailable.')
  const history = historyResult.value
  const historyRaw = BigInt(history.rawAmount)
  const burnWalletRaw = BigInt(burnWallet.rawAmount)
  const totalRaw = historyRaw + burnWalletRaw

  return {
    burned: rawToUiAmount(totalRaw, decimals),
    burnedRaw: totalRaw.toString(),
    burnHistoryBurned: history.amount,
    burnHistoryBurnedRaw: history.rawAmount,
    burnWalletBalance: burnWallet.amount,
    burnWalletBalanceRaw: burnWallet.rawAmount,
    burnWalletAddress: burnWallet.address,
    events: history.events,
    complete: history.complete,
    source: 'Helius global on-chain burns: SPL burn history + configured burn-wallet balance',
  }
}

async function getDex() {
  const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${RONIN_MINT}`)
  if (!response.ok) throw new Error(`DexScreener returned ${response.status}.`)
  const data = await response.json()
  const pairs = data?.pairs || []
  if (!pairs.length) return null
  const best = [...pairs].sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
  return {
    priceUsd: best.priceUsd ? Number(best.priceUsd) : null,
    priceNative: best.priceNative ? Number(best.priceNative) : null,
    volume24h: best.volume?.h24 ? Number(best.volume.h24) : null,
    transactions24h: Number(best.txns?.h24?.buys || 0) + Number(best.txns?.h24?.sells || 0),
    volume6h: best.volume?.h6 ? Number(best.volume.h6) : null,
    liquidityUsd: best.liquidity?.usd ? Number(best.liquidity.usd) : null,
    marketCap: best.marketCap ? Number(best.marketCap) : best.fdv ? Number(best.fdv) : null,
    fdv: best.fdv ? Number(best.fdv) : null,
    pairAddress: best.pairAddress,
    dexId: best.dexId,
    url: best.url,
    updatedAt: Date.now(),
    source: 'DexScreener',
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' })

  try {
    const supply = await getSupply()
    const [holders, burns, dex] = await Promise.all([
      getHolders().catch((error) => {
        // Holder indexing is ancillary. Do not let it hide a valid global
        // burn total from the dashboard.
        console.warn('RONIN holder index read failed:', error)
        return { count: null, complete: false, source: null }
      }),
      getGlobalBurns(supply.decimals),
      getDex().catch((error) => {
        console.warn('RONIN DexScreener read failed:', error)
        return null
      }),
    ])

    return json(res, 200, {
      mint: RONIN_MINT,
      supply,
      holdersCount: holders.count,
      holdersComplete: holders.complete,
      burned: burns.burned,
      burnedRaw: burns.burnedRaw,
      burnHistoryBurned: burns.burnHistoryBurned,
      burnHistoryBurnedRaw: burns.burnHistoryBurnedRaw,
      burnWalletBalance: burns.burnWalletBalance,
      burnWalletBalanceRaw: burns.burnWalletBalanceRaw,
      burnWalletAddress: burns.burnWalletAddress,
      burnsComplete: burns.complete,
      burnHistory: burns.events,
      dex,
      updatedAt: Date.now(),
      source: burns.source,
    })
  } catch (error) {
    console.error('RONIN stats endpoint failed:', error)
    const status = /429|rate limit|quota/i.test(error?.message || '') ? 503 : 500
    return json(res, status, { error: error?.message || 'Live RONIN stats unavailable.', code: status === 503 ? 'RPC_QUOTA_EXCEEDED' : 'RONIN_STATS_UNAVAILABLE' })
  }
}
