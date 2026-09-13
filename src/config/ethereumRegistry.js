export const ETHEREUM_CHAIN_ID = 1
export const ETHEREUM_NATIVE = Object.freeze({ chainId: 1, type: 'native', address: null, symbol: 'ETH', name: 'Ether', decimals: 18, category: 'native', logoURI: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png', featured: true, verified: true })

function token(address, symbol, name, category = 'featured') {
  return Object.freeze({ chainId: 1, type: 'erc20', address, symbol, name, decimals: null, category, logoURI: `https://tokens.1inch.io/${address}.png`, fallbackLogoURI: `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${address}/logo.png`, featured: true, verified: true })
}

export const ETHEREUM_FEATURED_TOKENS = Object.freeze([
  ETHEREUM_NATIVE,
  token('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH', 'Wrapped Ether'),
  token('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 'USD Coin', 'stablecoin'),
  token('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT', 'Tether USD', 'stablecoin'),
  token('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC', 'Wrapped BTC'),
  token('0x6982508145454Ce325dDbE47a25d4ec3d2311933', 'PEPE', 'Pepe', 'meme'),
  token('0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', 'SHIB', 'Shiba Inu', 'meme'),
  token('0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C', 'SPX', 'SPX6900', 'meme'),
  token('0xaaeE1A9723aAdb7afA2810263653A34bA2C21C7a', 'MOG', 'Mog Coin', 'meme'),
  token('0xcf0C122c6b73fF809C693DB761e7baEBE62b6a2E', 'FLOKI', 'FLOKI', 'meme'),
  token('0x514910771AF9Ca656af840dff83E8264EcF986CA', 'LINK', 'Chainlink'),
  token('0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 'UNI', 'Uniswap'),
  token('0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2dDAE9', 'AAVE', 'Aave'),
  token('0x57e114B691Db790C35207b2e685D4A43181e6061', 'ENA', 'Ethena'),
  token('0x808507121B80C02388fAd14726482e061B8da827', 'PENDLE', 'Pendle'),
  token('0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', 'LDO', 'Lido DAO'),
  token('0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3', 'ONDO', 'Ondo'),
  token('0x812Ba41e071C7b7fA4eBcfb62df5F45f6fA853Ee', 'NEIRO', 'Neiro', 'meme'),
  token('0x594daad7D77592A2B97b725a7aD59D7E188B5BfA', 'APU', 'Apu Apustaja', 'meme'),
  token('0x72e4f9F808c49A2a61dE9c5896298920DC4eEEa9', 'BITCOIN', 'Bitcoin', 'meme'),
  token('0xD533a949740bb3306d119CC777fa900bA034cd52', 'CRV', 'Curve DAO Token'),
])

export const ETHEREUM_TOKEN_BY_ADDRESS = Object.freeze(Object.fromEntries(ETHEREUM_FEATURED_TOKENS.filter((item) => item.address).map((item) => [item.address.toLowerCase(), item])))

export const ETHEREUM_FEATURED_SECTIONS = Object.freeze({
  popular: ['ETH', 'WETH', 'USDC', 'USDT', 'WBTC', 'LINK', 'UNI', 'AAVE'],
  memes: ['PEPE', 'SHIB', 'SPX', 'MOG', 'FLOKI', 'NEIRO', 'APU', 'BITCOIN'],
  featured: ['ENA', 'PENDLE', 'LDO', 'ONDO', 'CRV'],
})

export const ETHEREUM_SWAP_TOKENS = ETHEREUM_FEATURED_TOKENS

export function ethereumTokenIdentity(tokenValue) {
  return `${ETHEREUM_CHAIN_ID}:${tokenValue.type === 'native' ? 'native' : tokenValue.address.toLowerCase()}`
}