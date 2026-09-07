import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { confirmSolanaTransaction, getLatestBlockhash, sendSignedSolanaTransaction } from './roninService'

const SHIELD_STATS_URL = '/api/ronin/shield-stats'

export async function getShieldStats() {
  const response = await fetch(SHIELD_STATS_URL, { cache: 'no-store' })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || 'RONIN Shield public stats are unavailable.')
  return payload
}

export async function supportShield({ provider, fromAddress, treasuryAddress, solAmount }) {
  if (!provider) throw new Error('Phantom wallet was not found. Please reconnect Phantom and try again.')
  const lamports = Math.round(Number(solAmount) * 1_000_000_000)
  if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error('Enter a positive SOL contribution.')
  const from = new PublicKey(fromAddress)
  const to = new PublicKey(treasuryAddress)
  const { blockhash } = await getLatestBlockhash()
  const transaction = new Transaction({ feePayer: from, recentBlockhash: blockhash }).add(
    SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }),
  )
  let signature
  if (typeof provider.signAndSendTransaction === 'function') {
    const result = await provider.signAndSendTransaction(transaction)
    signature = result?.signature || result
  } else if (typeof provider.signTransaction === 'function') {
    const signed = await provider.signTransaction(transaction)
    signature = await sendSignedSolanaTransaction(signed.serialize())
  } else {
    throw new Error('The connected wallet does not expose a Solana signing method.')
  }
  if (!signature) throw new Error('The wallet did not return a transaction signature.')
  await Promise.race([
    confirmSolanaTransaction(signature, 60_000),
    new Promise((_, reject) => window.setTimeout(() => reject(new Error('Transaction confirmation timed out. It may still land; check Solana Explorer.')), 60_000)),
  ])
  return signature
}
