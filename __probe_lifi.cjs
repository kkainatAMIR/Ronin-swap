// Probe: test upstream LI.FI + local /api/lifi/quote.
// Writes to /__probe_lifi_out.txt (this file is ignored in .vercelignore — delete after probe)
const fs = require('node:fs')
const path = require('node:path')
const out = []
const LIFI_KEY = '0796a97f-b8f1-48b9-bd77-ac06fb92fddc.1a394368-836e-4123-a548-aff974e6d222'
const LIFI_BASE = 'https://li.quest/v1'

function fmt(obj) { try { return JSON.stringify(obj, null, 2) } catch { return String(obj) } }

async function lifiGet(q) {
  const url = `${LIFI_BASE}${q}`
  const res = await fetch(url, { headers: { 'x-lifi-api-key': LIFI_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
  const text = await res.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: res.status, ok: res.ok, body }
}

async function localPost(api, payload) {
  const res = await fetch(`http://localhost:5174${api}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: res.status, ok: res.ok, body }
}

;(async () => {
  try {
    out.push('=== T1: Upstream LI.FI /tokens chains=4663 ===')
    const t1 = await lifiGet('/tokens?chains=4663')
    out.push(`status=${t1.status} ok=${t1.ok}`)
    out.push(`tokenCount4663=${t1.body?.tokens?.['4663']?.length ?? 0}`)

    out.push('\n=== T2: Upstream LI.FI /quote WETH->USDG ERC20 1e18 ===')
    const t2 = await lifiGet('/quote?fromChain=4663&toChain=4663&fromToken=0x0bD7D3088E1639FbA988df18A801114EAcAd73&toToken=0x5fc5360D0400a0Fd42af552ADD042D716Fd168&fromAmount=1000000000000000000&fromAddress=0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9&toAddress=0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9&slippage=0.01&integrator=RoninSamurai')
    out.push(`status=${t2.status} ok=${t2.ok}`)
    out.push(t2.ok
      ? `id=${t2.body.id || t2.body?.toolDetails?.key} toAmount=${t2.body?.estimate?.toAmount} tx.to=${t2.body?.transactionRequest?.to}`
      : `body=${fmt(t2.body).slice(0, 1500)}`)

    out.push('\n=== T3: Upstream LI.FI /quote native(zero)->USDG 1e18 ===')
    const t3 = await lifiGet('/quote?fromChain=4663&toChain=4663&fromToken=0x0000000000000000000000000000000000000000&toToken=0x5fc5360D0400a0Fd42af552ADD042D716Fd168&fromAmount=1000000000000000000&fromAddress=0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9&toAddress=0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9&slippage=0.01&integrator=RoninSamurai')
    out.push(`status=${t3.status} ok=${t3.ok}`)
    out.push(t3.ok
      ? `id=${t3.body.id || t3.body?.toolDetails?.key} toAmount=${t3.body?.estimate?.toAmount} tx.to=${t3.body?.transactionRequest?.to}`
      : `body=${fmt(t3.body).slice(0, 1500)}`)

    out.push('\n=== T4: Local POST /api/lifi/quote WETH->USDG ===')
    const t4 = await localPost('/api/lifi/quote', {
      fromChain: 4663, toChain: 4663,
      fromToken: '0x0bD7D3088E1639FbA988df18A801114EAcAd73',
      toToken: '0x5fc5360D0400a0Fd42af552ADD042D716Fd168',
      fromAmount: '1000000000000000000',
      fromAddress: '0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9',
      toAddress: '0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9',
      slippage: 0.01,
    })
    out.push(`status=${t4.status} ok=${t4.ok}`)
    out.push(`body=${fmt(t4.body).slice(0, 2000)}`)

    out.push('\n=== T5: Local POST /api/lifi/quote native(zero)->USDG ===')
    const t5 = await localPost('/api/lifi/quote', {
      fromChain: 4663, toChain: 4663,
      fromToken: '0x0000000000000000000000000000000000000000',
      toToken: '0x5fc5360D0400a0Fd42af552ADD042D716Fd168',
      fromAmount: '1000000000000000000',
      fromAddress: '0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9',
      toAddress: '0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9',
      slippage: 0.01,
    })
    out.push(`status=${t5.status} ok=${t5.ok}`)
    out.push(`body=${fmt(t5.body).slice(0, 2000)}`)
  } catch (e) {
    out.push(`\nTHREW: ${e?.message || e}\n${e?.stack || ''}`)
  } finally {
    const outPath = path.join(__dirname, '__probe_lifi_out.txt')
    fs.writeFileSync(outPath, out.join('\n'), 'utf8')
    console.log('WROTE', outPath, `${out.length} lines`)
  }
})()
