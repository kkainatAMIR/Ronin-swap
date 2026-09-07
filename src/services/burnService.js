// RONIN Burn — Sol Incinerator v2 integration (frontend side).
//
// This module never talks to Sol Incinerator directly and never sees the
// SOL_INCINERATOR_API_KEY. Every preview/build call goes through the RONIN
// Vercel API functions, which are the only place that credential lives.

import bs58 from 'bs58'
import { RONIN_MINT } from '../data'

export class BurnApiError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message)
    this.name = 'BurnApiError'
    this.status = status
    this.detail = detail
  }
}

async function parseJsonSafely(response) {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { raw: text }
  }
}

/**
 * Convert a human-entered amount string (e.g. "1234.5") into the token's
 * raw/atomic integer units as a BigInt, using exact string-decimal math so
 * large balances never lose precision the way float math would. Any
 * fractional digits beyond `decimals` are truncated (never rounded up),
 * which guarantees the resulting raw amount never exceeds the user's input.
 */
export function toRawUnits(amountInput, decimals) {
  const clean = String(amountInput ?? '').trim()
  if (!clean || !/^\d*\.?\d*$/.test(clean)) return 0n
  const [intPartRaw, fracPartRaw = ''] = clean.split('.')
  const intPart = intPartRaw || '0'
  const fracPart = fracPartRaw.slice(0, decimals).padEnd(decimals, '0')
  const combined = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, '')
  try {
    return BigInt(combined || '0')
  } catch {
    return 0n
  }
}

export function rawUnitsToUiAmount(rawUnits, decimals) {
  const raw = typeof rawUnits === 'bigint' ? rawUnits : BigInt(rawUnits || 0)
  const divisor = 10 ** decimals
  return Number(raw) / divisor
}

/**
 * Ask the RONIN backend for a Sol Incinerator burn preview — real fee and
 * rent-reclaim data for this exact wallet + amount, fetched fresh every
 * time. Nothing here is estimated or invented client-side.
 */
export async function getBurnPreview({ userPublicKey, burnAmountRaw, assetId = RONIN_MINT }) {
  const response = await fetch('/api/burn/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userPublicKey, assetId, burnAmount: burnAmountRaw.toString() }),
  })
  const body = await parseJsonSafely(response)
  if (!response.ok) {
    throw new BurnApiError(body?.error || 'The burn could not be previewed right now.', { status: response.status, detail: body })
  }
  return body
}

/**
 * Ask the RONIN backend to build the actual burn transaction via Sol
 * Incinerator. Returns a base58-encoded serialized transaction for the
 * connected wallet to sign — no server wallet is ever involved.
 */
export async function buildBurnTransaction({ userPublicKey, burnAmountRaw, assetId = RONIN_MINT }) {
  const response = await fetch('/api/burn/build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userPublicKey, assetId, burnAmount: burnAmountRaw.toString() }),
  })
  const body = await parseJsonSafely(response)
  if (!response.ok || !body?.serializedTransaction) {
    throw new BurnApiError(body?.error || 'The burn transaction could not be prepared.', { status: response.status, detail: body })
  }
  return body
}

export function decodeBase58Transaction(serializedTransaction) {
  return bs58.decode(serializedTransaction)
}

export function solscanTxUrl(signature) {
  return `https://solscan.io/tx/${signature}`
}

export function solscanAddressUrl(address) {
  return `https://solscan.io/account/${address}`
}
