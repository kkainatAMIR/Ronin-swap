# EVM wallet-token discovery (Swap picker "YOUR WALLET" section)

This document explains how the swap page auto-detects every token a
connected MetaMask wallet actually holds on Ethereum Mainnet and
Robinhood Chain — the same feature Solana already had via Helius.

## What changed

Before this change, the Ethereum and Robinhood swap panels only ever
iterated over a hardcoded 22-token (Ethereum) or ~20-token (Robinhood)
curated catalog. Any ERC-20 the user actually held that wasn't in that
list never appeared in the token picker.

The Solana branch already had full wallet-token discovery via
`getAllTokenAccounts()` in `src/services/shieldService.js` (RPC
`getTokenAccountsByOwner` + Helius metadata). This change adds the
EVM equivalent.

## Files

### Backend (new)

- `api_routes/ethereum/wallet-tokens.mjs` — `GET /api/ethereum/wallet-tokens?address=0x...`
  Returns native ETH balance + every ERC-20 the wallet holds (balance > 0),
  enriched with symbol/name/decimals/logo.

- `api_routes/robinhood/wallet-tokens.mjs` — `GET /api/robinhood/wallet-tokens?address=0x...`
  Same shape, but for Robinhood Chain (chainId 4663). Uses `eth_getLogs`
  against the existing Robinhood RPC to discover every token contract the
  wallet has ever interacted with, then checks current `balanceOf`.

### Frontend (new)

- `src/services/evmWalletTokens.js` — wrapper around the two new endpoints
  that returns a normalized `{ address, symbol, name, decimals, logoURI,
  amount }` list matching the shape the existing Solana `TokenSelector`
  already consumes.

### Frontend (modified)

- `src/pages/Swap.jsx`
  - `EthereumTokenSelector` now accepts a `walletTokens` prop, merges it
    with the curated catalog (so wallet-owned catalog tokens get a live
    balance badge, and non-catalog tokens appear as new entries), and
    renders a **YOUR WALLET** quick-row at the top of the picker —
    exactly like the Solana `TokenSelector`.
  - `RobinhoodTokenSelector` gained the same wallet-tokens support, plus
    a new `wallet` filter button in the filter row.
  - `EthereumSwapPanel` and `RobinhoodSwapPanel` each fetch wallet tokens
    on mount + on account change + every 45s, then pass them to their
    selectors.

## API key requirements

### Ethereum Mainnet

**Optional but recommended**: an Alchemy API key.

- Without the key, the endpoint falls back to on-chain `balanceOf` calls
  against the curated 22-token catalog only. The "YOUR WALLET" section
  will work, but only for those 22 tokens — any ERC-20 the wallet holds
  that isn't in the catalog will still not appear.
- With the key, the endpoint uses `alchemy_getTokenBalances` (one call
  returns every ERC-20 the wallet holds) + `alchemy_getTokenMetadata`
  for non-catalog tokens. Full discovery.

Get a free key at <https://dashboard.alchemy.com/> — sign up, create an
app, pick "Ethereum Mainnet", copy the API key. Set it as:

```bash
# .env.local (local dev) or Vercel Project Settings (production)
ALCHEMY_API_KEY=your_key_here
```

The key is read server-side only (`process.env.ALCHEMY_API_KEY`) — it is
NEVER exposed to the browser, so it must NOT be prefixed with `VITE_`.

### Robinhood Chain

**No API key required.** Robinhood Chain has no Alchemy equivalent, so
the endpoint uses `eth_getLogs` directly against the existing Robinhood
RPC (`lifiRpc(4663, ...)`). This is the same RPC already used by the
`/api/robinhood/tokens` and `/api/robinhood/trending` endpoints.

## How it works (Ethereum with Alchemy)

```text
1. POST https://eth-mainnet.g.alchemy.com/v2/{API_KEY}
   method: eth_getBalance
   → native ETH balance

2. POST https://eth-mainnet.g.alchemy.com/v2/{API_KEY}
   method: alchemy_getTokenBalances
   params: [walletAddress]
   → { tokenBalances: [{ contractAddress, tokenBalance }] }

3. For each tokenBalance > 0:
   - If contract address is in ETHEREUM_TOKEN_BY_ADDRESS (catalog hit),
     use cached symbol/name/decimals/logo (no extra round-trip).
   - Else: parallel eth_call for symbol() / name() / decimals().
```

## How it works (Robinhood Chain)

```text
1. POST {Robinhood RPC URL}
   method: eth_getBalance
   → native ETH balance

2. POST {Robinhood RPC URL}
   method: eth_getLogs
   topics: [Transfer sig, walletAsFrom]
   → all transfers OUT of the wallet

3. POST {Robinhood RPC URL}
   method: eth_getLogs
   topics: [Transfer sig, null, walletAsTo]
   → all transfers INTO the wallet

4. Union contract addresses → unique token contracts the wallet has
   ever interacted with.

5. For each contract (capped at 60):
   - Skip metadata fetch for tokens already in ROBINHOOD_VERIFIED_TOKENS.
   - Else: parallel eth_call for symbol() / name() / decimals().
   - eth_call balanceOf(wallet) → current balance.
   - Filter out balance == 0.
```

## Response shape (both endpoints)

```json
{
  "success": true,
  "chainId": 1,
  "chainKey": "ethereum",
  "source": "alchemy",          // or "on-chain-catalog-fallback" / "on-chain-logs"
  "native": {
    "balance": "123456789012345678",
    "decimals": 18,
    "symbol": "ETH",
    "name": "Ether"
  },
  "tokens": [
    {
      "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "symbol": "USDC",
      "name": "USD Coin",
      "decimals": 6,
      "logoURI": "https://tokens.1inch.io/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.png",
      "balance": "12345678",
      "source": "alchemy+catalog"  // or "alchemy" / "featured-catalog" / "verified-registry" / "on-chain-logs"
    }
  ],
  "dataAvailable": true,
  "generatedAt": "2026-09-25T..."
}
```

## Rate limits

Both endpoints use the existing `rateLimit()` helper from
`api/_lib/roninBackend.mjs`:

- `eth-wallet-tokens`: 30 requests per minute per IP
- `robinhood-wallet-tokens`: 30 requests per minute per IP

The frontend polls every 45 seconds per connected wallet, so a single
user stays well under the limit.
