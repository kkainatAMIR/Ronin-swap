// Verify local /api/lifi/quote on 127.0.0.1:5174 (avoids undici localhost-IPv6 failure on Windows)
const fs = require('node:fs')
const path = require('node:path')
const out = []

async function localPost(api, payload) {
  const res = await fetch(`http://127.0.0.1:5174${api}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: res.status, ok: res.ok, body }
}

;(async () => {
  const wallet = '0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9'
  const correctedWeth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
  const correctedUsdg = '0x0a3b763d66c0e8c7555c986a3701e1dc1bf3954f'
  const oldWrongWeth = '0x0bD7D3088E1639FbA988df18A801114EAcAd73'
  const oldWrongUsdg = '0x5fc5360D0400a0Fd42af552ADD042D716Fd168'
  const zero = '0x0000000000000000000000000000000000000000'

  const tests = [
    {
      name: 'V3 (CORRECT WETH->USDG): expect 404 NO_ROUTE (pair has no real route)',
      payload: { fromChain: 4663, toChain: 4663, fromToken: correctedWeth, toToken: correctedUsdg, fromAmount: '1000000000000000000', fromAddress: wallet, toAddress: wallet, slippage: 0.01 },
    },
    {
      name: 'V4 (CORRECT native->WETH): expect 200 SUCCESS with quoteProof + quoteId',
      payload: { fromChain: 4663, toChain: 4663, fromToken: zero, toToken: correctedWeth, fromAmount: '1000000000000000000', fromAddress: wallet, toAddress: wallet, slippage: 0.01 },
    },
    {
      name: 'V5 (OLD WRONG addresses): expect 400 LIFI_INVALID_REQUEST with actual LI.FI message',
      payload: { fromChain: 4663, toChain: 4663, fromToken: oldWrongWeth, toToken: oldWrongUsdg, fromAmount: '1000000000000000000', fromAddress: wallet, toAddress: wallet, slippage: 0.01 },
    },
  ]
  for (const t of tests) {
    out.push(`\n=== ${t.name} ===`)
    try {
      const r = await localPost('/api/lifi/quote', t.payload)
      out.push(`status=${r.status} ok=${r.ok}`)
      if (r.ok) {
        const q = r.body?.quote || {}
        out.push(`SUCCESS quoteId=${q.quoteId} expectedOutput=${q.expectedOutput} txTo=${q.transactionRequest?.to} volumeUsd=${q.volumeUsd} quoteProof.present=${Boolean(q.quoteProof)} expiresAt=${q.expiresAt}`)
      } else {
        out.push(`FAIL code=${r.body?.code} error=${r.body?.error}`)
      }
    } catch (e) {
      out.push(`THREW: ${e?.message || e}`)
    }
  }
  const outPath = path.join(__dirname, '__probe_lifi_verify_v2.txt')
  fs.writeFileSync(outPath, out.join('\n'), 'utf8')
  console.log(out.join('\n'))
})().catch((e) => {
  const outPath = path.join(__dirname, '__probe_lifi_verify_v2.txt')
  fs.writeFileSync(outPath, `FINAL THROW: ${e?.message}\n${e?.stack || ''}`, 'utf8')
  process.exit(1)
})
