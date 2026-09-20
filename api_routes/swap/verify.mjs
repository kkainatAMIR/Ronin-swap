import { apiError, json, parseBody, RONIN_MINT } from '../../api/_lib/roninBackend.mjs'

const verificationCache = new Map()
const rateLimitWindowMs = 60_000
const maxRequestsPerWindow = 30
const rateLimitMap = new Map()

function isValidSignature(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(trimmed)
}

function isValidWallet(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)
}

function reqKey(req) {
  const forwardedFor = req.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) return forwardedFor.split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

function enforceRateLimit(req) {
  const key = reqKey(req)
  const now = Date.now()
  const record = rateLimitMap.get(key) || { count: 0, resetAt: now }
  if (now - record.resetAt > rateLimitWindowMs) {
    record.count = 0
    record.resetAt = now
  }
  record.count += 1
  rateLimitMap.set(key, record)
  return record.count <= maxRequestsPerWindow
}

function getSolanaRpcEndpoints() {
  const configured = process.env.SOLANA_RPC_URL || ''
  const heliusEndpoint = process.env.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(process.env.HELIUS_API_KEY)}`
    : ''
  const endpoints = [configured, heliusEndpoint, 'https://api.mainnet-beta.solana.com']
  return [...new Set(endpoints.filter(Boolean))]
}

async function rpcGetTransaction(signature) {
  const endpointCandidates = getSolanaRpcEndpoints()
  const requestBody = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'getTransaction',
    params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
  }

  const failures = []

  for (const endpoint of endpointCandidates) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(10_000),
      })

      const text = await response.text()
      let payload = null
      try { payload = text ? JSON.parse(text) : null } catch { payload = null }

      if (!response.ok) {
        failures.push(`RPC ${response.status}`)
        continue
      }

      if (!payload || typeof payload !== 'object') {
        failures.push('Malformed RPC payload')
        continue
      }

      if (payload.error) {
        if (String(payload.error.code) === '-32004' || /not found|missing/i.test(String(payload.error.message || ''))) {
          return { kind: 'not_found', detail: payload.error }
        }
        failures.push(payload.error.message || 'RPC error')
        continue
      }

      return { kind: 'ok', result: payload.result }
    } catch (error) {
      failures.push(error?.name === 'TimeoutError' ? 'RPC_TIMEOUT' : error?.message || 'RPC request failed')
    }
  }

  return { kind: 'rpc_error', detail: failures.join('; ') }
}

async function getTransactionWithRetry(signature) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await rpcGetTransaction(signature)
    if (response.kind !== 'ok' || response.result) return response
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return { kind: 'ok', result: null }
}

function parseTokenAmount(amountValue, decimals) {
  const raw = String(amountValue ?? '0')
  if (!raw || raw === '0') return { raw: '0', decimals: Number(decimals || 0) }
  const safeDecimals = Number(decimals || 0)
  return {
    raw: BigInt(raw).toString(),
    decimals: safeDecimals,
  }
}

function getAccountKeyMap(transaction) {
  const keys = transaction?.transaction?.message?.accountKeys || []
  return new Map(keys.map((keyEntry, index) => [String(index), String(keyEntry?.pubkey || keyEntry || '')]))
}

function normalizeTokenBalanceEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const rawAmount = entry?.uiTokenAmount?.amount ?? entry?.amount ?? '0'
  const decimals = Number(entry?.uiTokenAmount?.decimals ?? entry?.decimals ?? 0)
  return {
    accountIndex: Number(entry.accountIndex ?? -1),
    mint: String(entry.mint || ''),
    owner: String(entry.owner || ''),
    amount: String(rawAmount),
    decimals,
  }
}

function buildWalletBalanceDeltas(transaction, wallet) {
  const rawChanges = []
  const preTokenBalances = Array.isArray(transaction?.meta?.preTokenBalances) ? transaction.meta.preTokenBalances : []
  const postTokenBalances = Array.isArray(transaction?.meta?.postTokenBalances) ? transaction.meta.postTokenBalances : []
  const preByIndex = new Map()
  const postByIndex = new Map()
  for (const entry of preTokenBalances) {
    const normalized = normalizeTokenBalanceEntry(entry)
    if (!normalized || normalized.accountIndex < 0) continue
    preByIndex.set(String(normalized.accountIndex), normalized)
  }

  for (const entry of postTokenBalances) {
    const normalized = normalizeTokenBalanceEntry(entry)
    if (!normalized || normalized.accountIndex < 0) continue
    postByIndex.set(String(normalized.accountIndex), normalized)
  }

  const accountIndexes = new Set([...preByIndex.keys(), ...postByIndex.keys()])
  for (const accountIndex of accountIndexes) {
    const before = preByIndex.get(accountIndex)
    const normalized = postByIndex.get(accountIndex)
    const balance = normalized || before
    const isWalletAccount = normalized?.owner === wallet || before?.owner === wallet
    if (!isWalletAccount) continue
    const beforeAmount = BigInt(before?.amount || '0')
    const afterAmount = BigInt(normalized?.amount || '0')
    const delta = afterAmount - beforeAmount
    if (delta === 0n) continue
    rawChanges.push({
      mint: balance?.mint || '',
      owner: normalized?.owner || before?.owner || '',
      delta,
      decimals: normalized?.decimals || before?.decimals || 0,
      kind: 'token',
    })
  }

  const accountKeys = transaction?.transaction?.message?.accountKeys || []
  const walletIndex = accountKeys.findIndex((key) => String(key?.pubkey || key || '') === wallet)
  const preBalances = Array.isArray(transaction?.meta?.preBalances) ? transaction.meta.preBalances : []
  const postBalances = Array.isArray(transaction?.meta?.postBalances) ? transaction.meta.postBalances : []
  if (walletIndex >= 0) {
    const preLamports = BigInt(preBalances[walletIndex] ?? '0')
    const postLamports = BigInt(postBalances[walletIndex] ?? '0')
    const delta = postLamports - preLamports
    if (delta !== 0n) {
      rawChanges.push({ mint: 'So11111111111111111111111111111111111111112', owner: wallet, delta, decimals: 9, kind: 'sol' })
    }
  }

  return rawChanges
}

function pickSwapSides(rawChanges) {
  let input = { mint: null, amountRaw: '0', decimals: 0 }
  let output = { mint: null, amountRaw: '0', decimals: 0 }

  for (const change of rawChanges) {
    if (change.delta < 0n) {
      const absolute = change.delta * -1n
      if (!input.mint || absolute > (BigInt(input.amountRaw || '0') || 0n)) {
        input = { mint: change.mint, amountRaw: absolute.toString(), decimals: Number(change.decimals || 0) }
      }
    }
    if (change.delta > 0n) {
      if (!output.mint || change.delta > BigInt(output.amountRaw || '0')) {
        output = { mint: change.mint, amountRaw: change.delta.toString(), decimals: Number(change.decimals || 0) }
      }
    }
  }

  return { input, output }
}

function normalizeTransactionResult(signature, wallet, result, details = {}) {
  const timestamp = result?.blockTime ? new Date(result.blockTime * 1000).toISOString() : null
  const slot = Number(result?.slot ?? details.slot ?? 0)
  const accountKeys = result?.transaction?.message?.accountKeys || []
  const isSigner = accountKeys.some((keyEntry) => {
    const key = String(keyEntry?.pubkey || keyEntry || '')
    return key === wallet && keyEntry?.signer === true
  })
  const rawChanges = buildWalletBalanceDeltas(result, wallet)
  const { input, output } = pickSwapSides(rawChanges)

  if (!isSigner) {
    return {
      verified: false,
      status: 'failed',
      reason: 'WALLET_MISMATCH',
      signature,
      wallet,
      timestamp,
      slot,
      input: input.mint ? { mint: input.mint, amountRaw: input.amountRaw, decimals: input.decimals } : null,
      output: output.mint ? { mint: output.mint, amountRaw: output.amountRaw, decimals: output.decimals } : null,
    }
  }

  if (result?.meta?.err) {
    return {
      verified: false,
      status: 'failed',
      reason: 'TRANSACTION_FAILED',
      signature,
      wallet,
      timestamp,
      slot,
      input: input.mint ? { mint: input.mint, amountRaw: input.amountRaw, decimals: input.decimals } : null,
      output: output.mint ? { mint: output.mint, amountRaw: output.amountRaw, decimals: output.decimals } : null,
    }
  }

  if (!input.mint || !output.mint || !Number.isFinite(slot) || slot <= 0) {
    return {
      verified: false,
      status: 'pending',
      reason: 'TRANSACTION_PENDING',
      signature,
      wallet,
      timestamp,
      slot,
      input: input.mint ? { mint: input.mint, amountRaw: input.amountRaw, decimals: input.decimals } : null,
      output: output.mint ? { mint: output.mint, amountRaw: output.amountRaw, decimals: output.decimals } : null,
    }
  }

  return {
    verified: true,
    status: 'confirmed',
    signature,
    wallet,
    timestamp,
    slot,
    input: { mint: input.mint, amountRaw: input.amountRaw, decimals: input.decimals },
    output: { mint: output.mint, amountRaw: output.amountRaw, decimals: output.decimals },
  }
}

export async function verifySwapSignature(signature, wallet) {
  const cacheKey = `${signature}:${wallet}`
  const cached = verificationCache.get(cacheKey)
  if (cached) return { status: 200, result: cached }

  const rpcResult = await getTransactionWithRetry(signature)
  if (rpcResult.kind === 'not_found') {
    const response = { verified: false, status: 'not_found', reason: 'TRANSACTION_NOT_FOUND', signature, wallet }
    verificationCache.set(cacheKey, response)
    return { status: 200, result: response }
  }
  if (rpcResult.kind === 'rpc_error') {
    const response = { verified: false, status: 'error', reason: 'RPC_UNAVAILABLE', signature, wallet, detail: rpcResult.detail }
    verificationCache.set(cacheKey, response)
    return { status: 502, result: response }
  }

  const result = rpcResult.result
  if (!result) {
    const response = { verified: false, status: 'pending', reason: 'TRANSACTION_PENDING', signature, wallet }
    verificationCache.set(cacheKey, response)
    return { status: 200, result: response }
  }

  const normalized = normalizeTransactionResult(signature, wallet, result)
  verificationCache.set(cacheKey, normalized)
  return { status: 200, result: normalized }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')

  if (!enforceRateLimit(req)) {
    return apiError(res, 429, 'RATE_LIMITED', 'Too many verification requests. Please wait a moment and try again.')
  }

  const body = parseBody(req)
  const signature = typeof body?.signature === 'string' ? body.signature.trim() : ''
  const wallet = typeof body?.wallet === 'string' ? body.wallet.trim() : ''

  if (!signature || !isValidSignature(signature)) {
    return json(res, 400, { verified: false, status: 'invalid_signature', reason: 'INVALID_SIGNATURE', signature, wallet })
  }
  if (!wallet || !isValidWallet(wallet)) {
    return json(res, 400, { verified: false, status: 'invalid_wallet', reason: 'INVALID_WALLET', signature, wallet })
  }

  const verification = await verifySwapSignature(signature, wallet)
  return json(res, verification.status, verification.result)
}

export { RONIN_MINT }