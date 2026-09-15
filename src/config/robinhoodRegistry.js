const CHAIN_ID = 4663

const candidate = (symbol, name = symbol, address = null, categories = [], { isMeme = false, verification = 'verified', productionEnabled = true, decimals = 18 } = {}) => Object.freeze({
  chainId: CHAIN_ID,
  chainKey: 'robinhood',
  type: 'erc20',
  symbol,
  name,
  address,
  decimals,
  categories,
  isMeme,
  verification,
  productionEnabled,
})

// Approved Robinhood Chain shortlist supplied by the client.
// Addresses sourced live from LI.FI /tokens?chains=4663 so LI.FI quotes succeed.
// Tokens not yet present in the LI.FI 4663 catalog are marked verification:'pending'
// so they cannot be selected for a LI.FI swap that would fail with "unknown token".
export const ROBINHOOD_TOKEN_CANDIDATES = Object.freeze([
  candidate('WETH', 'Wrapped Ether', '0x0bd7d308f8e1639fab988df18a8011f41eacad73', ['core'], { decimals: 18 }),
  candidate('USDG', 'Global Dollar (Paxos USDG)', '0x0a3b763d66c0e8c7555c986a3701e1dc1bf3954f', ['core'], { decimals: 6 }),
  candidate('CASHCAT', 'Cash Cat', '0x020bfc650a365f8bb26819deaabf3e21291018b4', ['meme', 'l3'], { isMeme: true }),
  candidate('CCC', 'Cashcat Chain', null, ['utility', 'ai'], { decimals: 18, verification: 'pending', productionEnabled: false }),
  candidate('STONKBROKER', 'StonkBroker', '0xe934e36a439c94017b64a3fece66af12099ab50', ['utility', 'meme'], { isMeme: true }),
  candidate('INDEX', 'The Index', '0x56910d4409f3a0c78c64dd8d0545ff0705389870', ['meme', 'index'], { isMeme: true }),
  candidate('SYNAPSE', 'Hood Synapse by Virtuals', null, ['ai', 'data'], { verification: 'pending', productionEnabled: false }),
  candidate('NASDUCK', 'Nasduck', null, ['meme'], { isMeme: true, verification: 'pending', productionEnabled: false }),
  candidate('MONEROCHAN', 'Monero-Chan', null, ['meme'], { isMeme: true, verification: 'pending', productionEnabled: false }),
  candidate('PIPEDOG', 'pipedog', '0x5cb6f181081301b44905f3ae15419112ecabd8a6', ['meme'], { isMeme: true }),
  candidate('UNIPCS', 'Unipcs', '0x7df5daaf80e65dfcc7a1435d9b52bcf2b5753fbe', ['meme', 'community'], { isMeme: true }),
  candidate('AOBS', 'Agent OBS', null, ['ai', 'meme'], { isMeme: true, verification: 'pending', productionEnabled: false }),
  candidate('PORT', 'Port', null, ['meme', 'project'], { isMeme: true, verification: 'pending', productionEnabled: false }),
  candidate('BOOMER', 'Boomer', null, ['meme'], { isMeme: true, verification: 'pending', productionEnabled: false }),
  candidate('SHRUB', "Lil' Shrub", null, ['meme'], { isMeme: true, verification: 'pending', productionEnabled: false }),
  candidate('CUPCAKE', 'Cupcake', null, ['meme'], { isMeme: true, verification: 'pending', productionEnabled: false }),
  candidate('ZZZ', 'ZZZ', '0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a', ['meme'], { isMeme: true }),
  candidate('PONS', 'Pons', null, ['meme'], { isMeme: true, verification: 'pending', productionEnabled: false }),
  candidate('DOGO', 'Dogo', null, ['meme'], { isMeme: true, verification: 'pending', productionEnabled: false }),
  candidate('MEME', 'Meme', null, ['meme'], { isMeme: true, verification: 'pending', productionEnabled: false }),
])

export const ROBINHOOD_VERIFIED_TOKENS = Object.freeze(
  ROBINHOOD_TOKEN_CANDIDATES.filter((token) => token.address && token.verification === 'verified' && token.productionEnabled),
)

export function isProductionRobinhoodToken(token) {
  return Boolean(token?.chainId === CHAIN_ID && token.address && token.verification === 'verified' && token.productionEnabled)
}
