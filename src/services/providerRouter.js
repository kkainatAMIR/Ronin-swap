import { getChain } from '../config/chains'

export function selectSwapProvider(fromChainKey, toChainKey = fromChainKey) {
  const from = getChain(fromChainKey)
  const to = getChain(toChainKey)
  if (!from || !to) throw new Error('Unsupported swap network.')
  if (from.key === 'solana' && to.key === 'solana') return 'jupiter'
  if (from.key === 'robinhood' || to.key === 'robinhood') return 'lifi'
  if (from.key === 'ethereum' && to.key === 'ethereum') return 'ethereum'
  if (from.type === 'EVM' && to.type === 'EVM') return 'lifi'
  throw new Error(`No provider is configured for ${from.name} to ${to.name}.`)
}

export function canExecuteProvider(provider) {
  return provider === 'jupiter' || provider === 'ethereum'
}
