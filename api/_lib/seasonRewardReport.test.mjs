import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeSeasonRewardAllocations } from './seasonRewardReport.mjs'

test('season reward report separates claimed, pending, and remaining allocations', () => {
  const report = summarizeSeasonRewardAllocations('season-1', 2, [
    { wallet_address: 'claimed-wallet', eligible_points: '100', reward_amount: '1.25', claim_status: 'COMPLETED' },
    { wallet_address: 'pending-wallet', eligible_points: '50', reward_amount: '0.625', claim_status: 'PENDING_PAYOUT' },
    { wallet_address: 'available-wallet', eligible_points: '25', reward_amount: '0.3125', claim_status: 'AVAILABLE' },
    { wallet_address: 'failed-wallet', eligible_points: '10', reward_amount: '0.125', claim_status: 'FAILED' },
  ])

  assert.deepEqual(report.totals, {
    allocatedWallets: 4,
    allocatedSol: 2.3125,
    claimedWallets: 1,
    claimedSol: 1.25,
    pendingWallets: 1,
    pendingSol: 0.625,
    remainingWallets: 2,
    remainingSol: 0.4375,
  })
  assert.deepEqual(report.wallets.map(({ walletAddress, claimStatus }) => [walletAddress, claimStatus]), [
    ['claimed-wallet', 'COMPLETED'],
    ['pending-wallet', 'PENDING_PAYOUT'],
    ['available-wallet', 'AVAILABLE'],
    ['failed-wallet', 'FAILED'],
  ])
})
