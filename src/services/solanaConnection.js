import { Connection } from '@solana/web3.js'
import { SOLANA_RPC_URL } from './roninService'

let connection = null

// A single shared mainnet connection, built from the Helius/Solana RPC URL
// configured via VITE_SOLANA_RPC_URL. Used for confirming Buy RONIN swap
// transactions submitted through Jupiter.
export function getSolanaConnection() {
  if (!connection) {
    connection = new Connection(SOLANA_RPC_URL, { commitment: 'confirmed' })
  }
  return connection
}
