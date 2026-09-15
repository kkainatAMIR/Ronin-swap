import { getLeaderboard } from './leaderboardService'

async function getSwapHistory(wallet) {
  const response = await fetch(`/api/swap/history?wallet=${encodeURIComponent(wallet)}&chain=all`, { cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || 'Unable to load your swap history.')
  return Array.isArray(body?.swaps) ? body.swaps : []
}

export async function getProfileData(wallet) {
  const [leaderboard, swaps] = await Promise.all([
    getLeaderboard({ period: 'all-time', page: 1, limit: 1, wallet }),
    getSwapHistory(wallet),
  ])

  const walletStats = leaderboard?.wallet || {}
  const qualifyingVolume = swaps.reduce((total, swap) => total + Number(swap.qualifying_volume_usd || 0), 0)
  const resolvedWalletStats = {
    ...walletStats,
    lifetimeVolume: Number(walletStats.lifetimeVolume || 0) || qualifyingVolume,
  }
  const currentRank = Number.isFinite(Number(walletStats.currentRank)) ? Number(walletStats.currentRank) : null
  let neighbors = []
  if (currentRank) {
    const page = Math.floor((currentRank - 1) / 100) + 1
    const nearby = await getLeaderboard({ period: 'all-time', page, limit: 100 })
    neighbors = Array.isArray(nearby?.entries)
      ? nearby.entries.filter((entry) => Math.abs(Number(entry.rank) - currentRank) <= 1)
      : []
  }

  return { walletStats: resolvedWalletStats, swaps, neighbors }
}
