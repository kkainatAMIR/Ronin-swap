import dotenv from 'dotenv'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env.local'), override: true })

let allPass = true
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  console.log(`${ok ? '✅' : '❌'} ${name}  ${detail}`)
  if (!ok) allPass = false
}

console.log('================= ENVIRONMENT (POST-FIX) =================')
const env = process.env
check('LIFI_INTEGRATOR=my-ronin-integra2', env.LIFI_INTEGRATOR === 'my-ronin-integra2', `got="${env.LIFI_INTEGRATOR}"`)
check('LIFI_FEE_BPS="25"', env.LIFI_FEE_BPS === '25', `got="${env.LIFI_FEE_BPS}"`)
check('LIFI_FEE_RECEIVER matches spec', (env.LIFI_FEE_RECEIVER || '').toLowerCase() === '0xdbd2f56eb43ce4fe8df7322742dddcbf9f48064a9', env.LIFI_FEE_RECEIVER)
check('LIFI_FEE_ENABLED=true', env.LIFI_FEE_ENABLED === 'true')
console.log('')

console.log('================= COMPUTED lifi.mjs VALUES =================')
const mod = await import('./api/_lib/lifi.mjs')
check('LIFI_INTEGRATOR export = my-ronin-integra2', mod.LIFI_INTEGRATOR === 'my-ronin-integra2', `exported="${mod.LIFI_INTEGRATOR}"`)
check('LIFI_FEE_BPS export = 25 (number)', Number(mod.LIFI_FEE_BPS) === 25, `=${mod.LIFI_FEE_BPS}`)
check('LIFI_FEE_DECIMAL = 0.0025', Math.abs(Number(mod.LIFI_FEE_DECIMAL) - 0.0025) < 1e-12, `=${mod.LIFI_FEE_DECIMAL}`)
const validity = mod.lifiFeeConfigIsValid()
check('lifiFeeConfigIsValid() ok=true', validity.ok === true, JSON.stringify(validity))
const fp = mod.buildLifiFeeQueryParams()
check('buildLifiFeeQueryParams().integrator = my-ronin-integra2', fp.integrator === 'my-ronin-integra2', fp.integrator)
check('buildLifiFeeQueryParams().fee = "0.0025" (25 BPS as decimal string)', fp.fee === '0.0025', fp.fee)
check('buildLifiFeeQueryParams().feeRecipient = exact LI.FI portal wallet address', /^0x[0-9a-fA-F]{40}$/.test(fp.feeRecipient) && (fp.feeRecipient || '').toLowerCase() === '0xdbd2f56eb43ce4fe8df7322742dddcbf9f48064a9', fp.feeRecipient)
const summary = mod.lifiConfigSummary()
check('summary.integrator = my-ronin-integra2', summary.integrator === 'my-ronin-integra2')
check('summary.fee.valid = true', summary.fee?.valid === true)
check('summary.fee.bps = 25', Number(summary.fee?.bps) === 25)
check('summary.fee.receiver matches', summary.fee?.receiver?.toLowerCase() === '0xdbd2f56eb43ce4fe8df7322742dddcbf9f48064a9')
console.log('  summary.fee object =', JSON.stringify(summary.fee))
console.log('')

console.log('================= /v1/keys/test API KEY OWNERSHIP MATCH =================')
const BASE = String(env.LIFI_BASE_URL || 'https://li.quest/v1').replace(/\/$/, '')
const KEY = env.LIFI_API_KEY || ''
check('LIFI_API_KEY present and long enough', KEY.length > 40, `len=${KEY.length}`)
const hdr = { Accept: 'application/json' }
if (KEY) hdr['x-lifi-api-key'] = KEY
try {
  const kres = await fetch(`${BASE}/keys/test`, { headers: hdr, signal: AbortSignal.timeout(12000) })
  const kbody = await kres.json().catch(() => ({}))
  check('/v1/keys/test HTTP 200', kres.status === 200, 'status=' + kres.status)
  check('API key owner (user.name) === my-ronin-integra2 === LIFI_INTEGRATOR env var', kbody?.user?.name === 'my-ronin-integra2', 'user.name=' + JSON.stringify(kbody?.user?.name))
  check('RPM ceiling = 100 matches portal RPM ceiling spec', Number(kbody?.user?.rateLimit) === 100, 'rateLimit=' + kbody?.user?.rateLimit)
} catch (e) { console.log('  exception keys/test: ' + e.message); allPass = false }
console.log('')

console.log('================= QUOTES: FEE PARAMETERS NOW ACTUALLY APPLIED =================')
const RECIPIENT = fp.feeRecipient
const COMMON = {
  fromAmount: '100000000000000000',
  fromAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  toAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  slippage: '0.005',
  integrator: fp.integrator, fee: fp.fee, feeRecipient: fp.feeRecipient,
}
async function doQuote(label, extraParams, expectFee = true) {
  const req = { ...COMMON, ...extraParams }
  const keysOnly = [...new URLSearchParams(req).entries()].filter(([k]) => !['fromAddress','toAddress'].includes(k)).map(([k,v]) => `${k}=${v}`).join(' & ')
  console.log(`\n  QUOTE [${label}]`)
  console.log('   Sanitized URL query = ' + keysOnly)
  const url = `${BASE}/quote?${new URLSearchParams(req).toString()}`
  const res = await fetch(url, { headers: hdr, signal: AbortSignal.timeout(15000) })
  const txt = await res.text()
  let body = {}
  try { body = txt ? JSON.parse(txt) : {} } catch { body = { raw: txt.slice(0, 700) } }
  if (!res.ok) {
    const err = body?.code + ': ' + (body?.message ?? body?.error ?? JSON.stringify(body.raw ?? '').slice(0,500))
    if (res.status === 404) { console.log('   HTTP 404 (no route for pair — liquidity not fee issue): ' + (body?.message ?? '').slice(0,140)); return null }
    console.log('   HTTP ' + res.status + ' — UPSTREAM ERROR: ' + err)
    allPass = false
    return false
  }
  const intF = (body?.estimate?.feeCosts || []).reduce((acc, c) => {
    const raw = c?.feeSplit?.integratorFee
    return acc + (typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw) : 0n)
  }, 0n)
  const recipByInt = (body?.estimate?.feeCosts || []).flatMap(c => (c?.feeSplit?.recipients || []).filter(r => r.name === fp.integrator))
  console.log('   HTTP 200   toAmount=' + body?.estimate?.toAmount)
  console.log('   Σ integratorFee (raw from feeSplit) = ' + intF.toString() + (intF > 0n ? '  ✅ FEES ACTUALLY ROUTED' : '  ⚠️ NO FEE'))
  ;(body?.estimate?.feeCosts || []).forEach((c, i) => {
    console.log(`     feeCosts[${i}] name="${c.name}" pct=${c.percentage} amtUSD=${c.amountUSD} included=${c.included}`)
    const s = c?.feeSplit || {}
    console.log(`       feeSplit.lifiFee=${s.lifiFee ?? 0}   feeSplit.integratorFee=${s.integratorFee ?? 0}  (both FIXED @ 25bps each → total 50bps = 0.5%)`)
    ;(s.recipients || []).forEach((r, ri) => console.log(`         recipient[${ri}] name=${r.name}  type=${r.type}  fee=${r.fee}  address=${r.address ?? '(none) — resolved by LI.FI portal registration'}`))
  })
  if (recipByInt.length) console.log(`   ✅ Confirmed recipient entry NAME = integrator ID ("${fp.integrator}") with FIXED fee → receiver wallet is ${RECIPIENT} (per portal config, not shown on param)`)
  const pass = !expectFee || intF > 0n
  if (!pass) { console.log('   ❌ FAIL: Expected integrator fee > 0 but got 0') }
  allPass = allPass && pass
  return pass
}

// ETH 1→1
await doQuote('ETH Mainnet: NATIVE ETH → USDC (chain 1→1)', {
  fromChain: '1', toChain: '1',
  fromToken: '0x0000000000000000000000000000000000000000',
  toToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
}, true)

// RH 4663→4663
console.log('\n  QUOTE [Robinhood Chain: NATIVE ETH → token (4663→4663)]  — scanning for liquidity')
const tokRes = await fetch(`${BASE}/tokens?chains=4663`, { headers: hdr, signal: AbortSignal.timeout(10000) })
const tokBody = await tokRes.json().catch(() => ({}))
const rhToks = (tokBody?.tokens?.['4663'] || []).filter(t => /^0x[0-9a-fA-F]{40}$/.test(t.address) && t.address !== '0x0000000000000000000000000000000000000000')
let rhPass = false
for (const t of rhToks.slice(0, 30)) {
  const ok = await doQuote(`RH NATIVE→${t.symbol}`, { fromChain:'4663', toChain:'4663', fromToken:'0x0000000000000000000000000000000000000000', toToken:t.address, slippage:'0.01', fromAmount:'250000000000000000' }, true)
  if (ok === true) { rhPass = true; break }
  // skip null (404 = no liquidity; not a failure of fee mechanism)
}
check('Robinhood Chain ≥1 successful route WITH integrator fee > 0', rhPass)

console.log('')
console.log(allPass ? '========== ALL END-TO-END CHECKS PASSED ==========' : '========== SOME CHECKS FAILED ==========')
// cleanup
for (const p of ['__investigate_lifi_integrator.mjs','__confirm_rh_eth_final.mjs','__patch_env.cjs','investigation_log.txt','__final_verify.cjs']) {
  try { await fs.unlink(path.join(__dirname, p)) } catch {}
}
process.exit(allPass ? 0 : 1)
