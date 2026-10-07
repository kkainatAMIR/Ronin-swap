export async function validateSamuraiPromo({ promoCode, chainId, inputMint, outputMint }) {
  const response = await fetch('/api/samurai/promo/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promoCode, chainId, inputMint, outputMint }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || 'Promo validation failed.')
  return body
}
