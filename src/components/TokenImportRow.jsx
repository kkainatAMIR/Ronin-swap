// =====================================================================
// TokenImportRow — "Import this token" row inside the token pickers.
// =====================================================================
// Rendered at the TOP of the swap token picker's results list when:
//   1. The search query looks like a valid mint/address for the
//      current chain (Solana base58 32-44 OR EVM 0x + 40 hex).
//   2. AND no curated/wallet token in the existing list exactly
//      matches that address.
//
// On click, calls the backend /api/token-info/* endpoint to fetch
// public on-chain metadata (name, symbol, decimals, logo). The
// returned token object is added to the selector's in-memory token
// list with `trust: 'custom'` so it renders as an IMPORTED entry.
//
// SECURITY:
//   * The row is shown ONLY when the user's query is a plausible
//     mint/address AND no existing token matches — it never appears
//     for symbol/name searches.
//   * The actual token metadata ALWAYS comes from the backend RPC
//     lookup — the frontend NEVER trusts the user-typed address as
//     proof of the symbol/name/decimals.
//   * After import, the token runs through the existing
//     isWalletImpersonation() check (extended to also check
//     `trust: 'custom'`). If a scam token uses a curated symbol like
//     "USDC" but a different mint/address, it gets BLOCKED.
//   * Imported tokens show a yellow "IMPORTED" tag instead of the
//     green "FEATURED" / blue "WALLET" tags.
//   * No private keys, seeds, or wallet secrets are ever requested.
// =====================================================================

import { useState } from 'react'
import Icon from './Icon'
import {
  looksLikeSolanaMint,
  looksLikeEvmAddress,
  importSolanaTokenByMint,
  importEvmTokenByAddress,
} from '../services/tokenImport'

// `chainKey` is one of 'solana' | 'ethereum' | 'robinhood'.
// `query` is the raw search box string.
// `existingTokens` is the selector's current token list — used to
//   detect whether an exact match already exists (in which case the
//   row should NOT show, because the user can just click the existing
//   entry instead of importing a duplicate).
// `onImported` is called with the fetched token object so the parent
//   selector can add it to its list + select it.
export default function TokenImportRow({ chainKey, query, existingTokens = [], onImported }) {
  const [state, setState] = useState('idle')  // 'idle' | 'loading' | 'error'
  const [error, setError] = useState('')

  const trimmed = String(query || '').trim()
  const looksValid = chainKey === 'solana'
    ? looksLikeSolanaMint(trimmed)
    : looksLikeEvmAddress(trimmed)

  // If the query isn't shaped like a valid address for this chain,
  // don't render anything. The existing search/filter logic handles
  // symbol/name substring matches.
  if (!looksValid) return null

  // Check if the exact address already exists in the selector's
  // existing token list (curated or wallet). If yes, don't show the
  // import row — the user can just click the existing entry.
  const normalized = chainKey === 'solana' ? trimmed : trimmed.toLowerCase()
  const alreadyExists = existingTokens.some((token) => {
    const tokenAddr = chainKey === 'solana'
      ? token.mint
      : (token.address || '').toLowerCase()
    return tokenAddr === normalized
  })
  if (alreadyExists) return null

  const handleClick = async () => {
    if (state === 'loading') return
    setState('loading')
    setError('')
    try {
      const imported = chainKey === 'solana'
        ? await importSolanaTokenByMint(trimmed)
        : await importEvmTokenByAddress(chainKey, trimmed)
      if (!imported) {
        setState('error')
        setError('No token metadata found at this address. Verify the address and try again.')
        return
      }
      setState('idle')
      onImported?.(imported)
    } catch (e) {
      setState('error')
      setError(e?.message || 'Could not fetch token metadata. Try again shortly.')
    }
  }

  return (
    <div className="swap-token-import-row">
      <button
        type="button"
        className="swap-token-result swap-token-import-result"
        onClick={handleClick}
        disabled={state === 'loading'}
        aria-label={`Import token at ${trimmed}`}
      >
        <span className="swap-token-import-mark">
          {state === 'loading' ? (
            <span className="ronin-wallet-link-spinner" aria-label="Loading" />
          ) : (
            <Icon name="plus" size={20} />
          )}
        </span>
        <span className="swap-token-result-copy">
          <strong>Import token</strong>
          <small>Add this {chainKey === 'solana' ? 'Solana mint' : 'contract address'} to your token list</small>
          <small className="swap-token-import-address">{trimmed}</small>
        </span>
        <span className="swap-token-trust">
          <span>IMPORTED</span>
        </span>
      </button>
      {state === 'error' && (
        <p className="swap-token-import-error">
          <Icon name="info" size={12} /> {error}
        </p>
      )}
      <p className="swap-token-import-disclaimer">
        <Icon name="info" size={11} /> Imported tokens are user-supplied — verify the contract address before swapping. RoninSwap does NOT verify imported tokens against any registry.
      </p>
    </div>
  )
}
