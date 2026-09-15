// Standalone: probe local /api/lifi/quote via raw http module (no PS terminal needed)
// Run: node __probe_lifi_final.cjs ; result in C:\Users\user\Desktop\Assignment\Ronin 2\Ronin-repo\__probe_lifi_final_result.txt
const http = require('node:http')
const fs = require('node:fs')
const OUT = 'C:\\Users\\user\\Desktop\\Assignment\\Ronin 2\\Ronin-repo\\__probe_lifi_final_result.txt'
const lines = []

function post(pathname, payload, timeoutMs = 45000) {
  const data = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 5174, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        let parsed = {}
        try { parsed = body ? JSON.parse(body) : {} } catch (_) { parsed = { raw: body.slice(0, 1500) } }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: parsed })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout after ' + timeoutMs + 'ms')))
    req.write(data)
    req.end()
  })
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 5174, path: pathname, method: 'GET', timeout: 10000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        let parsed = {}
        try { parsed = body ? JSON.parse(body) : {} } catch (_) { parsed = { raw: body.slice(0, 300) } }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: parsed })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('get timeout')))
    req.end()
  })
}

;(async () => {
  const WALLET = '0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9'
  const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
  const USDG = '0x0a3b763d66c0e8c7555c986a3701e1dc1bf3954f'
  const ZERO = '0x0000000000000000000000000000000000000000'
  const WETH_OLD_WRONG = '0x0bD7D3088E1639FbA988df18A801114EAcAd73'
  const USDG_OLD_WRONG = '0x5fc5360D0400a0Fd42af552ADD042D716Fd168'

  try {
    lines.push('=== T0: GET /api/health (sanity) ===')
    const t0 = await get('/api/health')
    lines.push(`status=${t0.status} ${t0.ok ? 'OK' : 'FAIL'} ${JSON.stringify(t0.body).slice(0, 250)}`)
  } catch (e) { lines.push(`T0 THREW: ${e.message}`) }

  const tests = [
    {
      name: 'V3: CORRECT WETH->USDG (4663->4663). Expect 404 "No LI.FI route..." since pair has no route (NOT 502 "service unavailable")',
      payload: { fromChain: 4663, toChain: 4663, fromToken: WETH, toToken: USDG, fromAmount: '1000000000000000000', fromAddress: WALLET, toAddress: WALLET, slippage: 0.01 },
      wantStatus: 404, wantCode: 'NO_ROUTE', wantMatch: /No LI\.FI route/,
    },
    {
      name: 'V4: CORRECT native(zero)->WETH (default UI flow). Expect 200 SUCCESS with quoteProof, quoteId, expectedOutput, expiresAt',
      payload: { fromChain: 4663, toChain: 4663, fromToken: ZERO, toToken: WETH, fromAmount: '1000000000000000000', fromAddress: WALLET, toAddress: WALLET, slippage: 0.01 },
      wantStatus: 200,
    },
    {
      name: 'V5: OLD WRONG addresses (before fix). Expect 400 LIFI_INVALID_REQUEST with actual LI.FI "Invalid address" message (NOT 502 generic "service unavailable")',
      payload: { fromChain: 4663, toChain: 4663, fromToken: WETH_OLD_WRONG, toToken: USDG_OLD_WRONG, fromAmount: '1000000000000000000', fromAddress: WALLET, toAddress: WALLET, slippage: 0.01 },
      wantStatus: 400, wantCode: 'LIFI_INVALID_REQUEST', wantMatch: /Invalid address|LI\.FI rejected/,
    },
  ]
  for (const t of tests) {
    lines.push(`\n=== ${t.name} ===`)
    try {
      const r = await post('/api/lifi/quote', t.payload)
      lines.push(`status=${r.status} ok=${r.ok}`)
      if (r.ok) {
        const q = r.body?.quote || {}
        lines.push(`BODY success=${r.body?.success} quoteId=${q.quoteId} expectedOutput=${q.expectedOutput} txTo=${q.transactionRequest?.to} quoteProof.len=${q.quoteProof ? String(q.quoteProof).length : 0} expiresAt=${q.expiresAt} volumeUsd=${q.volumeUsd}`)
        lines.push(`result: PASS (200 OK with quoteProof:${Boolean(q.quoteProof)} quoteId:${Boolean(q.quoteId)} expiresAt:${Boolean(q.expiresAt)})`)
      } else {
        lines.push(`code=${r.body?.code} error=${r.body?.error}`)
        const statusOk = t.wantStatus === undefined || r.status === t.wantStatus
        const codeOk = !t.wantCode || (r.body?.code === t.wantCode)
        const msgOk = !t.wantMatch || t.wantMatch.test(String(r.body?.error || ''))
        lines.push(`result: ${statusOk && codeOk && msgOk ? 'PASS' : 'FAIL'}` + ` (wantStatus:${t.wantStatus ?? 'any'} wantCode:${t.wantCode ?? 'any'} wantMatch:${t.wantMatch?.toString().slice(1, 30) ?? ''})`)
      }
    } catch (e) {
      lines.push(`THREW: ${e.message}`)
    }
  }
})().catch((e) => {
  lines.push(`\nFINAL TOP-LEVEL THROW: ${e.message}\n${e.stack || ''}`)
}).finally(() => {
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
  process.exit(0)
})
