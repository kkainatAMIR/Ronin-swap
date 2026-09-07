import { json, isValidAmount } from './roninBackend.mjs'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function decodeBase58(value) {
  let bytes = []
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char)
    if (digit < 0) return null
    let carry = digit
    for (let i = 0; i < bytes.length; i++) {
      const next = bytes[i] * 58 + carry
      bytes[i] = next & 0xff
      carry = next >> 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  let leadingZeroes = 0
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes++
  return new Uint8Array([...Array(leadingZeroes).fill(0), ...bytes.reverse()])
}

export function isValidPublicKey(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  const decoded = decodeBase58(value.trim())
  return decoded !== null && decoded.length === 32
}

export function isValidMintAddress(value) {
  return isValidPublicKey(value)
}

export function validateBurnRequest(body, res) {
  const { userPublicKey, assetId, burnAmount } = body || {}
  if (!isValidPublicKey(userPublicKey)) {
    json(res, 400, { error: 'A valid Solana userPublicKey is required.' })
    return null
  }
  if (!isValidPublicKey(assetId)) {
    json(res, 400, { error: 'A valid Solana assetId is required.' })
    return null
  }
  if (!isValidAmount(burnAmount)) {
    json(res, 400, { error: 'burnAmount must be a positive integer in base units.' })
    return null
  }
  return { userPublicKey, assetId, burnAmount: String(burnAmount) }
}
