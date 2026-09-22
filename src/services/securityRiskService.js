const DEFAULT_RONIN_MINT = '2JVEVXoRsskapZ8T56MjMNJq6Dk3feEUYSRmzkkipump'
const RONIN_MINT = globalThis.__RONIN_MINT_ADDRESS__ || globalThis.__RONIN_LOCAL_ENV__?.VITE_RONIN_MINT_ADDRESS || DEFAULT_RONIN_MINT

const TRUSTED_TOKEN_MAP = Object.freeze({
  'So11111111111111111111111111111111111111112': { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Solana' },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin' },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', name: 'Tether USD' },
  [RONIN_MINT]: { mint: RONIN_MINT, symbol: 'RONIN', name: 'RONIN' },
})

export const RISK_LEVELS = Object.freeze({
  KNOWN: 'KNOWN',
  LOW_RISK: 'LOW_RISK',
  REVIEW: 'REVIEW',
  HIGH_RISK: 'HIGH_RISK',
  BLOCKED: 'BLOCKED',
})

export const SECURITY_REGISTRY = Object.freeze({
  trustedTokens: Object.freeze({
    'So11111111111111111111111111111111111111112': 'SOL',
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
    [RONIN_MINT]: 'RONIN',
  }),
  flaggedTokens: Object.freeze({}),
  blockedTokens: Object.freeze({}),
  trustedPrograms: Object.freeze({}),
  flaggedPrograms: Object.freeze({}),
  blockedPrograms: Object.freeze({}),
  trustedDomains: Object.freeze({}),
  flaggedDomains: Object.freeze({ 'ronin-support-secure.com': true }),
  blockedDomains: Object.freeze({ 'blocked.example.com': true }),
})

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase()
}

function nowIso() {
  return new Date().toISOString()
}

export function getTokenIdentity({ mint, contract, chain = 'solana' } = {}) {
  const address = normalizeAddress(mint || contract || '')
  return { chain, address }
}

export function detectImpersonationRisk(token = {}, trustedMap = TRUSTED_TOKEN_MAP || {}) {
  const mint = normalizeAddress(token.mint || token.contract || '')
  const symbol = String(token.symbol || '').trim()
  const name = String(token.name || '').trim()
  if (!mint || !symbol) return null

  const trustedMatches = Object.values(trustedMap).filter((candidate) => {
    const candidateMint = normalizeAddress(candidate?.mint || '')
    const candidateSymbol = String(candidate?.symbol || '').trim()
    const candidateName = String(candidate?.name || '').trim()
    if (!candidateMint || candidateMint === mint) return false
    return candidateSymbol === symbol || candidateName === name
  })

  if (!trustedMatches.length) return null

  const match = trustedMatches[0]
  return {
    category: 'TOKEN_IMPERSONATION',
    severity: 'HIGH',
    reason: `Token symbol/address mismatch detected: ${symbol} matches an existing trusted token but with a different mint (${match.mint}).`,
    evidence: {
      trustedMint: match.mint,
      observedMint: mint,
      symbol,
      trustedSymbol: match.symbol,
    },
    timestamp: nowIso(),
    chain: 'solana',
    tokenAddress: mint,
    classification: RISK_LEVELS.HIGH_RISK,
  }
}

export function evaluateTokenRisk(input = {}) {
  const { chain = 'solana', mint, contract, symbol, name, authorities = {}, metadata = {}, flagged = false, blocked = false } = input
  const tokenAddress = normalizeAddress(mint || contract || '')
  const evidence = { chain, tokenAddress, symbol: symbol || null, name: name || null }

  if (blocked || SECURITY_REGISTRY.blockedTokens[tokenAddress]) {
    return {
      classification: RISK_LEVELS.BLOCKED,
      status: 'BLOCKED',
      findings: [{
        category: 'BLOCKED_TOKEN',
        severity: 'CRITICAL',
        reason: 'Token is present in the blocked registry and must not be trusted.',
        evidence,
        timestamp: nowIso(),
        chain,
        tokenAddress,
      }],
    }
  }

  const findings = []
  if (flagged || SECURITY_REGISTRY.flaggedTokens[tokenAddress]) {
    findings.push({
      category: 'TOKEN_REGISTRY',
      severity: 'HIGH',
      reason: 'Token is identified as flagged in the internal registry.',
      evidence,
      timestamp: nowIso(),
      chain,
      tokenAddress,
    })
  }

  const trustedMint = SECURITY_REGISTRY.trustedTokens[tokenAddress]
  if (trustedMint) {
    return {
      classification: RISK_LEVELS.KNOWN,
      status: 'CLEAR',
      findings: [{
        category: 'TOKEN_REGISTRY',
        severity: 'LOW',
        reason: `Trusted registry match for ${trustedMint}.`,
        evidence,
        timestamp: nowIso(),
        chain,
        tokenAddress,
      }],
    }
  }

  if (authorities?.freezeAuthority === 'enabled' || authorities?.freezeAuthority === true) {
    findings.push({
      category: 'FREEZE_AUTHORITY',
      severity: 'MEDIUM',
      reason: 'Freeze authority is still enabled.',
      evidence: { ...evidence, freezeAuthority: authorities.freezeAuthority },
      timestamp: nowIso(),
      chain,
      tokenAddress,
    })
  }

  if (authorities?.mintAuthority === 'enabled' || authorities?.mintAuthority === true) {
    findings.push({
      category: 'MINT_AUTHORITY',
      severity: 'MEDIUM',
      reason: 'Mint authority is still enabled.',
      evidence: { ...evidence, mintAuthority: authorities.mintAuthority },
      timestamp: nowIso(),
      chain,
      tokenAddress,
    })
  }

  if (metadata?.token2022 || metadata?.transferHook || authorities?.transferHook || authorities?.permanentDelegate) {
    findings.push({
      category: 'TOKEN_2022_EXTENSIONS',
      severity: 'MEDIUM',
      reason: 'Token-2022 or transfer-hook extensions are present; review runtime authority and transfer restrictions.',
      evidence: { ...evidence, metadata, authorities },
      timestamp: nowIso(),
      chain,
      tokenAddress,
    })
  }

  if (authorities?.defaultFrozen || metadata?.defaultFrozen) {
    findings.push({
      category: 'DEFAULT_FROZEN',
      severity: 'LOW',
      reason: 'Default frozen state is enabled.',
      evidence: { ...evidence, defaultFrozen: true },
      timestamp: nowIso(),
      chain,
      tokenAddress,
    })
  }

  if (metadata?.unverified || !tokenAddress) {
    findings.push({
      category: 'UNKNOWN_METADATA',
      severity: 'LOW',
      reason: 'Metadata is incomplete or unverified.',
      evidence,
      timestamp: nowIso(),
      chain,
      tokenAddress,
    })
  }

  if (findings.length === 0) {
    return {
      classification: RISK_LEVELS.REVIEW,
      status: 'REVIEW',
      findings: [{
        category: 'UNKNOWN_TOKEN',
        severity: 'LOW',
        reason: 'Token is not in the trusted registry and has no concrete risky indicators yet.',
        evidence,
        timestamp: nowIso(),
        chain,
        tokenAddress,
      }],
    }
  }

  const highest = findings.reduce((winner, current) => {
    const order = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }
    return order[current.severity] > order[winner.severity] ? current : winner
  }, findings[0])

  const classification = highest.severity === 'CRITICAL' || highest.severity === 'HIGH'
    ? RISK_LEVELS.HIGH_RISK
    : highest.severity === 'MEDIUM'
      ? RISK_LEVELS.REVIEW
      : RISK_LEVELS.LOW_RISK

  return { classification, status: classification === RISK_LEVELS.HIGH_RISK ? 'HIGH_RISK' : 'REVIEW', findings }
}

export function evaluateWalletRisk({ wallet = {}, tokens = [], transactions = [], walletAge = null } = {}) {
  const findings = []
  const walletAddress = normalizeAddress(wallet.address || wallet.wallet || '')

  for (const token of tokens) {
    const risk = evaluateTokenRisk({
      chain: token.chain || 'solana',
      mint: token.mint || token.contract,
      symbol: token.symbol,
      name: token.name,
      authorities: token.authorities || {},
      metadata: token.metadata || {},
      flagged: Boolean(token.flagged),
      blocked: Boolean(token.blocked),
    })
    if (risk.findings?.length) findings.push(...risk.findings.map((finding) => ({ ...finding, wallet: walletAddress || null })))
  }

  const suspiciousTransfers = (transactions || []).filter((tx) => /transfer|swap|approval|drain/i.test(String(tx?.type || tx?.description || '')))
  if (suspiciousTransfers.length > 2) {
    findings.push({
      category: 'SUSPICIOUS_TRANSFER_PATTERN',
      severity: 'MEDIUM',
      reason: 'Wallet shows multiple suspicious transfer or approval events in a short time window.',
      evidence: { count: suspiciousTransfers.length },
      timestamp: nowIso(),
      chain: 'solana',
      wallet: walletAddress,
    })
  }

  if (walletAge && walletAge.available && walletAge.daysNumber !== undefined && walletAge.daysNumber < 30) {
    findings.push({
      category: 'NEW_WALLET',
      severity: 'LOW',
      reason: 'Wallet is new and may be less established; this is not inherently malicious.',
      evidence: { ageDays: walletAge.daysNumber },
      timestamp: nowIso(),
      chain: 'solana',
      wallet: walletAddress,
    })
  }

  if (!findings.length) {
    return { status: 'CLEAR', classification: RISK_LEVELS.KNOWN, findings: [{
      category: 'NO_FINDINGS',
      severity: 'LOW',
      reason: 'No concrete risk indicators were identified in the current wallet view.',
      evidence: { wallet: walletAddress },
      timestamp: nowIso(),
      chain: 'solana',
      wallet: walletAddress,
    }] }
  }

  const highest = findings.reduce((winner, current) => {
    const order = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 }
    return order[current.severity] > order[winner.severity] ? current : winner
  }, findings[0])

  const status = highest.severity === 'CRITICAL' || highest.severity === 'HIGH' ? 'HIGH_RISK' : 'REVIEW'
  return { status, classification: highest.severity === 'CRITICAL' || highest.severity === 'HIGH' ? RISK_LEVELS.HIGH_RISK : RISK_LEVELS.REVIEW, findings }
}

export function computeShieldStatus({ securityFindings = [] } = {}) {
  if (!securityFindings.length) return 'CLEAR'
  const hasBlocked = securityFindings.some((entry) => String(entry.severity).toUpperCase() === 'CRITICAL' || String(entry.category || '').includes('BLOCKED'))
  const hasHigh = securityFindings.some((entry) => String(entry.severity).toUpperCase() === 'HIGH')
  const hasReview = securityFindings.some((entry) => String(entry.severity).toUpperCase() === 'MEDIUM' || String(entry.severity).toUpperCase() === 'LOW')
  if (hasBlocked) return 'BLOCKED'
  if (hasHigh) return 'HIGH_RISK'
  if (hasReview) return 'REVIEW'
  return 'UNKNOWN'
}

export function analyzeDomainRisk(domain = '') {
  const normalized = String(domain || '').trim().toLowerCase()
  if (!normalized) return { status: 'UNKNOWN', classification: RISK_LEVELS.REVIEW, reason: 'No domain supplied.' }
  if (SECURITY_REGISTRY.blockedDomains[normalized]) {
    return { status: 'BLOCKED', classification: RISK_LEVELS.BLOCKED, reason: 'Blocked phishing domain in registry.' }
  }
  if (SECURITY_REGISTRY.flaggedDomains[normalized]) {
    return { status: 'REVIEW', classification: RISK_LEVELS.REVIEW, reason: 'Flagged domain requires verification before continuing.' }
  }
  if (normalized.includes('ronin') && !normalized.includes('roninwallet') && !normalized.includes('ronin-chain')) {
    return { status: 'REVIEW', classification: RISK_LEVELS.REVIEW, reason: 'Possible look-alike domain — verify before continuing.' }
  }
  return { status: 'UNKNOWN', classification: RISK_LEVELS.REVIEW, reason: 'Domain is not in the trusted registry, but no concrete malicious signal was found.' }
}
