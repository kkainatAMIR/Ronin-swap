// Probe local /api/lifi/quote via raw http module (port 5174) — avoids undici IPv6 issues on Windows
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const out = []

function post(pathname, payload) {
  const data = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 5174,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 30000,
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        let parsed = {}
        try { parsed = body ? JSON.parse(body) : {} } catch { parsed = { raw: body } }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: parsed })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.write(data)
    req.end()
  })
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 5174, path: pathname, method: 'GET', timeout: 10000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        let parsed = {}
        try { parsed = body ? JSON.parse(body) : {} } catch { parsed = { raw: body.slice(0, 400) } }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body: parsed })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.end()
  })
}

;(async () => {
  const wallet = '0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9'
  const w = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'   // correct WETH
  const u = '0x0a3b763d66c0e8c7555c986a3701e1dc1bf3954f'   // correct USDG (6 dec)
  const z = '0x0000000000000000000000000000000000000000'

  out.push('=== T0: GET /api/health ===')
  try { const r = await get('/api/health'); out.push(`status=${r.status} ${JSON.stringify(r.body).slice(0, 200)}`) } catch (e) { out.push(`ERR ${e.message}`) }

  out.push('\n=== V3: CORRECT WETH->USDG (pair may have no real route): expect 404 NO_ROUTE (NOT 502 "service unavailable") ===')
  try {
    const r = await post('/api/lifi/quote', { fromChain: 4663, toChain: 4663, fromToken: w, toToken: u, fromAmount: '1000000000000000000', fromAddress: wallet, toAddress: wallet, slippage: 0.01 })
    out.push(`status=${r.status} ok=${r.ok}`)
    out.push(r.ok
      ? `SUCCESS: quoteId=${r.body?.quote?.quoteId} toAmount=${r.body?.quote?.expectedOutput} quoteProof=${Boolean(r.body?.quote?.quoteProof)} expiresAt=${r.body?.quote?.expiresAt}`
      : `FAIL: code=${r.body?.code} error=${r.body?.error}`)
  } catch (e) { out.push(`THREW ${e.message}`) }

  out.push('\n=== V4: CORRECT native(zero)->WETH (default UI after user picks WETH): expect 200 SUCCESS with quoteProof ===')
  try {
    const r = await post('/api/lifi/quote', { fromChain: 4663, toChain: 4663, fromToken: z, toToken: w, fromAmount: '1000000000000000000', fromAddress: wallet, toAddress: wallet, slippage: 0.01 })
    out.push(`status=${r.status} ok=${r.ok}`)
    out.push(r.ok
      ? `SUCCESS: quoteId=${r.body?.quote?.quoteId} toAmount=${r.body?.quote?.expectedOutput} txTo=${r.body?.quote?.transactionRequest?.to} quoteProof=${Boolean(r.body?.quote?.quoteProof)} expiresAt=${r.body?.quote?.expiresAt} volumeUsd=${r.body?.quote?.volumeUsd}`
      : `FAIL: code=${r.body?.code} error=${r.body?.error}`)
  } catch (e) { out.push(`THREW ${e.message}`) }

  out.push('\n=== V5: OLD WRONG addresses (BEFORE fix): expect 400 with actual LI.FI "Invalid address" message (NOT 502 "service unavailable") ===')
  try {
    const r = await post('/api/lifi/quote', { fromChain: 4663, toChain: 4663, fromToken: '0x0bD7D3088E1639FbA988df18A801114EAcAd73', toToken: '0x5fc5360D0400a0Fd42af552ADD042D716Fd168', fromAmount: '1000000000000000000', fromAddress: wallet, toAddress: wallet, slippage: 0.01 })
    out.push(`status=${r.status} ok=${r.ok}`)
    out.push(`code=${r.body?.code} error=${r.body?.error}`)
  } catch (e) { out.push(`THREW ${e.message}`) }

  const outPath = path.join(__dirname, '__probe_lifi_http.txt')
  fs.writeFileSync(outPath, out.join('\n'), 'utf8')
  console.log(out.join('\n'))
})()
