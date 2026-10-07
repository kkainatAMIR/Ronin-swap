export function summarizeSeasonRewardAllocations(seasonId, allocationVersion, rows) {
  const totals = {
    allocatedWallets: rows.length,
    allocatedSol: 0,
    claimedWallets: 0,
    claimedSol: 0,
    pendingWallets: 0,
    pendingSol: 0,
    remainingWallets: 0,
    remainingSol: 0,
  }
  const wallets = rows.map((wallet) => {
    const rewardAmount = Number(wallet.reward_amount || 0)
    const claimStatus = String(wallet.claim_status || 'AVAILABLE').toUpperCase()
    totals.allocatedSol += rewardAmount
    if (claimStatus === 'COMPLETED') {
      totals.claimedWallets += 1
      totals.claimedSol += rewardAmount
    } else if (['ENTITLED', 'PENDING_PAYOUT'].includes(claimStatus)) {
      totals.pendingWallets += 1
      totals.pendingSol += rewardAmount
    } else {
      totals.remainingWallets += 1
      totals.remainingSol += rewardAmount
    }
    return {
      walletAddress: wallet.wallet_address,
      eligiblePoints: Number(wallet.eligible_points || 0),
      rewardAmount,
      claimStatus,
    }
  })
  return { seasonId, allocationVersion, totals, wallets }
}
