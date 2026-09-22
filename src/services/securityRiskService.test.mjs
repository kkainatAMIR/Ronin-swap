import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateTokenRisk,
  detectImpersonationRisk,
  evaluateWalletRisk,
  computeShieldStatus,
  analyzeDomainRisk,
} from './securityRiskService.js'

test('trusted mint resolves to known classification', () => {
  const result = evaluateTokenRisk({
    chain: 'solana',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    name: 'USD Coin',
  })

  assert.equal(result.classification, 'KNOWN')
  assert.equal(result.status, 'CLEAR')
})

test('unknown mint stays review instead of claiming malicious', () => {
  const result = evaluateTokenRisk({
    chain: 'solana',
    mint: 'unknownmint1111111111111111111111111111111111',
    symbol: 'RISKY',
    name: 'Test token',
  })

  assert.equal(result.classification, 'REVIEW')
  assert.equal(result.status, 'REVIEW')
})

test('same symbol with different mint is flagged as impersonation', () => {
  const result = detectImpersonationRisk({
    mint: 'FakeMint111111111111111111111111111111111111',
    symbol: 'USDC',
    name: 'USD Coin',
  }, {
    a: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin' },
    b: { mint: 'FakeMint111111111111111111111111111111111111', symbol: 'USDC', name: 'USD Coin' },
  })

  assert.ok(result)
  assert.equal(result.category, 'TOKEN_IMPERSONATION')
  assert.equal(result.severity, 'HIGH')
})

test('freeze authority produces a concrete finding', () => {
  const result = evaluateTokenRisk({
    chain: 'solana',
    mint: 'someunknownmint1111111111111111111111111111',
    symbol: 'TEST',
    name: 'Test Token',
    authorities: { freezeAuthority: true },
  })

  assert.ok(result.findings.some((item) => item.category === 'FREEZE_AUTHORITY'))
})

test('mint authority produces a concrete finding', () => {
  const result = evaluateTokenRisk({
    chain: 'solana',
    mint: 'someunknownmint1111111111111111111111111112',
    symbol: 'AUTH',
    name: 'Authority Token',
    authorities: { mintAuthority: 'enabled' },
  })

  assert.ok(result.findings.some((item) => item.category === 'MINT_AUTHORITY'))
})

test('blocked token is classified blocked', () => {
  const result = evaluateTokenRisk({
    chain: 'solana',
    mint: 'blockedmint1111111111111111111111111111111',
    symbol: 'BAD',
    name: 'Blocked Token',
    blocked: true,
  })

  assert.equal(result.classification, 'BLOCKED')
  assert.equal(result.status, 'BLOCKED')
})

test('wallet risk engine returns review for suspicious pattern', () => {
  const result = evaluateWalletRisk({
    wallet: { address: 'abc' },
    tokens: [{ mint: 'unknownmint1111111111111111111111111111111', symbol: 'RISK', name: 'Risky' }],
    transactions: [
      { type: 'swap', description: 'swap' },
      { type: 'approval', description: 'approval' },
      { type: 'transfer', description: 'transfer' },
    ],
    walletAge: { available: true, daysNumber: 14 },
  })

  assert.ok(result.status === 'REVIEW' || result.status === 'HIGH_RISK')
})

test('blocked domain is classified blocked', () => {
  const result = analyzeDomainRisk('blocked.example.com')
  assert.equal(result.status, 'BLOCKED')
  assert.equal(result.classification, 'BLOCKED')
})

test('look-alike ronin domain triggers review', () => {
  const result = analyzeDomainRisk('ronin-support-secure.com')
  assert.equal(result.status, 'REVIEW')
})

test('computeShieldStatus handles blocked, high, and clear states', () => {
  assert.equal(computeShieldStatus({ securityFindings: [{ severity: 'CRITICAL', category: 'BLOCKED_TOKEN' }] }), 'BLOCKED')
  assert.equal(computeShieldStatus({ securityFindings: [{ severity: 'HIGH', category: 'TOKEN_IMPERSONATION' }] }), 'HIGH_RISK')
  assert.equal(computeShieldStatus({ securityFindings: [{ severity: 'LOW', category: 'UNKNOWN_TOKEN' }] }), 'REVIEW')
  assert.equal(computeShieldStatus({ securityFindings: [] }), 'CLEAR')
})
