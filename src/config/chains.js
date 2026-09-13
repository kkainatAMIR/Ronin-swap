export const CHAIN_IDS = Object.freeze({
  SOLANA: 'solana',
  ETHEREUM: 1,
  ROBINHOOD: 4663,
  BASE: 8453,
  ARBITRUM: 42161,
})

export const CHAIN_TYPES = Object.freeze({ SOLANA: 'SVM', EVM: 'EVM' })

export const CHAINS = Object.freeze({
  solana: Object.freeze({
    key: CHAIN_IDS.SOLANA,
    chainId: CHAIN_IDS.SOLANA,
    name: 'Solana',
    type: CHAIN_TYPES.SOLANA,
    nativeSymbol: 'SOL',
    wallet: 'Solana wallet',
    provider: 'jupiter',
    explorer: 'https://solscan.io/tx/',
    enabled: true,
  }),
  ethereum: Object.freeze({
    key: 'ethereum',
    chainId: CHAIN_IDS.ETHEREUM,
    name: 'Ethereum',
    type: CHAIN_TYPES.EVM,
    nativeSymbol: 'ETH',
    wallet: 'MetaMask',
    provider: 'ethereum',
    explorer: 'https://etherscan.io/tx/',
    enabled: true,
  }),
  robinhood: Object.freeze({
    key: 'robinhood',
    chainId: CHAIN_IDS.ROBINHOOD,
    name: 'Robinhood Chain',
    type: CHAIN_TYPES.EVM,
    nativeSymbol: 'ETH',
    wallet: 'MetaMask',
    provider: 'lifi',
    rpcUrl: import.meta.env.VITE_ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com/',
    explorer: import.meta.env.VITE_ROBINHOOD_EXPLORER_URL || 'https://robinhoodchain.blockscout.com/',
    configuredName: import.meta.env.VITE_ROBINHOOD_NETWORK_NAME || 'Robinhood Chain',
    enabled: true,
    executionEnabled: false,
  }),
  base: Object.freeze({ key: 'base', chainId: CHAIN_IDS.BASE, name: 'Base', type: CHAIN_TYPES.EVM, nativeSymbol: 'ETH', wallet: 'MetaMask', provider: 'lifi', enabled: false }),
  arbitrum: Object.freeze({ key: 'arbitrum', chainId: CHAIN_IDS.ARBITRUM, name: 'Arbitrum', type: CHAIN_TYPES.EVM, nativeSymbol: 'ETH', wallet: 'MetaMask', provider: 'lifi', enabled: false }),
})

export const SUPPORTED_SWAP_CHAINS = Object.freeze(['solana', 'ethereum', 'robinhood'])

export function getChain(key) {
  return CHAINS[key] || null
}

export function chainAssetId(chainKey, address) {
  const chain = getChain(chainKey)
  if (!chain) return null
  return `${chain.chainId}:${address || 'native'}`
}
