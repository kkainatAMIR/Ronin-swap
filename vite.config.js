import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local', override: true })

const LOCAL_API_HANDLERS = {
  '/api/health': '/api/health.mjs',
  '/api/solana/rpc': '/api/solana/rpc.mjs',
  '/api/ronin/stats': '/api/ronin/stats.mjs',
  '/api/ronin/burn-history': '/api/ronin/burn-history.mjs',
  '/api/ronin/shield-stats': '/api/ronin/shield-stats.mjs',
  '/api/burn/preview': '/api/burn/preview.mjs',
  '/api/burn/build': '/api/burn/build.mjs',
  '/api/jupiter/quote': '/api/jupiter/quote.mjs',
  '/api/jupiter/swap': '/api/jupiter/swap.mjs',
  '/api/jupiter/order': '/api/jupiter/order.mjs',
  '/api/jupiter/execute': '/api/jupiter/execute.mjs',
  '/api/ronin/shield-stats': '/api/ronin/shield-stats.mjs',
  '/api/ronin/shield-scan': '/api/ronin/shield-scan.mjs',
  '/api/ronin/shield-contribution': '/api/ronin/shield-contribution.mjs',
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (!body) return resolve({})
      try { return resolve(JSON.parse(body)) } catch { return resolve(null) }
    })
    req.on('error', reject)
  })
}

function localApiPlugin(env) {
  // Vercel executes files in /api automatically in production. This small
  // adapter gives the same handlers to `vite` during local development and
  // Arena previews, so /api calls do not get served as JavaScript source.
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }

  return {
    name: 'ronin-local-api-handlers',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url || '/', 'http://localhost')
        const modulePath = LOCAL_API_HANDLERS[requestUrl.pathname]
        if (!modulePath) return next()

        try {
          // SSR API modules read server-only configuration at import time.
          // Inject Vite's loaded env immediately before importing the handler.
          for (const [key, value] of Object.entries(env)) process.env[key] = value
          globalThis.__RONIN_LOCAL_ENV__ = env
          req.query = Object.fromEntries(requestUrl.searchParams.entries())
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            req.body = await readRequestBody(req)
          }

          const { default: handler } = await server.ssrLoadModule(modulePath)
          res.status = (status) => {
            res.statusCode = status
            return res
          }
          res.json = (body) => {
            if (!res.headersSent) res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body))
            return res
          }
          await handler(req, res)
        } catch (error) {
          console.error(`Local API handler failed for ${requestUrl.pathname}:`, error)
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: error?.message || 'Local API request failed.' }))
          } else {
            res.end()
          }
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [localApiPlugin(env), react(), nodePolyfills({ include: ['buffer'] })],
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: false,
      allowedHosts: true,
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      allowedHosts: true,
    },
  }
})
