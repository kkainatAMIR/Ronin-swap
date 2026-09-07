// Feature gates.
//
// Part 1.5 keeps the swap flow enabled for quote preparation and transaction
// assembly while explicitly stopping before wallet signing or execution.
export const SWAP_ENABLED = true
// BUY is LIVE: the full Jupiter buy/sell flow (quote → review → sign →
// /execute) runs exactly as it did before it was paused.
export const BUY_ENABLED = true

// Copy used by every paused surface so the message stays consistent.
export const COMING_SOON_TITLE = 'COMING SOON'
export const COMING_SOON_TEXT = 'The RONIN swap is being forged. Buying and selling $RONIN through the site is temporarily paused — no transaction will be requested or signed.'
