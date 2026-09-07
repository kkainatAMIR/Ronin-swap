export async function fetchShieldStats() {
  try {
    const res = await fetch('/api/ronin/shield-stats', { cache: 'no-store' })
    if (!res.ok) throw new Error(`Shield stats ${res.status}`)
    const data = await res.json()
    return data
  } catch (e) {
    console.warn('fetchShieldStats failed', e)
    // Fallback: return null so UI can still work
    return null
  }
}

export async function trackShieldContribution({ solAmount, signature }) {
  try {
    const res = await fetch('/api/ronin/shield-contribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ solAmount, signature }),
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`Shield contribution ${res.status}`)
    return await res.json()
  } catch (e) {
    console.warn('trackShieldContribution failed', e)
    return null
  }
}
