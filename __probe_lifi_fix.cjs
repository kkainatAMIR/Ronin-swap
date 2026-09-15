// For every token in ROBINHOOD_VERIFIED_TOKENS, find the matching symbol in LI.FI catalog chain 4663
// and output { symbol, currentAddr, correctAddr (lowercase), name, decimals, matchType }
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
  const bySymbolUpper = new Map()
  for (const t of tokens) {
    const k = String(t.symbol || '').toUpperCase()
    if (!bySymbolUpper.has(k)) bySymbolUpper.set(k, [])
    bySymbolUpper.get(k).push(t)
  }

  const registry = [
    ['WETH', 'Wrapped Ether', '0x0bD7D3088E1639FbA988df18A801114EAcAd73', 18],
    ['USDG', 'Global Dollar', '0x5fc5360D0400a0Fd42af552ADD042D716Fd168', 18],
    ['CASHCAT', 'Cash Cat', '0x020bfc650a365f8bb26819deabf3e21291018b4', 18],
    ['CCC', 'Cashcat Chain', '0xddec0170ceb4426ea05f2bd48d5ff4a4afa6615', 18],
    ['STONKBROKER', 'StonkBroker', '0xe934e36a439c94017b64a3fece66af12099ab50', 18],
    ['INDEX', 'The Index', '0x56910d4409f3a0c78c64dd8d0545ff0705389870', 18],
    ['SYNAPSE', 'Hood Synapse by Virtuals', '0x1E75e55B4b2d77B62f07D5AA86401057584aDd', 18],
    ['NASDUCK', 'Nasduck', '0x78fc7e13bccab8a7aedc5b8465c3442d6d7d9d64', 18],
    ['MONEROCHAN', 'Monero-Chan', '0x0908a927f27c96e5f21fa15bcd296974542da0f', 18],
    ['PIPEDOG', 'pipedog', '0x5cb6f181081301b44905f3ae15419112ecabd8a6', 18],
    ['UNIPCS', 'Unipcs', '0x7df5daaF80e65dfcc7a1435d9b52bcb2b5753fbe', 18],
    ['AOBS', 'Agent OBS', '0x47366e0f257ac009e82bd46fb74e2fb50826ce98', 18],
    ['PORT', 'Port', '0xafa57c4c5a72d36530c8e816ad6e9a5947941536', 18],
    ['BOOMER', 'Boomer', '0x73c2de14c7fa0a57cc2d9722b959ea70b881ffe4', 18],
    ['SHRUB', "Lil' Shrub", '0x5d9144d2d017386519a7134fcc7f1e4ba222920c', 18],
    ['CUPCAKE', 'Cupcake', '0x0ae4cab49b6f048f9c589a522620eb0fc4ededc6', 18],
    ['ZZZ', 'ZZZ', '0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a', 18],
  ]

  const lines = []
  lines.push('symbol | current (registry)  | correct (LI.FI 4663)                          | dec | name')
  lines.push('---|---|---|---|---')
  const rows = []
  let mismatches = 0
  for (const [sym, name, curAddr, curDec] of registry) {
    const matches = bySymbolUpper.get(sym.toUpperCase()) || []
    const best = matches[0]
    const correctAddr = best ? String(best.address).toLowerCase() : 'NOT_FOUND_IN_CATALOG'
    const correctDec = best ? best.decimals : '?'
    const match = curAddr.toLowerCase() === correctAddr.toLowerCase() ? '✓' : '✗ MISMATCH'
    if (match === '✗ MISMATCH') mismatches++
    rows.push({ symbol: sym, currentAddr: curAddr.toLowerCase(), correctAddr, decimals: correctDec, name: best?.name || name, match })
    lines.push(`${sym} | ${curAddr.toLowerCase()} | ${correctAddr} | ${correctDec} | ${best?.name || name}  ${match}`)
  }
  lines.push(`\nTotal mismatches: ${mismatches} / ${registry.length}`)
  lines.push('\n=== JS Object replacement for robinhoodRegistry.js ===')
  lines.push('const candidate = (symbol, name, address, categories, opts) => Object.freeze({ chainId: 4663, chainKey: "robinhood", type: "erc20", symbol, name, address, decimals: opts.decimals, categories, isMeme: !!opts.isMeme, verification: "verified", productionEnabled: true })')
  lines.push('export const ROBINHOOD_TOKEN_CANDIDATES = Object.freeze([')
  const candidateTemplates = [
    ['WETH', 'Wrapped Ether', ['core'], { decimals: 18 }],
    ['USDG', 'Global Dollar', ['core'], {}],
    ['CASHCAT', 'Cash Cat', ['meme', 'l3'], { isMeme: true }],
    ['CCC', 'Cashcat Chain', ['utility', 'ai'], { decimals: 18 }],
    ['STONKBROKER', 'StonkBroker', ['utility', 'meme'], { isMeme: true }],
    ['INDEX', 'The Index', ['meme', 'index'], { isMeme: true }],
    ['SYNAPSE', 'Hood Synapse by Virtuals', ['ai', 'data'], {}],
    ['NASDUCK', 'Nasduck', ['meme'], { isMeme: true }],
    ['MONEROCHAN', 'Monero-Chan', ['meme'], { isMeme: true }],
    ['PIPEDOG', 'pipedog', ['meme'], { isMeme: true }],
    ['UNIPCS', 'Unipcs', ['meme', 'community'], { isMeme: true }],
    ['AOBS', 'Agent OBS', ['ai', 'meme'], { isMeme: true }],
    ['PORT', 'Port', ['meme', 'project'], { isMeme: true }],
    ['BOOMER', 'Boomer', ['meme'], { isMeme: true }],
    ['SHRUB', "Lil' Shrub", ['meme'], { isMeme: true }],
    ['CUPCAKE', 'Cupcake', ['meme'], { isMeme: true }],
    ['ZZZ', 'ZZZ', ['meme'], { isMeme: true }],
  ]
  for (let i = 0; i < candidateTemplates.length; i++) {
    const [sym, name, cats, opts] = candidateTemplates[i]
    const row = rows.find((r) => r.symbol === sym)
    const addr = row && row.correctAddr !== 'NOT_FOUND_IN_CATALOG' ? row.correctAddr : rows[i]?.correctAddr
    const dec = row?.decimals && row.decimals !== '?' ? row.decimals : (opts.decimals || 18)
    if (addr && addr !== 'NOT_FOUND_IN_CATALOG') {
      lines.push(`  candidate('${sym}', '${name.replace(/'/g, "\\'")}', '${addr}', ${JSON.stringify(cats)}, { ${['isMeme' in opts ? `isMeme: true` : '', `decimals: ${dec}`].filter(Boolean).join(', ')} }),`)
    }
  }
  lines.push('])')
  const out = path.join(__dirname, '__probe_lifi_fix.txt')
  fs.writeFileSync(out, lines.join('\n'), 'utf8')
  console.log(fs.readFileSync(out, 'utf8'))
})()
