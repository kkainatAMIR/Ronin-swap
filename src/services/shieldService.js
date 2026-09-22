// Single source of truth for the $RONIN mint — imported from the shared
// config so this service can never drift from the rest of the frontend.
import { RONIN_MINT } from '../data'
import {
  RISK_LEVELS,
  SECURITY_REGISTRY,
  detectImpersonationRisk,
  evaluateTokenRisk,
  evaluateWalletRisk,
  computeShieldStatus,
} from './securityRiskService'

export { RONIN_MINT }
const RPC_ENDPOINTS = [
  '/api/solana/rpc',
].filter((url, i, arr) => arr.indexOf(url) === i)

async function rpcRequest(method, params, timeoutMs = 15000) {
  let lastError
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        signal: controller.signal,
      })
      clearTimeout(t)
      if (!res.ok) throw new Error(`RPC ${res.status}`)
      const payload = await res.json()
      if (payload.error) throw new Error(payload.error.message || 'RPC error')
      return payload.result
    } catch (e) {
      lastError = e
    }
  }
  throw lastError || new Error('No RPC responded')
}

// --- SOL BALANCE ---
export async function getSolBalance(owner) {
  if (!owner) throw new Error('Wallet address required')
  const result = await rpcRequest('getBalance', [owner])
  const lamports = result?.value ?? result ?? 0
  const sol = lamports / 1e9
  return {
    lamports: typeof lamports === 'number' ? lamports : Number(lamports) || 0,
    sol,
    updatedAt: Date.now(),
  }
}

// --- TOKEN ACCOUNTS (all SPL) ---
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' // official Token-2022

async function fetchTokenAccountsForProgram(owner, programId) {
  try {
    const res = await rpcRequest('getTokenAccountsByOwner', [
      owner,
      { programId },
      { encoding: 'jsonParsed' },
    ])
    return res?.value || []
  } catch (e) {
    console.warn(`getTokenAccountsByOwner failed for program ${programId}`, e)
    return []
  }
}

const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112'

// Helius "Wallet Balances" API (v1) — the currently-supported replacement for the
// retired v0/addresses/{owner}/balances and v0/tokens/metadata endpoints, which now
// both return JSON-RPC error bodies (HTTP 200) instead of data and were previously
// being silently swallowed here. This single endpoint returns balance + symbol +
// name + logo in one call, for both spl-token and token-2022 mints.
async function fetchAssetMetadata(mint) {
  try {
    const asset = await rpcRequest('getAsset', [mint])
    const metadata = asset?.content?.metadata || {}
    const links = asset?.content?.links || {}
    const image = links.image || (Array.isArray(asset?.content?.files) ? asset.content.files.find((file) => file?.uri)?.uri : null) || null
    return {
      name: metadata.name || asset?.token_info?.symbol || null,
      symbol: metadata.symbol || null,
      logo: image,
    }
  } catch {
    return null
  }
}

export async function getAllTokenAccounts(owner) {
  if (!owner) throw new Error('Wallet address required')

  const [acc1, acc2] = await Promise.all([
    fetchTokenAccountsForProgram(owner, TOKEN_PROGRAM_ID),
    fetchTokenAccountsForProgram(owner, TOKEN_2022_PROGRAM_ID),
  ])

  let heliusTokens = new Map()
  let heliusOk = false
  try {
    const response = await fetch(`/api/solana/enhanced?resource=balances&owner=${encodeURIComponent(owner)}&limit=100`)
    if (response.ok) {
      const data = await response.json()
      heliusOk = true
      for (const t of data?.balances || []) {
        if (!t?.mint || t.mint === NATIVE_SOL_MINT) continue
        heliusTokens.set(t.mint, {
          mint: t.mint,
          symbol: t.symbol || null,
          name: t.name || null,
          logo: t.logoUri || null,
          decimals: t.decimals,
          uiAmount: t.balance,
          tokenProgram: t.tokenProgram,
        })
      }
    }
  } catch {}

  const allRaw = [...acc1, ...acc2]
  const parsed = allRaw.map((acc) => {
    const info = acc?.account?.data?.parsed?.info
    const tokenAmount = info?.tokenAmount
    const mint = info?.mint
    const meta = mint ? heliusTokens.get(mint) : null
    return {
      pubkey: acc?.pubkey,
      mint,
      owner: info?.owner,
      amount: tokenAmount?.amount,
      decimals: tokenAmount?.decimals,
      uiAmount: tokenAmount?.uiAmount,
      uiAmountString: tokenAmount?.uiAmountString,
      name: meta?.name || null,
      symbol: meta?.symbol || null,
      logo: meta?.logo || null,
      raw: acc,
    }
  }).filter((t) => t.mint)

  // Merge in any mints Helius reports that the direct RPC calls missed
  // (e.g. a transient RPC hiccup on one of the two token programs).
  const mintSet = new Set(parsed.map((p) => p.mint))
  for (const [mint, ht] of heliusTokens) {
    if (!mintSet.has(mint)) {
      parsed.push({
        pubkey: null,
        mint,
        owner,
        amount: null,
        decimals: ht.decimals,
        uiAmount: ht.uiAmount,
        uiAmountString: String(ht.uiAmount),
        name: ht.name,
        symbol: ht.symbol,
        logo: ht.logo,
        helius: true,
      })
    }
  }

  const unresolvedMints = parsed
    .filter((token) => !token.name && !token.symbol && !token.logo)
    .map((token) => token.mint)
  if (unresolvedMints.length) {
    const metadataEntries = await Promise.all(unresolvedMints.map(async (mint) => [mint, await fetchAssetMetadata(mint)]))
    const metadataByMint = new Map(metadataEntries.filter(([, metadata]) => metadata))
    for (const token of parsed) {
      const metadata = metadataByMint.get(token.mint)
      if (metadata) {
        token.name = metadata.name
        token.symbol = metadata.symbol
        token.logo = metadata.logo
      }
    }
  }

  // If both the direct RPC lookups and the Helius fallback failed to produce any
  // data at all, surface that clearly instead of returning a silent empty list.
  const rpcFailed = acc1.length === 0 && acc2.length === 0
  const heliusFailed = !heliusOk
  const partial = rpcFailed && heliusFailed

  return {
    accounts: parsed,
    count: parsed.length,
    updatedAt: Date.now(),
    partial,
  }
}

// --- SIGNATURES / TRANSACTIONS ---
export async function getSignatures(owner, limit = 50) {
  if (!owner) throw new Error('Wallet address required')
  const result = await rpcRequest('getSignaturesForAddress', [owner, { limit }])
  return result || []
}

export async function getSignaturesPaginated(owner, maxBatches = 5, batchSize = 1000) {
  let all = []
  let before = undefined
  for (let i = 0; i < maxBatches; i++) {
    const opts = { limit: batchSize }
    if (before) opts.before = before
    const batch = await rpcRequest('getSignaturesForAddress', [owner, opts])
    if (!batch || !batch.length) break
    all = all.concat(batch)
    before = batch[batch.length - 1]?.signature
    if (batch.length < batchSize) break
  }
  return all
}

export async function getParsedTransaction(signature) {
  try {
    const tx = await rpcRequest('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }])
    return tx
  } catch {
    return null
  }
}

export async function getHeliusTransactions(owner, limit = 20) {
  try {
    const url = `/api/solana/enhanced?resource=transactions&owner=${encodeURIComponent(owner)}&limit=${encodeURIComponent(Math.min(100, Math.max(1, limit)))}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Helius tx ${res.status}`)
    const data = await res.json()
    if (Array.isArray(data)) return data
    return null
  } catch (e) {
    console.warn('Helius transactions failed', e)
    return null
  }
}

export async function getRecentTransactions(owner, limit = 20) {
  const helius = await getHeliusTransactions(owner, limit)
  if (helius && helius.length) {
    return {
      source: 'Helius',
      transactions: helius.map((tx) => ({
        signature: tx.signature,
        timestamp: tx.timestamp ? tx.timestamp * 1000 : (tx.blockTime ? tx.blockTime * 1000 : null),
        type: tx.type || tx.description || 'TRANSACTION',
        description: tx.description,
        status: tx.transactionError ? 'Failed' : 'Success',
        fee: tx.fee,
        feePayer: tx.feePayer,
        nativeTransfers: tx.nativeTransfers,
        tokenTransfers: tx.tokenTransfers,
        events: tx.events,
        raw: tx,
      })),
      updatedAt: Date.now(),
    }
  }

  const sigs = await getSignatures(owner, limit)
  const txs = []
  for (const sigInfo of sigs.slice(0, limit)) {
    const tx = await getParsedTransaction(sigInfo.signature)
    txs.push({
      signature: sigInfo.signature,
      timestamp: sigInfo.blockTime ? sigInfo.blockTime * 1000 : (tx?.blockTime ? tx.blockTime * 1000 : null),
      type: sigInfo.err ? 'Failed' : (tx?.transaction?.message?.instructions?.[0]?.parsed?.type || 'TRANSACTION'),
      status: sigInfo.err ? 'Failed' : 'Success',
      blockTime: sigInfo.blockTime,
      slot: sigInfo.slot,
      memo: sigInfo.memo,
      err: sigInfo.err,
      raw: tx,
      description: null,
    })
    await new Promise((r) => setTimeout(r, 80))
  }

  return {
    source: 'RPC',
    transactions: txs,
    updatedAt: Date.now(),
  }
}

// --- WALLET AGE ---
export async function getWalletAge(owner) {
  if (!owner) throw new Error('Wallet address required')
  try {
    const allSigs = await getSignaturesPaginated(owner, 5, 1000)
    if (!allSigs.length) {
      return { available: false, reason: 'No activity found' }
    }
    const withTime = allSigs.filter((s) => s.blockTime)
    if (!withTime.length) {
      return { available: false, reason: 'No timestamped activity' }
    }
    const oldest = withTime.reduce((a, b) => (a.blockTime < b.blockTime ? a : b))
    const firstDate = new Date(oldest.blockTime * 1000)
    const now = Date.now()
    const diffMs = now - firstDate.getTime()
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    return {
      available: true,
      days,
      firstActivity: firstDate,
      firstSignature: oldest.signature,
      totalSignaturesScanned: allSigs.length,
      isApproximate: allSigs.length >= 5000,
    }
  } catch (e) {
    console.warn('getWalletAge failed', e)
    return { available: false, reason: e.message }
  }
}

// --- SECURITY ANALYSIS ---
const KNOWN_MINTS = new Set([
  RONIN_MINT,
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
])

function getTokenRiskLevel(token) {
  const mint = normalizeAddress(token.mint)
  const isSolanaAsset = mint === NATIVE_SOL_MINT || /^(w?sol)$/i.test(String(token.symbol || '').trim()) || /^wrapped sol(ana)?$/i.test(String(token.name || '').trim())
  if (SECURITY_REGISTRY.blockedTokens[mint]) return { level: RISK_LEVELS.BLOCKED, label: '🔴 BLOCKED', reason: 'Blocked token registry entry' }
  if (SECURITY_REGISTRY.flaggedTokens[mint]) return { level: RISK_LEVELS.HIGH_RISK, label: '🟠 FLAGGED', reason: 'Flagged token in internal registry' }
  if (isSolanaAsset || KNOWN_MINTS.has(mint)) return { level: RISK_LEVELS.KNOWN, label: '🟢 KNOWN', reason: 'Recognized asset or trusted mint' }
  if (token.name && token.symbol) return { level: RISK_LEVELS.REVIEW, label: '🟡 REVIEW', reason: 'Unknown mint with metadata; needs verification' }
  if (token.name || token.symbol) return { level: RISK_LEVELS.LOW_RISK, label: '🟡 LOW RISK', reason: 'Partial metadata; risk remains unconfirmed' }
  return { level: RISK_LEVELS.REVIEW, label: '🟡 REVIEW', reason: 'Unknown token — no metadata' }
}

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase()
}

export function analyzeSecurity({ tokenAccounts, transactions, walletAge, solBalance }) {
  const tokens = tokenAccounts?.accounts || []
  const txs = transactions?.transactions || []
  const findings = []
  const walletTokens = []

  let knownCount = 0
  let reviewCount = 0
  let blockedCount = 0
  const tokenRisks = []

  for (const token of tokens) {
    const normalizedMint = normalizeAddress(token.mint)
    const impersonation = detectImpersonationRisk(token, TOKEN_BY_MINT)
    const risk = evaluateTokenRisk({
      chain: 'solana',
      mint: normalizedMint,
      symbol: token.symbol,
      name: token.name,
      authorities: token.authorities || {},
      metadata: { ...(token.metadata || {}), name: token.name, symbol: token.symbol },
      flagged: Boolean(token.flagged),
      blocked: Boolean(token.blocked),
    })

    if (impersonation) findings.push(impersonation)
    if (risk?.findings?.length) findings.push(...risk.findings)

    const derivedRisk = getTokenRiskLevel(token)
    tokenRisks.push({ ...token, risk: derivedRisk })
    walletTokens.push({ ...token, risk: derivedRisk })

    if (derivedRisk.level === RISK_LEVELS.KNOWN) knownCount++
    else {
      reviewCount++
      if (derivedRisk.level === RISK_LEVELS.BLOCKED) blockedCount++
    }
  }

  const failedTxs = txs.filter((tx) => tx.status === 'Failed' || tx.err).length
  const totalTxs = txs.length

  if (failedTxs > 0) {
    findings.push({
      category: 'FAILED_TRANSACTIONS',
      severity: 'MEDIUM',
      reason: `${failedTxs} failed transaction(s) in recent history.`,
      evidence: { failedTxs },
      timestamp: new Date().toISOString(),
      chain: 'solana',
      wallet: null,
    })
  }

  if (walletAge && !walletAge.available) {
    findings.push({
      category: 'WALLET_AGE_UNKNOWN',
      severity: 'LOW',
      reason: 'Unable to determine wallet age. This is informational and not inherently malicious.',
      evidence: { walletAge },
      timestamp: new Date().toISOString(),
      chain: 'solana',
      wallet: null,
    })
  }

  if (solBalance && solBalance.sol < 0.01) {
    findings.push({
      category: 'LOW_SOL_BALANCE',
      severity: 'LOW',
      reason: 'Very low SOL balance — this may affect transaction viability but does not indicate malicious activity.',
      evidence: { solBalance: solBalance.sol },
      timestamp: new Date().toISOString(),
      chain: 'solana',
      wallet: null,
    })
  }

  const walletRisk = evaluateWalletRisk({ wallet: { address: null }, tokens: walletTokens, transactions: txs, walletAge })
  if (walletRisk?.findings?.length) findings.push(...walletRisk.findings)

  const suspicious = findings.map((finding) => ({
    type: String(finding.category || 'signal').toLowerCase(),
    severity: String(finding.severity || 'LOW').toUpperCase(),
    message: String(finding.reason || 'Security signal identified'),
    count: finding.evidence?.count || undefined,
  }))

  let score = 100
  const severityWeight = { LOW: 6, MEDIUM: 14, HIGH: 25, CRITICAL: 40 }
  for (const f of findings) {
    score -= severityWeight[String(f.severity || 'LOW').toUpperCase()] || 0
  }
  score = Math.max(0, Math.min(100, score))

  let scoreLabel = 'NO KNOWN ISSUES'
  if (score >= 80) scoreLabel = 'NO KNOWN ISSUES'
  else if (score >= 50) scoreLabel = 'REVIEW ADVISED'
  else if (score >= 20) scoreLabel = 'RISKY'
  else scoreLabel = 'HIGH RISK'

  const status = computeShieldStatus({ securityFindings: findings })
  const hasEnoughData = tokens.length > 0 || txs.length > 0 || (solBalance && typeof solBalance.sol === 'number')

  return {
    status,
    classification: status,
    findings,
    tokenRisks,
    knownCount,
    cautionCount: reviewCount,
    unknownCount: reviewCount,
    failedTxs,
    totalTxs,
    suspicious,
    score: hasEnoughData ? score : null,
    scoreLabel: hasEnoughData ? scoreLabel : 'Unavailable',
    hasEnoughData,
    summary: hasEnoughData
      ? status === 'CLEAR'
        ? 'No concrete risk indicators identified in the current wallet view.'
        : status === 'BLOCKED'
          ? 'Blocked or critical risk indicators were identified.'
          : status === 'HIGH_RISK'
            ? 'High-risk security signals are present.'
            : 'Review is recommended for one or more security signals.'
      : 'Unable to determine risk',
  }
}

// --- FULL SCAN ---
export async function scanWallet(owner) {
  const results = {
    owner,
    timestamp: Date.now(),
    solBalance: null,
    tokenAccounts: null,
    transactions: null,
    walletAge: null,
    security: null,
    errors: {},
  }

  try {
    results.solBalance = await getSolBalance(owner)
  } catch (e) {
    results.errors.solBalance = e.message
  }

  try {
    results.tokenAccounts = await getAllTokenAccounts(owner)
  } catch (e) {
    results.errors.tokenAccounts = e.message
  }

  try {
    results.transactions = await getRecentTransactions(owner, 20)
  } catch (e) {
    results.errors.transactions = e.message
  }

  try {
    results.walletAge = await getWalletAge(owner)
  } catch (e) {
    results.errors.walletAge = e.message
    results.walletAge = { available: false, reason: e.message }
  }

  try {
    results.security = analyzeSecurity({
      tokenAccounts: results.tokenAccounts,
      transactions: results.transactions,
      walletAge: results.walletAge,
      solBalance: results.solBalance,
    })
  } catch (e) {
    results.errors.security = e.message
  }

  return results
}
