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
export const ROBINHOOD_TOKEN_CANDIDATES = Object.freeze([
  candidate('WETH', 'Wrapped Ether', '0x0bD7D3088E1639FbA988df18A801114EAcAd73', ['core'], { decimals: 18 }),
  candidate('USDG', 'Global Dollar', '0x5fc5360D0400a0Fd42af552ADD042D716Fd168', ['core'], { decimals: 18 }),
  candidate('CASHCAT', 'Cash Cat', '0x020bfc650a365f8bb26819deabf3e21291018b4', ['meme', 'l3'], { isMeme: true }),
  candidate('CCC', 'Cashcat Chain', '0xddec0170ceb4426ea05f2bd48d5ff4a4afa6615', ['utility', 'ai'], { decimals: 18 }),
  candidate('STONKBROKER', 'StonkBroker', '0xe934e36a439c94017b64a3fece66af12099ab50', ['utility', 'meme'], { isMeme: true }),
  candidate('INDEX', 'The Index', '0x56910d4409f3a0c78c64dd8d0545ff0705389870', ['meme', 'index'], { isMeme: true }),
  candidate('SYNAPSE', 'Hood Synapse by Virtuals', '0x1E75e55B4b2d77B62f07D5AA86401057584aDd', ['ai', 'data']),
  candidate('NASDUCK', 'Nasduck', '0x78fc7e13bccab8a7aedc5b8465c3442d6d7d9d64', ['meme'], { isMeme: true }),
  candidate('MONEROCHAN', 'Monero-Chan', '0x0908a927f27c96e5f21fa15bcd296974542da0f', ['meme'], { isMeme: true }),
  candidate('PIPEDOG', 'pipedog', '0x5cb6f181081301b44905f3ae15419112ecabd8a6', ['meme'], { isMeme: true }),
  candidate('UNIPCS', 'Unipcs', '0x7df5daaF80e65dfcc7a1435d9b52bcb2b5753fbe', ['meme', 'community'], { isMeme: true }),
  candidate('AOBS', 'Agent OBS', '0x47366e0f257ac009e82bd46fb74e2fb50826ce98', ['ai', 'meme'], { isMeme: true }),
  candidate('PORT', 'Port', '0xafa57c4c5a72d36530c8e816ad6e9a5947941536', ['meme', 'project'], { isMeme: true }),
  candidate('BOOMER', 'Boomer', '0x73c2de14c7fa0a57cc2d9722b959ea70b881ffe4', ['meme'], { isMeme: true }),
  candidate('SHRUB', "Lil' Shrub", '0x5d9144d2d017386519a7134fcc7f1e4ba222920c', ['meme'], { isMeme: true }),
  candidate('CUPCAKE', 'Cupcake', '0x0ae4cab49b6f048f9c589a522620eb0fc4ededc6', ['meme'], { isMeme: true }),
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
