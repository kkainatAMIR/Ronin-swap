import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import health from './api/health.mjs'
import jupiterOrder from './api/jupiter/order.mjs'
import jupiterExecute from './api/jupiter/execute.mjs'
import jupiterQuote from './api/jupiter/quote.mjs'
import jupiterSwap from './api/jupiter/swap.mjs'
import roninStats from './api/ronin/stats.mjs'
import burnHistory from './api/ronin/burn-history.mjs'
import shieldStats from './api/ronin/shield-stats.mjs'
import shieldScan from './api/ronin/shield-scan.mjs'
import shieldContribution from './api/ronin/shield-contribution.mjs'
import solanaRpc from './api/solana/rpc.mjs'
import swapVerify from './api/swap/verify.mjs'
import swapRecord from './api/swap/record.mjs'
import swapHistory from './api/swap/history.mjs'
import swapPoints from './api/swap/points.mjs'
import leaderboard from './api/leaderboard.mjs'
import adminSamurai from './api/admin/samurai.mjs'
import currentSeason from './api/samurai/season.mjs'
import adminSeasons from './api/admin/seasons.mjs'
import adminDashboard from './api/admin/dashboard.mjs'
import adminAuth from './api/admin/auth.mjs'
import burnBuild from './api/burn/build.mjs'
import burnPreview from './api/burn/preview.mjs'
import evmQuote from './api/evm/quote.mjs'
import evmComplete from './api/evm/complete.mjs'
import lifiConfig from './api/lifi/config.mjs'
import lifiQuote from './api/lifi/quote.mjs'
import lifiStatus from './api/lifi/status.mjs'
import lifiComplete from './api/lifi/complete.mjs'
import robinhoodTrending from './api/robinhood/trending.mjs'
import robinhoodTokens from './api/robinhood/tokens.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distDir = path.join(__dirname, 'dist')

const routes = new Map([
  ['GET /api/health', health],
  ['GET /api/jupiter/order', jupiterOrder],
  ['POST /api/jupiter/execute', jupiterExecute],
  ['GET /api/jupiter/quote', jupiterQuote],
  ['POST /api/jupiter/swap', jupiterSwap],
  ['GET /api/ronin/stats', roninStats],
  ['GET /api/ronin/burn-history', burnHistory],
  ['GET /api/ronin/shield-stats', shieldStats],
  ['GET /api/ronin/shield-scan', shieldScan],
  ['POST /api/ronin/shield-scan', shieldScan],
  ['POST /api/ronin/shield-contribution', shieldContribution],
  ['POST /api/solana/rpc', solanaRpc],
  ['POST /api/swap/verify', swapVerify],
  ['POST /api/swap/record', swapRecord],
  ['GET /api/swap/history', swapHistory],
  ['POST /api/swap/points', swapPoints],
  ['GET /api/leaderboard', leaderboard],
  ['GET /api/samurai/season/current', currentSeason],
  ['GET /api/admin/samurai/seasons', adminSeasons],
  ['POST /api/admin/samurai/seasons', adminSeasons],
  ['POST /api/admin/samurai/season-action', adminSeasons],
  ['GET /api/admin/samurai/flags', adminSamurai],
  ['GET /api/admin/samurai/transactions', adminSamurai],
  ['GET /api/admin/samurai/wallet', adminSamurai],
  ['POST /api/admin/samurai/flag', adminSamurai],
  ['POST /api/admin/samurai/exclude', adminSamurai],
  ['POST /api/admin/samurai/restore', adminSamurai],
  ['POST /api/admin/samurai/recalculate', adminSamurai],
  ['GET /api/admin/dashboard', adminDashboard],
  ['PATCH /api/admin/dashboard', adminDashboard],
  ['POST /api/admin/dashboard', adminDashboard],
  ['POST /api/admin/auth', adminAuth],
  ['GET /api/admin/auth', adminAuth],
  ['POST /api/burn/build', burnBuild],
  ['POST /api/burn/preview', burnPreview],
  ['POST /api/evm/quote', evmQuote],
  ['POST /api/evm/complete', evmComplete],
  ['GET /api/lifi/config', lifiConfig],
  ['POST /api/lifi/quote', lifiQuote],
  ['POST /api/lifi/status', lifiStatus],
  ['POST /api/lifi/complete', lifiComplete],
  ['GET /api/robinhood/trending', robinhoodTrending],
  ['GET /api/robinhood/tokens', robinhoodTokens],
])

function createResponse(res) {
  return {
    status(code) {
      res.statusCode = code
      return this
    },
    setHeader(name, value) {
      res.setHeader(name, value)
      return this
    },
    json(body) {
      if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
      return this
    },
    end(body = '') {
      res.end(body)
      return this
    },
  }
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {}
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) } catch { return text }
}

function createRequest(req, url, body) {
  return {
    ...req,
    method: req.method,
    query: Object.fromEntries(url.searchParams.entries()),
    body,
    url: url.pathname + url.search,
  }
}

async function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname
  const safePath = path.normalize(requested).replace(/^([.][.][/\\])+/, '')
  const filePath = path.join(distDir, safePath)
  if (!filePath.startsWith(distDir)) return false

  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) return false
    const ext = path.extname(filePath).toLowerCase()
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    }
    res.statusCode = 200
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream')
    res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable')
    res.end(await fs.readFile(filePath))
    return true
  } catch {
    return false
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const handler = routes.get(`${req.method} ${url.pathname}`)

    if (handler) {
      const body = await readBody(req)
      const request = createRequest(req, url, body)
      return await handler(request, createResponse(res))
    }

    if (url.pathname.startsWith('/api/')) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      return res.end(JSON.stringify({ error: 'API route not found.' }))
    }

    if (await serveStatic(res, url.pathname)) return

    // SPA fallback: React Router/client-side routes should receive index.html.
    if (await serveStatic(res, '/index.html')) return

    res.statusCode = 404
    res.end('Not found')
  } catch (error) {
    console.error('RONIN server error:', error)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'Internal server error.' }))
    } else {
      res.end()
    }
  }
})

const port = Number(process.env.PORT || 3000)
server.listen(port, '0.0.0.0', () => {
  console.log(`RONIN cPanel server listening on port ${port}`)
})
