// Dump first 50 tokens of LI.FI 4663 catalog sorted by symbol
const fs = require('node:fs')
const path = require('node:path')
;(async () => {
  const LIFI_KEY = '0796a97f-b8f1-48b9-bd77-ac06fb92fddc.1a394368-836e-4123-a548-aff974e6d222'
  const res = await fetch('https://li.quest/v1/tokens?chains=4663', {
    headers: { 'x-lifi-api-key': LIFI_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  const body = await res.json()
  const tokens = body?.tokens?.['4663'] || []
  // also check by key addresses
  const want = [
    ['WETH', '0x0bD7D3088E1639FbA988df18A801114EAcAd73'],
    ['USDG', '0x5fc5360D0400a0Fd42af552ADD042D716Fd168'],
  ]
  const lines = []
  lines.push(`Total tokens on 4663: ${tokens.length}`)
  for (const [sym, addr] of want) {
    const bySym = tokens.find((t) => String(t.symbol).toUpperCase() === sym.toUpperCase())
    const byAddr = tokens.find((t) => String(t.address).toLowerCase() === addr.toLowerCase())
    lines.push(`\nLooking for ${sym} @ ${addr}:`)
    lines.push(`  bySymbol match: ${bySym ? `${bySym.symbol} @ ${bySym.address} decimals=${bySym.decimals}` : 'NONE'}`)
    lines.push(`  byAddress match: ${byAddr ? `${byAddr.symbol} @ ${byAddr.address}` : 'NONE (not found in catalog — ROOT CAUSE of quote 400)'}`)
  }
  lines.push('\n=== First 50 tokens in LI.FI 4663 catalog (symbol, address, decimals, name) ===')
  const sorted = [...tokens].sort((a, b) => String(a.symbol || '').localeCompare(String(b.symbol || '')))
  for (const t of sorted.slice(0, 50)) {
    lines.push(`  ${String(t.symbol).padEnd(16)} ${String(t.address).toLowerCase()} dec=${t.decimals} name=${t.name}`)
  }
  const out = path.join(__dirname, '__probe_lifi_catalog.txt')
  fs.writeFileSync(out, lines.join('\n'), 'utf8')
  console.log(fs.readFileSync(out, 'utf8'))
})()
