import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSeasonMinimum, parseSeasonRestart } from './seasons.mjs'

test('season minimum accepts zero and positive configured values', () => {
  assert.equal(parseSeasonMinimum(0), 0)
  assert.equal(parseSeasonMinimum('1'), 1)
})

test('season minimum rejects missing, negative, and non-numeric values', () => {
  for (const value of [null, '', -1, 'invalid']) {
    assert.throws(() => parseSeasonMinimum(value), { message: 'INVALID_SEASON_MINIMUM' })
  }
})

test('season restart requires a future end followed by a valid claim window', () => {
  const endAt = new Date(Date.now() + 60_000)
  const claimWindowStart = new Date(endAt.getTime() + 60_000)
  const claimWindowEnd = new Date(claimWindowStart.getTime() + 60_000)

  assert.deepEqual(parseSeasonRestart({
    endAt: endAt.toISOString(),
    claimWindowStart: claimWindowStart.toISOString(),
    claimWindowEnd: claimWindowEnd.toISOString(),
  }), {
    endAt: endAt.toISOString(),
    claimWindowStart: claimWindowStart.toISOString(),
    claimWindowEnd: claimWindowEnd.toISOString(),
  })
})

test('season restart rejects a claim window before the earning period ends', () => {
  const endAt = new Date(Date.now() + 60_000)
  const claimWindowStart = new Date(endAt.getTime() - 1)
  const claimWindowEnd = new Date(endAt.getTime() + 60_000)

  assert.throws(() => parseSeasonRestart({
    endAt: endAt.toISOString(),
    claimWindowStart: claimWindowStart.toISOString(),
    claimWindowEnd: claimWindowEnd.toISOString(),
  }), { message: 'INVALID_SEASON_RESTART_DATES' })
})
