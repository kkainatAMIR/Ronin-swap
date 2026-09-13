import { apiError, json, parseBody } from '../_lib/roninBackend.mjs'
import { isSupabaseConfigured, persistVerifiedSwap } from '../_lib/supabaseBackend.mjs'
import { verifySwapSignature } from './verify.mjs'

function isValidBase58(value, min, max) {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value) && value.length >= min && value.length <= max
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Verified swap persistence is not configured on the server.')

  const body = parseBody(req)
  const signature = typeof body?.signature === 'string' ? body.signature.trim() : ''
  const wallet = typeof body?.wallet === 'string' ? body.wallet.trim() : ''
  if (!isValidBase58(signature, 32, 88)) return apiError(res, 400, 'INVALID_SIGNATURE', 'A valid transaction signature is required.')
  if (!isValidBase58(wallet, 32, 44)) return apiError(res, 400, 'INVALID_WALLET', 'A valid wallet address is required.')

  const verification = await verifySwapSignature(signature, wallet)
  if (!verification.result?.verified) return json(res, verification.status, verification.result)
  if (!verification.result.input || !verification.result.output) return apiError(res, 422, 'INCOMPLETE_VERIFICATION', 'The verified transaction did not contain complete swap asset data.')

  try {
    const persisted = await persistVerifiedSwap(verification.result)
    return json(res, 200, { persisted: true, verified: true, signature, wallet, walletRecord: persisted.wallet, swap: persisted.swap })
  } catch (error) {
    console.error('verified swap persistence failed:', error?.message || error)
    return apiError(res, error?.name === 'TimeoutError' ? 504 : 502, error?.message === 'SUPABASE_NOT_CONFIGURED' ? 'DATABASE_NOT_CONFIGURED' : 'DATABASE_ERROR', 'The verified swap could not be persisted.')
  }
}