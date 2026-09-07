import {
  RONIN_MINT,
  getSolBalance,
  getAllTokenAccounts,
  getSignaturesPaginated,
  getHeliusTransactions,
  analyzeSecurity,
} from './shieldService'

function humanAge(days) {
  if (!Number.isFinite(days) || days < 0) return 'Unknown'
  const years = Math.floor(days / 365.2425)
  const remainderAfterYears = days - Math.floor(years * 365.2425)
  const months = Math.floor(remainderAfterYears / 30.436875)
  const remainingDays = Math.max(0, Math.floor(remainderAfterYears - months * 30.436875))
  if (years > 0) return `${years}Y ${months}M ${remainingDays}D old`
  if (months > 0) return `${months}M ${remainingDays}D old`
  return `${remainingDays}D old`
}

function makeAgeValue(days) {
  const value = Number(days) || 0
  return {
    valueOf: () => value,
    toString: () => humanAge(value),
  }
}

function classifyRoninTransaction(tx, owner) {
  const transfers = Array.isArray(tx?.tokenTransfers)
    ? tx.tokenTransfers.filter((t) => t?.mint === RONIN_MINT)
    : []
  const incoming = transfers.some((t) => t?.toUserAccount === owner)
  const outgoing = transfers.some((t) => t?.fromUserAccount === owner)
  const type = String(tx?.type || '').toUpperCase()
  const description = String(tx?.description || '').toLowerCase()

  if (type === 'BURN' || tx?.events?.burn) return 'RONIN BURN'

  if (type === 'SWAP' || description.includes('swap')) {
    if (incoming && !outgoing) return 'RONIN BUY'
    if (outgoing && !incoming) return 'RONIN SELL'
    if (/\b(buy|bought|purchase|purchased)\b/.test(description)) return 'RONIN BUY'
    if (/\b(sell|sold|sale)\b/.test(description)) return 'RONIN SELL'
  }

  if (incoming) return 'RONIN RECEIVE'
  if (outgoing) return 'RONIN SEND'
  return type || 'TRANSACTION'
}

async function getLiveTransactions(owner, limit = 20) {
  const data = await getHeliusTransactions(owner, limit)
  if (!Array.isArray(data)) return null

  return {
    source: 'Helius',
    transactions: data.map((tx) => ({
      signature: tx.signature,
      timestamp: tx.timestamp ? tx.timestamp * 1000 : (tx.blockTime ? tx.blockTime * 1000 : null),
      type: classifyRoninTransaction(tx, owner),
      description: tx.description,
      status: tx.transactionError ? 'Failed' : 'Success',
      fee: tx.fee,
      feePayer: tx.feePayer,
      nativeTransfers: tx.nativeTransfers,
      tokenTransfers: tx.tokenTransfers,
      events: tx.events,
      raw: tx,
    })),
    updatedAt: Date.now(),
  }
}

export async function scanWalletLive(owner) {
  const results = {
    owner,
    timestamp: Date.now(),
    solBalance: null,
    tokenAccounts: null,
    transactions: null,
    walletAge: null,
    security: null,
    errors: {},
  }

  try { results.solBalance = await getSolBalance(owner) } catch (e) { results.errors.solBalance = e.message }
  try { results.tokenAccounts = await getAllTokenAccounts(owner) } catch (e) { results.errors.tokenAccounts = e.message }

  try {
    results.transactions = await getLiveTransactions(owner, 20)
    if (!results.transactions) throw new Error('Helius enhanced transaction history unavailable.')
  } catch (e) {
    results.errors.transactions = e.message
    results.transactions = { source: 'RPC', transactions: [] }
  }

  try {
    const allSigs = await getSignaturesPaginated(owner, 5, 1000)
    const withTime = allSigs.filter((s) => s?.blockTime)
    if (!withTime.length) {
      results.walletAge = { available: false, reason: 'No timestamped activity' }
    } else {
      const oldest = withTime.reduce((a, b) => a.blockTime < b.blockTime ? a : b)
      const firstActivity = new Date(oldest.blockTime * 1000)
      const days = Math.max(0, Math.floor((Date.now() - firstActivity.getTime()) / 86400000))
      results.walletAge = {
        available: true,
        days: makeAgeValue(days),
        daysNumber: days,
        ageText: humanAge(days),
        firstActivity,
        firstSignature: oldest.signature,
        totalSignaturesScanned: allSigs.length,
        isApproximate: allSigs.length >= 5000,
      }
    }
  } catch (e) {
    results.errors.walletAge = e.message
    results.walletAge = { available: false, reason: e.message }
  }

  try {
    results.security = analyzeSecurity({
      tokenAccounts: results.tokenAccounts,
      transactions: results.transactions,
      walletAge: results.walletAge,
      solBalance: results.solBalance,
    })
  } catch (e) {
    results.errors.security = e.message
  }

  return results
}
