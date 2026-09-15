export const ADMIN_SOLANA_WALLET = (import.meta.env.VITE_ADMIN_SOLANA_WALLET || '').trim()

export function isAdminWalletAddress(address) {
  if (!address || !ADMIN_SOLANA_WALLET) return false
  return address.toLowerCase() === ADMIN_SOLANA_WALLET.toLowerCase()
}
