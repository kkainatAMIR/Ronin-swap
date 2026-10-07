export async function getCampaignOverview() {
  const response = await fetch('/api/samurai/campaigns', { cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.message || body?.error || 'Unable to load campaigns.')
  return {
    campaigns: Array.isArray(body?.campaigns) ? body.campaigns : [],
    claimWindows: Array.isArray(body?.claimWindows) ? body.claimWindows : [],
  }
}
