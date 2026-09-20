import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local', override: true })

// All /api/* requests are now routed through a single gateway
// (api/index.mjs) which dispatches to handler modules under api_routes/.
// This mirrors the Vercel production setup (vercel.json rewrites all
// /api/* to /api/index) and keeps local dev behavior identical to prod.

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let bodyBytes = 0
    const maxBytes = 1_000_000
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      bodyBytes += Buffer.byteLength(chunk)
      if (bodyBytes > maxBytes) {
        req.destroy()
        const error = new Error('Request body too large.')
        error.statusCode = 413
        reject(error)
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (!body) return resolve({})
      try { return resolve(JSON.parse(body)) } catch { return resolve(null) }
    })
    req.on('error', reject)
  })
}

function localApiPlugin(env) {
  // Vercel rewrites /api/* to /api/index in production. This plugin
  // does the same for `vite dev` — all /api/* requests go through the
  // gateway at api/index.mjs.
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }

  return {
    name: 'ronin-local-api-handlers',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url || '/', 'http://localhost')

        // Only intercept /api/* paths. Everything else falls through to
        // Vite's static file server / SPA fallback.
        if (!requestUrl.pathname.startsWith('/api/')) return next()

        try {
          // SSR API modules read server-only configuration at import time.
          // Inject Vite's loaded env immediately before importing the handler.
          for (const [key, value] of Object.entries(env)) process.env[key] = value
          globalThis.__RONIN_LOCAL_ENV__ = env
          req.query = Object.fromEntries(requestUrl.searchParams.entries())
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            req.body = await readRequestBody(req)
          }

          // Load the gateway. The gateway handles all routing internally
          // via api/_routes.mjs. We pass req.url unchanged so handlers
          // that parse req.url (e.g. admin/samurai.mjs) still work.
          const { default: gateway } = await server.ssrLoadModule('/api/index.mjs')
          res.status = (status) => {
            res.statusCode = status
            return res
          }
          res.json = (body) => {
            if (!res.headersSent) res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body))
            return res
          }
          await gateway(req, res)
        } catch (error) {
          console.error(`Local API gateway failed for ${requestUrl.pathname}:`, error)
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
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }

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
