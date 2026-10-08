import test from 'node:test'
import assert from 'node:assert/strict'
import statsHandler from '../../api_routes/ronin/stats.mjs'
import apiGateway, { config as apiGatewayConfig } from '../index.mjs'

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader() {
      return this
    },
    json(body) {
      this.body = body
      return this
    },
  }
}

test('burn stats allow a Helius history page to complete after the old eight-second cutoff', async () => {
  const originalFetch = globalThis.fetch
  const originalEnv = globalThis.__RONIN_LOCAL_ENV__
  globalThis.__RONIN_LOCAL_ENV__ = { HELIUS_API_KEY: 'test-key' }
  let historyRequestCompleted = false

  globalThis.fetch = async (url, options = {}) => {
    const parsedUrl = new URL(url)
    if (parsedUrl.hostname === 'api.helius.xyz') {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          historyRequestCompleted = true
          resolve()
        }, 8_500)
        options.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
      return Response.json([])
    }

    if (parsedUrl.hostname === 'mainnet.helius-rpc.com') {
      const { method } = JSON.parse(options.body)
      const result = method === 'getTokenSupply'
        ? { value: { amount: '1000000', decimals: 6, uiAmount: 1 } }
        : { value: [], token_accounts: [], cursor: null }
      return Response.json({ jsonrpc: '2.0', id: 1, result })
    }

    if (parsedUrl.hostname === 'api.dexscreener.com') {
      return Response.json({ pairs: [] })
    }

    throw new Error(`Unexpected upstream host: ${parsedUrl.hostname}`)
  }

  try {
    const res = responseRecorder()
    await statsHandler({ method: 'GET' }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(historyRequestCompleted, true)
    assert.equal(res.body.burnsComplete, true)
    assert.equal(res.body.burned, 0)
  } finally {
    globalThis.fetch = originalFetch
    if (originalEnv === undefined) delete globalThis.__RONIN_LOCAL_ENV__
    else globalThis.__RONIN_LOCAL_ENV__ = originalEnv
  }
})

test('the Vercel API gateway allows the bounded burn-history scan to finish', () => {
  assert.equal(typeof apiGateway, 'function')
  assert.equal(apiGatewayConfig.maxDuration, 60)
})
