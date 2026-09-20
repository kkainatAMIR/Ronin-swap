const contributions = globalThis.__RONIN_SHIELD_CONTRIBUTIONS__ || []
globalThis.__RONIN_SHIELD_CONTRIBUTIONS__ = contributions

export async function addTrackedContribution(solAmount) {
  const amount = Number(solAmount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid shield contribution amount.')
  contributions.push({ amount, createdAt: Date.now() })
  return contributions.reduce((total, item) => total + item.amount, 0)
}

export async function loadCounters() {
  return {
    walletsScanned: 0,
    contributionsTracked: contributions.length,
  }
}