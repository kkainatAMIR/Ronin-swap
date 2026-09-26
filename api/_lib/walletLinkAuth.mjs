// =====================================================================
// Wallet Link Authentication / Signature Verification
// =====================================================================
// Backend library that:
//   * creates server-issued, one-time-use, expiring link challenges
//     (nonce + challenge_id + both EVM and Solana messages)
//   * verifies EVM signatures via ethers.verifyMessage (EIP-191 personal_sign)
//   * verifies Solana signatures via node:crypto ed25519 (same pattern
//     as the existing adminAuth.mjs admin login flow)
//   * enforces strict address normalization (EVM lowercase, Solana
//     canonical base58 via PublicKey.toString())
//   * never logs signatures, nonces, or secrets
//
// SECURITY INVARIANTS:
//   1. Nonces come from node:crypto.randomBytes — never from the frontend.
//   2. The challenge_id is single-use: the link_wallets RPC marks it USED
//      atomically with the wallet_links insert. A replay returns
//      CHALLENGE_NOT_PENDING.
//   3. Expiry is enforced both in the handler (5 minutes) AND inside
//      the RPC. Defense in depth.
//   4. The signer addresses reported to the RPC must EXACTLY match the
//      addresses stored on the challenge row. The handler does NOT
//      accept "I signed with 0xATTACKER instead" — the signature must
//      recover to the EXACT challenge.evm_wallet.
//   5. The Solana signature is verified against the EXACT
//      challenge.solana_wallet bytes.
//   6. localStorage EVM tracking is never consulted here.
// =====================================================================

import crypto from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { ethers } from 'ethers'

const runtimeEnv = globalThis.__RONIN_LOCAL_ENV__ || process.env

// ---------------------------------------------------------------------
// Address normalization + validation
// ---------------------------------------------------------------------

const SOLANA_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM_HEX_RE = /^0x[a-fA-F0-9]{40}$/

export function isValidSolanaAddress(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!SOLANA_BASE58_RE.test(trimmed)) return false
  // PublicKey.toString() returns the canonical base58 representation.
  // For Phantom wallets, the input is already canonical, but this also
  // rejects off-curve garbage that happens to match the regex.
  try {
    const pk = new PublicKey(trimmed)
    return PublicKey.isOnCurve(pk.toBytes())
  } catch {
    return false
  }
}

export function isValidEvmAddress(value) {
  if (typeof value !== 'string') return false
  return EVM_HEX_RE.test(value.trim())
}

// Canonical base58 — used for storage and comparison.
// Throws if invalid (call isValidSolanaAddress first).
export function canonicalSolanaAddress(value) {
  const pk = new PublicKey(value.trim())
  return pk.toString()
}

// Lowercase 0x-prefixed — used for storage and comparison.
export function canonicalEvmAddress(value) {
  return value.trim().toLowerCase()
}

// ---------------------------------------------------------------------
// Challenge lifecycle
// ---------------------------------------------------------------------

// 5 minutes. The user has plenty of time to sign both popups; anything
// longer would weaken replay protection.
const CHALLENGE_TTL_MS = 5 * 60_000

function supabaseConfig() {
  const url = String(runtimeEnv.SUPABASE_URL || '').replace(/\/$/, '')
  const key = String(runtimeEnv.SUPABASE_SERVICE_ROLE_KEY || '')
  return { url, key }
}

export function isWalletLinkStoreConfigured() {
  const { url, key } = supabaseConfig()
  return Boolean(url && key)
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = supabaseConfig()
  if (!url || !key) throw new Error('WALLET_LINK_STORE_UNAVAILABLE')
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!response.ok) {
    const err = new Error('WALLET_LINK_STORE_UNAVAILABLE')
    err.status = response.status
    err.body = body
    throw err
  }
  return body
}

// Build the human-readable linking message that the user signs in
// MetaMask (EVM) and Phantom (Solana). Both messages share the same
// core fields (domain, purpose, EVM addr, Solana addr, nonce, issued,
// expires, challenge_id). They differ only in the trailing note about
// which wallet is being proven.
//
// The message is intentionally human-readable so the user understands
// what they're authorizing in the wallet popup. It also clearly states
// "This signature does not authorize transactions or token transfers."
function buildLinkMessage({ evmWallet, solanaWallet, nonce, challengeId, issuedAt, expiresAt, which }) {
  const issuedIso = new Date(issuedAt).toISOString()
  const expiresIso = new Date(expiresAt).toISOString()
  const lines = [
    'RoninSwap Wallet Link',
    '',
    'I authorize linking the following wallets for Samurai Points rewards:',
    '',
    `EVM wallet: ${evmWallet.toLowerCase()}`,
    `Solana wallet: ${solanaWallet}`,
    '',
    `Challenge ID: ${challengeId}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedIso}`,
    `Expires: ${expiresIso}`,
    '',
    'Purpose: cryptographically prove ownership of both wallets so Samurai Points earned on EVM chains can be aggregated into my Solana reward identity.',
    '',
    'This signature does not authorize transactions or token transfers.',
  ]
  if (which === 'evm') {
    lines.push('', `Signing as: EVM wallet ${evmWallet.toLowerCase()}`)
  } else if (which === 'solana') {
    lines.push('', `Signing as: Solana wallet ${solanaWallet}`)
  }
  return lines.join('\n')
}

// Create a fresh challenge. Returns:
//   { challengeId, nonce, messageEvm, messageSolana, expiresAt }
//
// The challenge row is inserted with status='PENDING'. The handler
// returns the messages to the frontend so MetaMask/Phantom can sign
// them. The signatures come back via /verify.
export async function createLinkChallenge({ solanaWallet, evmWallet, evmChainScope = null }) {
  if (!isWalletLinkStoreConfigured()) {
    throw new Error('WALLET_LINK_STORE_UNAVAILABLE')
  }
  if (!isValidSolanaAddress(solanaWallet)) {
    throw new Error('INVALID_SOLANA_WALLET')
  }
  if (!isValidEvmAddress(evmWallet)) {
    throw new Error('INVALID_EVM_WALLET')
  }

  const solanaCanonical = canonicalSolanaAddress(solanaWallet)
  const evmCanonical = canonicalEvmAddress(evmWallet)
  const challengeId = 'wlc-' + crypto.randomBytes(16).toString('hex')
  const nonce = crypto.randomBytes(24).toString('hex')
  const issuedAt = Date.now()
  const expiresAt = issuedAt + CHALLENGE_TTL_MS

  const messageEvm = buildLinkMessage({
    evmWallet: evmCanonical, solanaWallet: solanaCanonical,
    nonce, challengeId, issuedAt, expiresAt, which: 'evm',
  })
  const messageSolana = buildLinkMessage({
    evmWallet: evmCanonical, solanaWallet: solanaCanonical,
    nonce, challengeId, issuedAt, expiresAt, which: 'solana',
  })

  await supabaseRequest('wallet_link_challenges', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{
      challenge_id: challengeId,
      nonce,
      solana_wallet: solanaCanonical,
      evm_wallet: evmCanonical,
      evm_chain_scope: evmChainScope,
      message_evm: messageEvm,
      message_solana: messageSolana,
      expires_at: new Date(expiresAt).toISOString(),
      status: 'PENDING',
    }]),
  })

  return {
    challengeId,
    nonce,
    solanaWallet: solanaCanonical,
    evmWallet: evmCanonical,
    messageEvm,
    messageSolana,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  }
}

// Look up an existing PENDING challenge by id. Used by /verify to
// fetch the messages before re-verifying signatures (defense in depth:
// the messages stored on the challenge row are the source of truth,
// NOT any message supplied by the frontend).
export async function getPendingChallenge(challengeId) {
  if (!isWalletLinkStoreConfigured()) return null
  const rows = await supabaseRequest(
    `wallet_link_challenges?challenge_id=eq.${encodeURIComponent(challengeId)}&status=eq.PENDING&select=challenge_id,nonce,solana_wallet,evm_wallet,evm_chain_scope,message_evm,message_solana,expires_at,status&limit=1`,
    { method: 'GET' }
  )
  if (!Array.isArray(rows) || rows.length === 0) return null
  const row = rows[0]
  return {
    challengeId: row.challenge_id,
    nonce: row.nonce,
    solanaWallet: row.solana_wallet,
    evmWallet: row.evm_wallet,
    evmChainScope: row.evm_chain_scope,
    messageEvm: row.message_evm,
    messageSolana: row.message_solana,
    expiresAt: Date.parse(row.expires_at),
    status: row.status,
  }
}

// ---------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------

// Verify an EIP-191 personal_sign signature against the expected
// EVM address. Returns true iff the signature recovers to exactly
// the expected address.
//
// ethers.verifyMessage applies the standard EIP-191 prefix:
//   \x19Ethereum Signed Message:\n<len><message>
// and returns the recovered address. We compare lowercase.
export function verifyEvmSignature({ message, signature, expectedAddress }) {
  if (typeof message !== 'string' || typeof signature !== 'string') return false
  if (!isValidEvmAddress(expectedAddress)) return false
  try {
    const recovered = ethers.verifyMessage(message, signature).toLowerCase()
    return recovered === expectedAddress.toLowerCase()
  } catch {
    return false
  }
}

// Verify a Solana ed25519 signMessage signature against the expected
// Solana public key. Mirrors the existing adminAuth.mjs verification
// flow (same DER SPKI prefix, same crypto.verify call).
//
// The user signs the UTF-8 bytes of messageSolana via Phantom's
// signMessage. The signature is base64.
export function verifySolanaSignature({ message, signature, expectedAddress }) {
  if (typeof message !== 'string' || typeof signature !== 'string') return false
  if (!isValidSolanaAddress(expectedAddress)) return false
  let publicKey
  try {
    publicKey = new PublicKey(expectedAddress)
  } catch {
    return false
  }
  // ed25519 public key → SPKI DER prefix (same fixed prefix used by
  // adminAuth.mjs for admin login).
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(publicKey.toBytes()),
  ])
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' })
  const signatureBytes = Buffer.from(signature, 'base64')
  if (signatureBytes.length !== 64) return false
  try {
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, signatureBytes)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------
// Atomic verify + link RPC call
// ---------------------------------------------------------------------

// Calls the link_wallets RPC. The handler had already verified both
// signatures against the challenge's stored messages; the RPC re-checks
// status/expiry/identity and atomically marks the challenge USED +
// inserts the wallet_links row.
export async function callLinkWalletsRpc({ challengeId, evmSignature, solanaSignature, evmSigner, solanaSigner }) {
  const { url, key } = supabaseConfig()
  if (!url || !key) throw new Error('WALLET_LINK_STORE_UNAVAILABLE')
  const response = await fetch(`${url}/rest/v1/rpc/link_wallets`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      p_challenge_id: challengeId,
      p_evm_signature: evmSignature,
      p_solana_signature: solanaSignature,
      p_evm_signer: evmSigner,
      p_solana_signer: solanaSigner,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!response.ok) {
    // RPC raises exceptions with specific codes. Extract the first
    // line of the Postgres message — those are our raise exception codes.
    const code = body?.message ? String(body.message).split('\n')[0].replace(/^ERROR:\s*/, '').trim()
      : body?.error ? String(body.error).split('\n')[0].replace(/^ERROR:\s*/, '').trim()
      : 'LINK_RPC_FAILED'
    const err = new Error(code)
    err.code = code
    err.body = body
    err.status = response.status
    throw err
  }
  return Array.isArray(body) ? body[0] : body
}

export async function callUnlinkWalletRpc({ solanaWallet, evmWallet }) {
  const { url, key } = supabaseConfig()
  if (!url || !key) throw new Error('WALLET_LINK_STORE_UNAVAILABLE')
  const response = await fetch(`${url}/rest/v1/rpc/unlink_wallet`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      p_solana_wallet: solanaWallet,
      p_evm_wallet: evmWallet,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!response.ok) {
    const code = body?.message ? String(body.message).split('\n')[0].replace(/^ERROR:\s*/, '').trim()
      : body?.error ? String(body.error).split('\n')[0].replace(/^ERROR:\s*/, '').trim()
      : 'UNLINK_RPC_FAILED'
    const err = new Error(code)
    err.code = code
    err.body = body
    err.status = response.status
    throw err
  }
  return Array.isArray(body) ? body[0] : body
}

export async function callGetLinkedEvmWalletsRpc(solanaWallet) {
  const { url, key } = supabaseConfig()
  if (!url || !key) return { solana_wallet: solanaWallet, linked_evm_wallets: [] }
  const response = await fetch(`${url}/rest/v1/rpc/get_linked_evm_wallets`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ p_solana_wallet: solanaWallet }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  if (!response.ok) return { solana_wallet: solanaWallet, linked_evm_wallets: [] }
  return Array.isArray(body) ? body[0] : body
}

export async function callGetVerifiedRewardIdentityRpc(walletAddress) {
  const { url, key } = supabaseConfig()
  if (!url || !key) {
    // Best-effort fallback: treat as an unverified single wallet so
    // the existing /api/rewards/balance still works without the new
    // link layer being live (e.g. for local dev without Supabase).
    return {
      solana_wallet: SOLANA_BASE58_RE.test(walletAddress) ? walletAddress : null,
      linked_evm_wallets: [],
      verified: false,
    }
  }
  const response = await fetch(`${url}/rest/v1/rpc/get_verified_reward_identity`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ p_wallet_address: walletAddress }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  if (!response.ok) {
    // Fall back gracefully — the balance RPC will handle a missing identity.
    return { solana_wallet: null, linked_evm_wallets: [], verified: false }
  }
  return Array.isArray(body) ? body[0] : body
}

export const CHALLENGE_TTL_SECONDS = Math.floor(CHALLENGE_TTL_MS / 1000)
