// Verify that corrected addresses work with LI.FI upstream + local proxy
const fs = require('node:fs')
const path = require('node:path')
const LIFI_KEY = '0796a97f-b8f1-48b9-bd77-ac06fb92fddc.1a394368-836e-4123-a548-aff974e6d222'
const out = []

async function lifiGet(q) {
  const res = await fetch(`https://li.quest/v1${q}`, {
    headers: { 'x-lifi-api-key': LIFI_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  })
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
    signal: AbortSignal.timeout(25000),
  })
  const text = await res.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: res.status, ok: res.ok, body }
}

;(async () => {
  try {
    const correctedWeth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
    const correctedUsdg = '0x0a3b763d66c0e8c7555c986a3701e1dc1bf3954f'
    const wallet = '0xDbD2f56Eb43CE4fe8DF7322742DDdCB9F48064a9'

    out.push('=== V1: Upstream LI.FI /quote WETH(CORRECT)->USDG(CORRECT) 1e18 ===')
    const v1 = await lifiGet(`/quote?fromChain=4663&toChain=4663&fromToken=${correctedWeth}&toToken=${correctedUsdg}&fromAmount=1000000000000000000&fromAddress=${wallet}&toAddress=${wallet}&slippage=0.01&integrator=RoninSamurai`)
    out.push(`status=${v1.status} ok=${v1.ok}`)
    out.push(v1.ok
      ? `SUCCESS: id=${v1.body.id || v1.body?.toolDetails?.key} toAmount=${v1.body?.estimate?.toAmount} tx.to=${v1.body?.transactionRequest?.to}`
      : `FAIL body=${JSON.stringify(v1.body).slice(0, 500)}`)

    out.push('\n=== V2: Upstream LI.FI /quote native(zero)->WETH(CORRECT) 1e18 ===')
    const v2 = await lifiGet(`/quote?fromChain=4663&toChain=4663&fromToken=0x0000000000000000000000000000000000000000&toToken=${correctedWeth}&fromAmount=1000000000000000000&fromAddress=${wallet}&toAddress=${wallet}&slippage=0.01&integrator=RoninSamurai`)
    out.push(`status=${v2.status} ok=${v2.ok}`)
    out.push(v2.ok
      ? `SUCCESS: id=${v2.body.id || v2.body?.toolDetails?.key} toAmount=${v2.body?.estimate?.toAmount} tx.to=${v2.body?.transactionRequest?.to}`
      : `FAIL body=${JSON.stringify(v2.body).slice(0, 500)}`)

    out.push('\n=== V3: Local POST /api/lifi/quote WETH(CORRECT)->USDG(CORRECT) ===')
    try {
      const v3 = await localPost('/api/lifi/quote', {
        fromChain: 4663, toChain: 4663,
        fromToken: correctedWeth, toToken: correctedUsdg,
        fromAmount: '1000000000000000000',
        fromAddress: wallet, toAddress: wallet,
        slippage: 0.01,
      })
      out.push(`status=${v3.status} ok=${v3.ok}`)
      out.push(v3.ok
        ? `SUCCESS: quoteId=${v3.body?.quote?.quoteId} expectedOutput=${v3.body?.quote?.expectedOutput} quoteProof.present=${Boolean(v3.body?.quote?.quoteProof)} expiresAt=${v3.body?.quote?.expiresAt}`
        : `FAIL code=${v3.body?.code} error=${v3.body?.error}`)
    } catch (e) {
      out.push(`Local /api/lifi/quote fetch failed: ${e?.message || e}`)
    }

    out.push('\n=== V4: Local POST /api/lifi/quote native->WETH(CORRECT) ===')
    try {
      const v4 = await localPost('/api/lifi/quote', {
        fromChain: 4663, toChain: 4663,
        fromToken: '0x0000000000000000000000000000000000000000',
        toToken: correctedWeth,
        fromAmount: '1000000000000000000',
        fromAddress: wallet, toAddress: wallet,
        slippage: 0.01,
      })
      out.push(`status=${v4.status} ok=${v4.ok}`)
      out.push(v4.ok
        ? `SUCCESS: quoteId=${v4.body?.quote?.quoteId} expectedOutput=${v4.body?.quote?.expectedOutput} quoteProof.present=${Boolean(v4.body?.quote?.quoteProof)}`
        : `FAIL code=${v4.body?.code} error=${v4.body?.error}`)
    } catch (e) {
      out.push(`Local /api/lifi/quote fetch failed: ${e?.message || e}`)
    }

    out.push('\n=== V5: Local POST /api/lifi/quote with OLD addresses (should return 4xx with actual LI.FI message) ===')
    try {
      const v5 = await localPost('/api/lifi/quote', {
        fromChain: 4663, toChain: 4663,
        fromToken: '0x0bD7D3088E1639FbA988df18A801114EAcAd73', // OLD WRONG
        toToken: '0x5fc5360D0400a0Fd42af552ADD042D716Fd168',   // OLD WRONG
        fromAmount: '1000000000000000000',
        fromAddress: wallet, toAddress: wallet,
        slippage: 0.01,
      })
      out.push(`status=${v5.status} ok=${v5.ok}`)
      out.push(`code=${v5.body?.code} error=${v5.body?.error}`)
    } catch (e) {
      out.push(`Local /api/lifi/quote fetch failed: ${e?.message || e}`)
    }
  } catch (e) {
    out.push(`\nTHREW: ${e?.message || e}\n${e?.stack || ''}`)
  } finally {
    const outPath = path.join(__dirname, '__probe_lifi_verify.txt')
    fs.writeFileSync(outPath, out.join('\n'), 'utf8')
    console.log('WROTE', outPath)
    console.log('\n' + out.join('\n'))
  }
})()
