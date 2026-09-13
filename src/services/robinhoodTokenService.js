// RoninSamurai.com — Robinhood Chain token catalog (frontend side).
//
// Robinhood Chain has no manually curated, verified token registry yet, so
// the token list is sourced live from the backend, which in turn trusts
// LI.FI's own token catalog (see api/_lib/lifi.mjs / api/robinhood/tokens.mjs).

export async function getRobinhoodTokenSections() {
  const response = await fetch('/api/robinhood/tokens', { cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || 'Robinhood token list is unavailable.')
  return body
}

export async function getRobinhoodTrending() {
  const response = await fetch('/api/robinhood/trending', { cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || 'Robinhood trending is unavailable.')
  return body
}
