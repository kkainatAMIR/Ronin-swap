import test from 'node:test'
import assert from 'node:assert/strict'

const POINT_SCALE = 6
const SOL_SCALE = 9

function toUnits(value, scale) {
  const text = String(value)
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match || (match[2] || '').length > scale) throw new Error('INVALID_DECIMAL')
  return BigInt(match[1]) * (10n ** BigInt(scale))
    + BigInt((match[2] || '').padEnd(scale, '0') || '0')
}

function fromUnits(value, scale) {
  const divisor = 10n ** BigInt(scale)
  const whole = value / divisor
  const fraction = String(value % divisor).padStart(scale, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

function allocate(pool, entries) {
  const poolUnits = toUnits(pool, SOL_SCALE)
  const wallets = entries.map(({ wallet, points }) => ({ wallet, points: toUnits(points, POINT_SCALE) }))
  const totalPoints = wallets.reduce((total, entry) => total + entry.points, 0n)
  if (totalPoints === 0n) return { totalPoints, allocations: [] }
  return {
    totalPoints,
    allocations: wallets.map(({ wallet, points }) => ({
      wallet,
      points,
      reward: poolUnits * points / totalPoints,
    })),
  }
}

test('allocates proportionally: 100 SOL pool, 1,000 points, 100-point wallet', () => {
  const result = allocate('100', [
    { wallet: 'alice', points: '100' },
    { wallet: 'others', points: '900' },
  ])
  assert.equal(fromUnits(result.allocations[0].reward, SOL_SCALE), '10')
})

test('supports multiple and uneven wallet point totals', () => {
  const result = allocate('1', [
    { wallet: 'alice', points: '1' },
    { wallet: 'bob', points: '2' },
    { wallet: 'carol', points: '7' },
  ])
  assert.deepEqual(result.allocations.map((entry) => fromUnits(entry.reward, SOL_SCALE)), ['0.1', '0.2', '0.7'])
})

test('preserves decimal points and decimal SOL pool precision', () => {
  const result = allocate('0.123456789', [
    { wallet: 'alice', points: '0.1' },
    { wallet: 'bob', points: '0.2' },
  ])
  assert.deepEqual(result.allocations.map((entry) => fromUnits(entry.reward, SOL_SCALE)), ['0.041152263', '0.082304526'])
})

test('floors each allocation to lamports and never exceeds the pool', () => {
  const result = allocate('0.000000002', [
    { wallet: 'alice', points: '1' },
    { wallet: 'bob', points: '1' },
    { wallet: 'carol', points: '1' },
  ])
  const total = result.allocations.reduce((sum, entry) => sum + entry.reward, 0n)
  assert.equal(total, 0n)
  assert.ok(total <= toUnits('0.000000002', SOL_SCALE))
})

test('leaves indivisible lamport remainders undistributed', () => {
  const result = allocate('1', [
    { wallet: 'alice', points: '1' },
    { wallet: 'bob', points: '2' },
    { wallet: 'carol', points: '4' },
  ])
  const total = result.allocations.reduce((sum, entry) => sum + entry.reward, 0n)
  assert.equal(fromUnits(total, SOL_SCALE), '0.999999998')
  assert.ok(total <= toUnits('1', SOL_SCALE))
})

test('zero eligible points produce no allocations', () => {
  const result = allocate('100', [])
  assert.equal(result.totalPoints, 0n)
  assert.deepEqual(result.allocations, [])
})

test('rejects decimals beyond the supported database precision', () => {
  assert.throws(() => toUnits('1.0000001', POINT_SCALE), /INVALID_DECIMAL/)
  assert.throws(() => toUnits('1.0000000001', SOL_SCALE), /INVALID_DECIMAL/)
})
