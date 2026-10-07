const DEFINITIVE_REJECTION_CODES = new Set([-32002, -32003])

export function classifySolanaBroadcastRpcError(rpcError, proxyTransportFailures = []) {
  if (proxyTransportFailures.length > 0) return 'SOLANA_BROADCAST_OUTCOME_UNKNOWN'
  const errorDetail = JSON.stringify(rpcError || {}).toLowerCase()
  if (/already.?processed|duplicate transaction|signature already exists/.test(errorDetail)) {
    return 'SOLANA_BROADCAST_OUTCOME_UNKNOWN'
  }
  return DEFINITIVE_REJECTION_CODES.has(Number(rpcError?.code))
    ? 'SOLANA_RPC_REJECTED'
    : 'SOLANA_BROADCAST_OUTCOME_UNKNOWN'
}
