// =====================================================================
// API Gateway — single Vercel Serverless Function entrypoint
// =====================================================================
//
// WHY THIS EXISTS:
//   Vercel Hobby plan limits deployments to 12 Serverless Functions.
//   The project has 40 API endpoint files under api/, which exceeded
//   the limit. This gateway collapses all 40 into 1 function.
//
// HOW IT WORKS:
//   1. Vercel rewrite: /api/(.*) → /api/index  (see vercel.json)
//   2. This gateway receives ALL /api/* requests
//   3. It looks up the handler in the route table (api/_routes.mjs)
//   4. It calls the handler with the ORIGINAL req/res objects —
//      no transformation, no wrapping, no body pre-parsing
//
// WHAT IS PRESERVED EXACTLY:
//   - req.url        (unchanged — handlers that parse req.url still work)
//   - req.method     (unchanged)
//   - req.query      (passed through from the runtime)
//   - req.body       (passed through — each handler parses as it expects)
//   - req.headers    (unchanged — cookie auth, IP rate-limiting, etc.)
//   - res object     (unchanged — handlers set their own headers/cookies)
//
// WHAT THIS GATEWAY DOES NOT DO:
//   - Does NOT parse request bodies (each handler does its own parsing)
//   - Does NOT set CORS headers (no endpoint was setting them before)
//   - Does NOT wrap responses (each handler formats its own JSON)
//   - Does NOT add authentication (each handler does its own auth checks)
//   - Does NOT modify req or res in any way
//
// The gateway is intentionally a thin dispatcher. All business logic
// lives in the handler modules under api_routes/.
// =====================================================================

import { matchRoute } from './_routes.mjs'

// Build a Vercel-compatible req/res shim if needed. Under Vercel's
// Node.js runtime, req is an IncomingMessage and res is a ServerResponse.
// We need to ensure req.query is populated (Vercel does this automatically,
// but the vite dev server and server.mjs do it too).
//
// CRITICAL: We do NOT pre-parse req.body. Each handler expects the body
// in a specific format:
//   - Some use parseBody(req) from _lib/roninBackend.mjs
//   - Some read req.body directly (assuming it's already an object)
//   - Some do typeof req.body === 'string' ? JSON.parse : use-as-is
//   - Some define their own local parseBody
//
// The runtime (Vercel / vite dev / server.mjs) is responsible for
// populating req.body. This gateway does NOT touch it.

export default async function handler(req, res) {
  // Parse the URL to extract the pathname (without query string).
  // req.url may be "/api/rewards/balance?wallet=xxx" — we need just
  // the "/api/rewards/balance" part for route matching.
  const rawUrl = req.url || '/'
  let pathname = rawUrl
  try {
    const parsed = new URL(rawUrl, 'http://localhost')
    pathname = parsed.pathname
  } catch {
    // If URL parsing fails, fall back to splitting on '?'
    pathname = rawUrl.split('?')[0]
  }

  // Ensure req.query is populated. Vercel does this automatically, but
  // we populate it defensively for non-Vercel runtimes.
  if (!req.query) {
    try {
      const parsed = new URL(rawUrl, 'http://localhost')
      req.query = Object.fromEntries(parsed.searchParams.entries())
    } catch {
      req.query = {}
    }
  }

  // Look up the route. matchRoute returns the handler function directly
  // (static imports — no dynamic import() needed).
  const endpointHandler = matchRoute(req.method, pathname)
  if (!endpointHandler) {
    // No route found. Return 404 in the same format as the old
    // server.mjs fallback did for unknown /api/ routes.
    if (!res.headersSent) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'API route not found.' }))
    }
    return
  }

  // Call the handler with the original req/res objects.
  try {
    await endpointHandler(req, res)
  } catch (error) {
    // If the handler throws synchronously before its own try/catch,
    // log and return 500. Handlers are expected to have their own
    // error handling — this is a safety net.
    console.error('API gateway handler error:', error?.message || error, { path: pathname, method: req.method })
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'Internal server error.' }))
    }
  }
}
