// RONIN Shield treasury - fake demo address for UI/UX
// This is a valid base58 Solana address format but not a real funded treasury for demo purposes.
// Replace with real treasury via VITE_RONIN_SHIELD_TREASURY env var.
export const SHIELD_TREASURY_ADDRESS =
  import.meta.env.VITE_RONIN_SHIELD_TREASURY || '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'

export const SHIELD_SUPPORT_PRESETS = [0.01, 0.05, 0.1]

// Optional: minimum custom contribution
export const SHIELD_MIN_CUSTOM_SOL = 0.001
export const SHIELD_MAX_CUSTOM_SOL = 10
