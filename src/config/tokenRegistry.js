const DEFAULT_RONIN_MINT = '2JVEVXoRsskapZ8T56MjMNJq6Dk3feEUYSRmzkkipump'
const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || globalThis.process?.env || {}
const RONIN_MINT = globalThis.__RONIN_MINT_ADDRESS__ || runtimeEnv.VITE_RONIN_MINT_ADDRESS || DEFAULT_RONIN_MINT

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

function token({ mint, symbol, name, logoURI, glyph, className, decimals, section }) {
  return Object.freeze({
    mint,
    symbol,
    name,
    logoURI: logoURI || null,
    decimals,
    trust: 'verified',
    glyph,
    className,
    section,
  })
}

// Mint addresses are the identity. Symbols are display labels only.
export const TRUSTED_TOKENS = Object.freeze([
  token({ mint: SOL_MINT, symbol: 'SOL', name: 'Solana', glyph: '◎', className: 'tok-sol', decimals: 9, section: ['popular'] }),
  token({ mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin', glyph: '$', className: 'tok-usdc', decimals: 6, section: ['popular'] }),
  token({ mint: USDT_MINT, symbol: 'USDT', name: 'Tether USD', glyph: '₮', className: 'tok-usdt', decimals: 6, section: [] }),
  token({ mint: RONIN_MINT, symbol: 'RONIN', name: 'RONIN', glyph: '❁', className: 'tok-ronin', decimals: 6, section: ['popular', 'ronin'] }),
  token({ mint: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn', symbol: 'PUMP', name: 'Pump', logoURI: '/images/tokens/pump.png', glyph: 'P', className: 'tok-pump', decimals: 6, section: ['popular'] }),
  token({ mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter', logoURI: '/images/tokens/jup.png', glyph: 'J', className: 'tok-jup', decimals: 6, section: ['popular'] }),
  token({ mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk', logoURI: '/images/tokens/bonk.jpg', glyph: 'B', className: 'tok-bonk', decimals: 5, section: ['popular'] }),
  token({ mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', name: 'dogwifhat', logoURI: '/images/tokens/wif.jpg', glyph: 'W', className: 'tok-wif', decimals: 6, section: ['memes'] }),
  token({ mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', symbol: 'TRUMP', name: 'OFFICIAL TRUMP', logoURI: '/images/tokens/trump.jpg', glyph: 'T', className: 'tok-trump', decimals: 6, section: ['memes'] }),
  token({ mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', symbol: 'POPCAT', name: 'Popcat', glyph: 'P', className: 'tok-popcat', decimals: 9, section: ['memes'] }),
  token({ mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', symbol: 'BOME', name: 'BOOK OF MEME', logoURI: '/images/tokens/bome.png', glyph: 'B', className: 'tok-bome', decimals: 6, section: ['memes'] }),
  token({ mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', symbol: 'RENDER', name: 'Render Token', logoURI: '/images/tokens/render.png', glyph: 'R', className: 'tok-render', decimals: 8, section: ['featured'] }),
  token({ mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', name: 'Pyth Network', logoURI: '/images/tokens/pyth.svg', glyph: 'P', className: 'tok-pyth', decimals: 6, section: ['featured'] }),
  token({ mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', symbol: 'JTO', name: 'JITO', logoURI: '/images/tokens/jto.webp', glyph: 'J', className: 'tok-jto', decimals: 9, section: ['featured'] }),
  token({ mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', name: 'Raydium', logoURI: '/images/tokens/ray.png', glyph: 'R', className: 'tok-ray', decimals: 6, section: ['featured'] }),
  token({ mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', symbol: 'KMNO', name: 'Kamino', logoURI: '/images/tokens/kmno.svg', glyph: 'K', className: 'tok-kmno', decimals: 6, section: ['featured'] }),
  token({ mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', symbol: 'PENGU', name: 'Pudgy Penguins', logoURI: '/images/tokens/pengu.png', glyph: 'P', className: 'tok-pengu', decimals: 6, section: ['memes'] }),
  token({ mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', symbol: 'MEW', name: 'cat in a dogs world', logoURI: '/images/tokens/mew.png', glyph: 'M', className: 'tok-mew', decimals: 5, section: ['featured'] }),
  token({ mint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump', symbol: 'PNUT', name: 'Peanut the Squirrel', logoURI: '/images/tokens/pnut.png', glyph: 'P', className: 'tok-pnut', decimals: 6, section: ['featured'] }),
  token({ mint: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY', symbol: 'MOODENG', name: 'Moo Deng', glyph: 'M', className: 'tok-moodeng', decimals: 6, section: ['featured'] }),
  token({ mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', symbol: 'FARTCOIN', name: 'Fartcoin', logoURI: '/images/tokens/fartcoin.png', glyph: 'F', className: 'tok-fartcoin', decimals: 6, section: ['memes'] }),
  token({ mint: 'Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk', symbol: 'USELESS', name: 'USELESS COIN', logoURI: '/images/tokens/useless.png', glyph: 'U', className: 'tok-useless', decimals: 6, section: ['featured'] }),
])

export const TOKEN_BY_MINT = Object.freeze(Object.fromEntries(TRUSTED_TOKENS.map((item) => [item.mint, item])))

export const FEATURED_TOKEN_SECTIONS = Object.freeze({
  popular: ['SOL', 'USDC', 'RONIN', 'PUMP', 'JUP', 'BONK'],
  memes: ['PENGU', 'WIF', 'FARTCOIN', 'TRUMP', 'POPCAT', 'BOME'],
  featured: ['USDT', 'RENDER', 'PYTH', 'JTO', 'RAY', 'KMNO', 'MEW', 'PNUT', 'MOODENG', 'USELESS'],
})

export const RONIN_QUICK_PAIRS = Object.freeze([
  { label: 'SOL → RONIN', from: SOL_MINT, to: RONIN_MINT },
  { label: 'USDC → RONIN', from: USDC_MINT, to: RONIN_MINT },
  { label: 'RONIN → SOL', from: RONIN_MINT, to: SOL_MINT },
])

export const UNRESOLVED_TOKEN_SYMBOLS = Object.freeze([
  'SPX6900',
])

// Jupiter metadata exists for this asset, but its trust fields are not
// sufficient for inclusion in the trusted selector.
export const UNRESOLVED_TOKEN_METADATA = Object.freeze([
  Object.freeze({
    mint: '33ihk7Q8Hpfayt8mSYiDdEve19oYauYVMBikXUQjpump',
    symbol: 'SPX6900',
    name: 'all roads lead to spx6900',
    logoURI: 'https://axiomtrading.sfo3.cdn.digitaloceanspaces.com/5cdbpfjre4boamYFW5jLkapv2fZsBgHsGsQoz1qPpump.webp',
    decimals: 6,
    trust: 'unverified',
    tags: ['unknown', 'token-2022'],
  }),
])

export { SOL_MINT, USDC_MINT, USDT_MINT }
