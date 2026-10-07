import test from 'node:test'
import assert from 'node:assert/strict'
import { getTokenAnalytics } from './tokenAnalyticsService.js'

function jsonResponse(body) {
  return { ok: true, json: async () => body }
}

function geckoPool(network, address, poolAddress = 'pool-address') {
  return {
    data: [{
      attributes: {
        address: poolAddress,
        base_token_price_usd: '0.0125',
        quote_token_price_usd: '2',
        token_price_usd: '0.0125',
        price_change_percentage: { h24: '4.2' },
        volume_usd: { h24: '1234.5' },
        market_cap_usd: '500000',
        reserve_in_usd: '75000',
      },
      relationships: {
        base_token: { data: { id: `${network}_${address}` } },
        quote_token: { data: { id: `${network}_quote-address` } },
      },
    }],
  }
}

test('Solana analytics use the exact mint and real GeckoTerminal OHLCV', async () => {
  const mint = 'SelectedSolanaMint111111111111111111111111111'
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('/api/solana/enhanced')) return jsonResponse({ total: 1234, holders: [] })
    if (String(url).includes('api.dexscreener.com')) return jsonResponse({ pairs: [] })
    if (String(url).includes('/tokens/')) return jsonResponse(geckoPool('solana', mint))
    if (String(url).includes('/ohlcv/')) {
      return jsonResponse({ data: { attributes: { ohlcv_list: [
        [Math.floor(Date.now() / 1000) - 120, 1, 1.1, 0.9, 1.02, 10],
        [Math.floor(Date.now() / 1000) - 60, 1.02, 1.2, 1, 1.1, 12],
      ] } } })
    }
    throw new Error(`Unexpected provider URL: ${url}`)
  }

  try {
    const result = await getTokenAnalytics({ chain: 'solana', address: mint, range: '1H' })
    assert.equal(result.available, true)
    assert.equal(result.chartAvailable, true)
    assert.equal(result.chartSource, 'GeckoTerminal')
    assert.equal(result.metrics.priceUsd, 0.0125)
    assert.equal(result.metrics.marketCapUsd, 500000)
    assert.equal(result.metrics.holders, 1234)
    assert.equal(result.metrics.holdersSource, 'Helius')
    assert.deepEqual(
      {
        open: result.chart[0].open,
        high: result.chart[0].high,
        low: result.chart[0].low,
        close: result.chart[0].close,
        volume: result.chart[0].volume,
      },
      { open: 1, high: 1.1, low: 0.9, close: 1.02, volume: 10 },
    )
    assert.ok(calls.some((url) => url.includes(`/tokens/${mint}/pools`)))
    assert.ok(calls.some((url) => url.includes('/ohlcv/minute?') && url.includes('aggregate=1')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Ethereum analytics use the Ethereum address and eth GeckoTerminal network', async () => {
  const address = '0x1234567890abcdef1234567890abcdef12345678'
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('api.dexscreener.com')) return jsonResponse({ pairs: [] })
    if (String(url).includes('/tokens/')) return jsonResponse(geckoPool('eth', address))
    if (String(url).includes('/ohlcv/')) return jsonResponse({ data: { attributes: { ohlcv_list: [] } } })
    throw new Error(`Unexpected provider URL: ${url}`)
  }

  try {
    const result = await getTokenAnalytics({ chain: 'ethereum', address, range: '1D' })
    assert.equal(result.available, true)
    assert.equal(result.chartAvailable, false)
    assert.ok(calls.some((url) => url.includes(`/networks/eth/tokens/${address}/pools`)))
    assert.ok(calls.some((url) => url.includes('/networks/eth/pools/pool-address/ohlcv/minute')))
    assert.equal(result.metrics.volume24hUsd, 1234.5)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Robinhood analytics use exact-chain GeckoTerminal OHLCV history', async () => {
  const address = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const requestUrl = String(url)
    if (requestUrl.includes('api.dexscreener.com')) {
      return jsonResponse({
        pairs: [
          { chainId: 'ethereum', baseToken: { address }, priceUsd: '99', liquidity: { usd: 999999 } },
          { chainId: 'robinhood', baseToken: { address }, priceUsd: '0.25', priceChange: { h24: 3 }, volume: { h24: 1000 }, marketCap: 10000, liquidity: { usd: 2000 }, pairAddress: 'robinhood-pool', url: 'https://dexscreener.com/robinhood/example' },
        ],
      })
    }
    if (requestUrl.includes('/tokens/')) return jsonResponse({ data: [] })
    if (requestUrl.endsWith('/pools/robinhood-pool')) return jsonResponse(geckoPool('robinhood', address, 'robinhood-pool'))
    if (requestUrl.includes('/ohlcv/')) {
      return jsonResponse({ data: { attributes: { ohlcv_list: [
        [Math.floor(Date.now() / 1000) - 120, 1, 1.1, 0.9, 1.02, 10],
        [Math.floor(Date.now() / 1000) - 60, 1.02, 1.2, 1, 1.1, 12],
      ] } } })
    }
    throw new Error(`Unexpected provider URL: ${url}`)
  }

  try {
    const result = await getTokenAnalytics({ chain: 'robinhood', address, range: '1D' })
    assert.equal(result.available, true)
    assert.equal(result.metrics.priceUsd, 0.25)
    assert.equal(result.chartAvailable, true)
    assert.equal(result.chartSource, 'GeckoTerminal')
    assert.ok(calls.some((requestUrl) => requestUrl.includes(`/networks/robinhood/tokens/${address}/pools`)))
    assert.ok(calls.some((requestUrl) => requestUrl.includes('/networks/robinhood/pools/robinhood-pool/ohlcv/minute')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('analytics use the DexScreener pair as a GeckoTerminal pool lookup fallback', async () => {
  const address = '0xabcdefabcdefabcdefabcdefabcdefabcdef1234'
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const requestUrl = String(url)
    calls.push(requestUrl)
    if (requestUrl.includes('api.dexscreener.com')) {
      return jsonResponse({
        pairs: [{
          chainId: 'ethereum',
          baseToken: { address },
          priceUsd: '0.25',
          priceChange: { h24: 3 },
          volume: { h24: 1000 },
          liquidity: { usd: 2000 },
          pairAddress: 'fallback-pool',
        }],
      })
    }
    if (requestUrl.includes('/tokens/')) return jsonResponse({ data: [] })
    if (requestUrl.endsWith('/pools/fallback-pool')) {
      return jsonResponse({ data: geckoPool('eth', address, 'fallback-pool').data[0] })
    }
    if (requestUrl.includes('/ohlcv/')) {
      return jsonResponse({ data: { attributes: { ohlcv_list: [
        [Math.floor(Date.now() / 1000) - 120, 1, 1.1, 0.9, 1.02, 10],
        [Math.floor(Date.now() / 1000) - 60, 1.02, 1.2, 1, 1.1, 12],
      ] } } })
    }
    throw new Error(`Unexpected provider URL: ${url}`)
  }

  try {
    const result = await getTokenAnalytics({ chain: 'ethereum', address, range: '1D' })
    assert.equal(result.chartAvailable, true)
    assert.ok(calls.some((requestUrl) => requestUrl.includes('/networks/eth/pools/fallback-pool')))
    assert.ok(calls.some((requestUrl) => requestUrl.includes('/networks/eth/pools/fallback-pool/ohlcv/')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('identical token requests share the in-flight provider requests', async () => {
  const address = 'SharedToken11111111111111111111111111111111'
  let callCount = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    callCount += 1
    if (String(url).includes('/api/solana/enhanced')) return jsonResponse({ total: 12, holders: [] })
    if (String(url).includes('api.dexscreener.com')) return jsonResponse({ pairs: [] })
    if (String(url).includes('/tokens/')) return jsonResponse(geckoPool('solana', address))
    if (String(url).includes('/ohlcv/')) return jsonResponse({ data: { attributes: { ohlcv_list: [] } } })
    throw new Error(`Unexpected provider URL: ${url}`)
  }

  try {
    const [first, second] = await Promise.all([
      getTokenAnalytics({ chain: 'solana', address, range: '1D' }),
      getTokenAnalytics({ chain: 'solana', address, range: '1D' }),
    ])
    assert.equal(first, second)
    assert.equal(callCount, 4)
  } finally {
    globalThis.fetch = originalFetch
  }
})
