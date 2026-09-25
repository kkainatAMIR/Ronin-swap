import { getLeaderboard } from './leaderboardService'

async function getSwapHistory(wallet) {
  const response = await fetch(`/api/swap/history?wallet=${encodeURIComponent(wallet)}&chain=all`, { cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || 'Unable to load your swap history.')
  return Array.isArray(body?.swaps) ? body.swaps : []
}

// Fetches the profile data for a single wallet address.
// Returns { walletStats, swaps, neighbors }.
// Used as a building block for the multi-wallet aggregation below.
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

  return { walletStats: resolvedWalletStats, swaps, neighbors, walletAddress: wallet }
}

// =====================================================================
// Multi-wallet aggregation
// =====================================================================
// Fetches profile data for ALL of the user's connected wallets (Phantom
// Solana + MetaMask Ethereum + MetaMask Robinhood) and aggregates the
// results into a single combined view.
//
// Why this exists:
//   The samurai_points table is keyed on wallet_address. A Solana address
//   and an Ethereum address are different rows, so a user who swaps on
//   both chains accumulates points in two separate "wallets" from the
//   database's perspective. The Profile page needs to sum these up so
//   the user sees their true total — not just the Phantom wallet's
//   points.
//
// Returns:
//   {
//     walletStats: {
//       samuraiPoints: <sum across all wallets>,
//       lifetimeVolume: <sum>,
//       swapsCount: <sum>,
//       currentRank: <best rank across wallets>,
//       perWallet: [ { walletAddress, samuraiPoints, lifetimeVolume, swapsCount, currentRank } ],
//     },
//     swaps: [ <all swaps across all wallets, sorted desc> ],
//     neighbors: [ <best wallet's neighbors> ],
//     walletAddress: <primary wallet — the Phantom address if connected>,
//     allWalletAddresses: [ <all wallet addresses queried> ],
//   }
// =====================================================================
export async function getAggregatedProfileData(walletAddresses) {
  if (!Array.isArray(walletAddresses) || walletAddresses.length === 0) {
    return { walletStats: { samuraiPoints: 0, lifetimeVolume: 0, swapsCount: 0, currentRank: null, perWallet: [] }, swaps: [], neighbors: [], walletAddress: null, allWalletAddresses: [] }
  }

  // Fetch each wallet's profile in parallel. Errors for individual wallets
  // are caught and treated as zero so one bad wallet doesn't break the
  // whole aggregate.
  const perWalletResults = await Promise.all(
    walletAddresses.map((addr) =>
      getProfileData(addr)
        .then((result) => ({ ...result, walletAddress: addr, error: null }))
        .catch((error) => ({ walletAddress: addr, error, walletStats: { samuraiPoints: 0, lifetimeVolume: 0, swapsCount: 0, currentRank: null }, swaps: [], neighbors: [] }))
    )
  )

  // Aggregate
  let totalSamuraiPoints = 0
  let totalLifetimeVolume = 0
  let totalSwapsCount = 0
  let bestRank = null
  let bestRankResult = null  // for neighbors
  const allSwaps = []
  const perWalletStats = []

  for (const result of perWalletResults) {
    const stats = result.walletStats || {}
    const points = Number(stats.samuraiPoints || 0)
    const volume = Number(stats.lifetimeVolume || 0)
    const swapsCount = Number(stats.swapsCount || result.swaps?.length || 0)
    const rank = Number.isFinite(Number(stats.currentRank)) ? Number(stats.currentRank) : null

    totalSamuraiPoints += points
    totalLifetimeVolume += volume
    totalSwapsCount += swapsCount
    allSwaps.push(...result.swaps)

    perWalletStats.push({
      walletAddress: result.walletAddress,
      samuraiPoints: points,
      lifetimeVolume: volume,
      swapsCount,
      currentRank: rank,
    })

    // Track the best rank (lowest number = highest rank).
    if (rank != null && (bestRank == null || rank < bestRank)) {
      bestRank = rank
      bestRankResult = result
    }
  }

  // Sort swaps by timestamp desc (most recent first)
  allSwaps.sort((a, b) => {
    const aTime = Date.parse(a.timestamp || a.created_at || 0)
    const bTime = Date.parse(b.timestamp || b.created_at || 0)
    return bTime - aTime
  })

  return {
    walletStats: {
      samuraiPoints: totalSamuraiPoints,
      lifetimeVolume: totalLifetimeVolume,
      swapsCount: totalSwapsCount,
      currentRank: bestRank,
      perWallet: perWalletStats,
    },
    swaps: allSwaps,
    neighbors: bestRankResult?.neighbors || [],
    walletAddress: walletAddresses[0],  // primary = first address passed (Phantom if connected)
    allWalletAddresses: walletAddresses,
  }
}

