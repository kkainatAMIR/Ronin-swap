const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/

function normalizeHex(value, fallback = '0x0') {
  if (value == null || value === '') return fallback
  if (typeof value === 'bigint') return `0x${value.toString(16)}`
  if (typeof value === 'number' && Number.isFinite(value)) return `0x${BigInt(value).toString(16)}`
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (HEX_PATTERN.test(trimmed)) return trimmed === '' ? fallback : trimmed
  }
  return fallback
}

function toGasValue(value) {
  if (value == null || value === '') return undefined
  if (typeof value === 'bigint') return `0x${value.toString(16)}`
  if (typeof value === 'number' && Number.isFinite(value)) return `0x${BigInt(value).toString(16)}`
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value.trim())) return value.trim()
  return undefined
}

export function getLifiApprovalRequest(quote) {
  const approval = quote?.action?.approval || quote?.approval || quote?.transactionRequest?.approval || quote?.transactionRequest?.approvalRequest || null
  const to = approval?.to || approval?.address || approval?.spender || approval?.contractAddress || quote?.transactionRequest?.approveTo || quote?.transactionRequest?.approvalAddress || quote?.transactionRequest?.approvalTo || null
  const data = approval?.data || approval?.txData || approval?.callData || quote?.transactionRequest?.approvalData || quote?.transactionRequest?.data && quote?.transactionRequest?.data.startsWith('0x095ea7b3') ? quote.transactionRequest.data : null
  if (!to || !data || !ADDRESS_PATTERN.test(String(to))) return null
  return { to, data: String(data).trim(), value: normalizeHex(approval?.value ?? '0x0'), gas: toGasValue(approval?.gasLimit ?? approval?.gas ?? quote?.transactionRequest?.gasLimit ?? quote?.transactionRequest?.gas) }
}

export async function getLifiQuote(request) {
  const response = await fetch('/api/lifi/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.error || 'LI.FI quote unavailable.')
    error.code = body.code || `HTTP_${response.status}`
    throw error
  }
  return body.quote
}

export async function getLifiStatus({ txHash, fromChain, toChain, bridge }) {
  const response = await fetch('/api/lifi/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash, fromChain, toChain, bridge }) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || 'LI.FI status unavailable.')
  return body.status
}

export function lifiStatusIsComplete(status) {
  return ['DONE', 'COMPLETED', 'SUCCESS'].includes(String(status?.status || status?.state || '').toUpperCase())
}

export function lifiStatusIsFailed(status) {
  return ['FAILED', 'CANCELLED', 'EXPIRED'].includes(String(status?.status || status?.state || '').toUpperCase())
}

export async function approveLifiTransaction({ provider, approvalRequest, expectedChainId, wallet }) {
  if (!provider || !approvalRequest || !ADDRESS_PATTERN.test(String(approvalRequest.to || '')) || !/^0x[0-9a-fA-F]*$/.test(String(approvalRequest.data || '')) || !wallet || !ADDRESS_PATTERN.test(wallet)) throw new Error('LI.FI returned an invalid approval request.')
  const currentChainId = Number.parseInt(await provider.request({ method: 'eth_chainId' }), 16)
  if (currentChainId !== Number(expectedChainId)) throw new Error('MetaMask is connected to the wrong network.')
  const accounts = await provider.request({ method: 'eth_accounts' })
  if (!accounts?.[0] || accounts[0].toLowerCase() !== wallet.toLowerCase()) throw new Error('MetaMask wallet changed. Reconnect before signing.')
  const gas = toGasValue(approvalRequest.gas)
  return provider.request({ method: 'eth_sendTransaction', params: [{ from: wallet, to: approvalRequest.to, data: approvalRequest.data, value: normalizeHex(approvalRequest.value, '0x0'), ...(gas ? { gas } : {}) }] })
}

export async function sendLifiTransaction({ provider, transactionRequest, expectedChainId, wallet }) {
  if (!provider || !transactionRequest || !ADDRESS_PATTERN.test(String(transactionRequest.to || '')) || !HEX_PATTERN.test(String(transactionRequest.data || '')) || !wallet || !ADDRESS_PATTERN.test(wallet)) throw new Error('LI.FI returned an invalid transaction request.')
  const currentChainId = Number.parseInt(await provider.request({ method: 'eth_chainId' }), 16)
  if (currentChainId !== Number(expectedChainId)) throw new Error('MetaMask is connected to the wrong network.')
  const accounts = await provider.request({ method: 'eth_accounts' })
  if (!accounts?.[0] || accounts[0].toLowerCase() !== wallet.toLowerCase()) throw new Error('MetaMask wallet changed. Reconnect before signing.')
  const gas = toGasValue(transactionRequest.gasLimit || transactionRequest.gas)
  const value = normalizeHex(transactionRequest.value, '0x0')
  return provider.request({ method: 'eth_sendTransaction', params: [{ from: wallet, to: transactionRequest.to, data: transactionRequest.data, value, ...(gas ? { gas } : {}) }] })
}