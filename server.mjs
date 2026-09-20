import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Single API gateway — all /api/* requests are dispatched through this.
// The gateway (api/index.mjs) uses api/_routes.mjs to route to the
// appropriate handler module under api_routes/.
import gateway from './api/index.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distDir = path.join(__dirname, 'dist')

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

    // All /api/* requests go through the gateway. The gateway handles
    // routing internally — no per-route map needed here.
    if (url.pathname.startsWith('/api/')) {
      const body = await readBody(req)
      const request = createRequest(req, url, body)
      return await gateway(request, createResponse(res))
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
