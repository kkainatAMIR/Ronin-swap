const CHAIN_ID = 4663

// Local logo path prefix — every candidate now carries a logoURI pointing to a
// locally-served image so the swap UI always has a fallback logo even when
// DexScreener does not return one for a given pair.
const LOGO_PREFIX = '/images/tokens/robinhood'

const candidate = (symbol, name = symbol, address = null, categories = [], { isMeme = false, verification = 'verified', productionEnabled = true, decimals = 18, logoURI = null } = {}) => Object.freeze({
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
  logoURI,
})

// Approved Robinhood Chain shortlist supplied by the client.
// Addresses sourced live from LI.FI /tokens?chains=4663 and verified on
// DexScreener (https://api.dexscreener.com/tokens/v1/robinhood/<address>) so
// every listed token resolves to a real pair on the Robinhood chain (4663).
// Logos are stored locally under public/images/tokens/robinhood/ so they do
// not depend on a third-party CDN being available at render time.
export const ROBINHOOD_TOKEN_CANDIDATES = Object.freeze([
  candidate('WETH', 'Wrapped Ether', '0x0bd7d308f8e1639fab988df18a8011f41eacad73', ['core'], { decimals: 18, logoURI: `${LOGO_PREFIX}/weth.png` }),
  candidate('USDG', 'Global Dollar (Paxos USDG)', '0x0a3b763d66c0e8c7555c986a3701e1dc1bf3954f', ['core'], { decimals: 6, logoURI: `${LOGO_PREFIX}/usdg.png` }),
  candidate('CASHCAT', 'Cash Cat', '0x020bfc650a365f8bb26819deaabf3e21291018b4', ['meme', 'l3'], { isMeme: true, logoURI: `${LOGO_PREFIX}/cashcat.jpg` }),
  candidate('CCC', 'Cashcat Chain', '0xddec0170ceb4426ea05f2fbd485dffa4fafa6615', ['utility', 'ai'], { decimals: 18, logoURI: `${LOGO_PREFIX}/ccc.jpg` }),
  candidate('STONKBROKER', 'StonkBroker', '0xe934e36a439c94017b64a3fece66af12099ab50', ['utility', 'meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/stonkbroker.jpg` }),
  candidate('INDEX', 'The Index', '0x56910d4409f3a0c78c64dd8d0545ff0705389870', ['meme', 'index'], { isMeme: true, logoURI: `${LOGO_PREFIX}/index.jpg` }),
  candidate('SYNAPSE', 'Hood Synapse by Virtuals', '0xe96184c99b3a3b89c907ea0753c5fde9e3c572ab', ['ai', 'data'], { logoURI: `${LOGO_PREFIX}/synapse.jpg` }),
  candidate('NASDUCK', 'Nasduck', '0x78fc7e13bccab8a7aedc5b8465c3442d6d7d9d64', ['meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/nasduck.jpg` }),
  candidate('MONEROCHAN', 'Monero-Chan', '0x12fdd61dff534bdb85a605506c89d869d8b31e18', ['meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/monerochan.jpg` }),
  candidate('PIPEDOG', 'pipedog', '0x5cb6f181081301b44905f3ae15419112ecabd8a6', ['meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/pipedog.jpg` }),
  candidate('UNIPCS', 'Unipcs', '0x7df5daaf80e65dfcc7a1435d9b52bcf2b5753fbe', ['meme', 'community'], { isMeme: true, logoURI: `${LOGO_PREFIX}/unipcs.jpg` }),
  candidate('AOBS', 'Agent OBS', '0x47366e0f257ac009e82bd46fb74e2fb50826ce98', ['ai', 'meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/aobs.jpg` }),
  candidate('PORT', 'Port', '0xafa57c4c5a72d36530c8e816ad6e9a5947941536', ['meme', 'project'], { isMeme: true, logoURI: `${LOGO_PREFIX}/port.jpg` }),
  candidate('BOOMER', 'Boomer', '0x73c2de14c7fa0a57cc2d9722b959ea70b881ffe4', ['meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/boomer.jpg` }),
  candidate('SHRUB', "Lil' Shrub", '0x5d9144d2d017386519a7134fcc7f1e4ba22f920c', ['meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/shrub.jpg` }),
  candidate('CUPCAKE', 'Cupcake', '0x0ae4cab49b6f048f9c589a522620bebfc4ededc6', ['meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/cupcake.jpg` }),
  candidate('ZZZ', 'ZZZ', '0x7dbf38976f6d3b9c529e7d9484a71898b409ee6a', ['meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/zzz.jpg` }),
  candidate('PONS', 'Pons', '0x39dbed3a2bd333467115de45665cc57f813c4571', ['meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/pons.jpg` }),
  candidate('DOGO', 'Dogo', '0x77b0aa38451ccdc1b42587e2f80b9879a7f82356', ['meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/dogo.png` }),
  candidate('MEME', 'Meme', '0x385f4f8ae47651ce5f58f5265395a669f8281e18', ['meme'], { isMeme: true, logoURI: `${LOGO_PREFIX}/meme.jpg` }),
])

export const ROBINHOOD_VERIFIED_TOKENS = Object.freeze(
  ROBINHOOD_TOKEN_CANDIDATES.filter((token) => token.address && token.verification === 'verified' && token.productionEnabled),
)

export function isProductionRobinhoodToken(token) {
  return Boolean(token?.chainId === CHAIN_ID && token.address && token.verification === 'verified' && token.productionEnabled)
}
