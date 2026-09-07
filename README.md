# $RONIN — The Masterless Samurai

A responsive, samurai-inspired frontend for the RONIN ecosystem, built with React and Vite.

## Run locally

```bash
npm install
cp .env.example .env   # fill in your Helius RPC + (optional) Jupiter API key
npm run dev            # frontend + local /api handlers, on http://localhost:5173
```

The **Buy RONIN** panel talks to the same server-side API handlers used by
Vercel. Plain Vite development now mounts the handlers locally, so `/api/*`
requests are not mistaken for frontend modules. `npm run dev:all` remains
available when using an authenticated Vercel CLI environment.

Buy RONIN retains its existing keyless Jupiter fallback if the API proxy is
temporarily unavailable.

Production output can be checked with:

```bash
npm run build
npm run preview
```

## Notes

- Navigation is hash-based so all eight ecosystem surfaces work in a static deploy: Home, Yield, Burn, Game, NFT, Rank, Tokenomics, and Transparency.
- The wallet layer connects to `window.solana` when a browser wallet is available, reads the supplied RONIN mint (`2JVEVXoRsskapZ8T56MjMNJq6Dk3feEUYSRmzkkipump`) from Solana mainnet RPC, polls the balance every 30 seconds, and includes an explicitly labelled demo profile for UI review.
- The Home and Burn dashboards consume the shared `/api/ronin/stats` response. Its accumulated burn value is global on-chain data: the backend exhausts Helius SPL burn history and adds the configured dead/burn-wallet balance. It never uses the connected wallet balance or transaction history; if the global read fails, the UI shows an unavailable state rather than a fallback number.
- Rank is automatically calculated from the live $RONIN holding thresholds in `src/data.js` (100K Ashigaru, 500K Samurai, 2M Hatamoto, 5M Karo, 10M Daimyo, 25M Shogun, 50M Ronin Legend); Gashira stays TBA until its threshold is supplied. Each rank record also contains its portrait image, duties, subtitle, requirements, and unlocks. NFT, XP, yield, and game fields remain separate indexer boundaries until their programs are available.
- The rank experience is automatic and read-only (option 1): connect the wallet, read holdings, and show the rank—there is no buy or claim transaction.
- Yield, Burn, and NFT actions do not fake transactions. They are UI-ready boundaries that surface a clear preview/pending state until official programs and addresses are configured.
- The $RONIN mint is configured in the transparency registry. Other program addresses remain intentionally marked as unpublished placeholders in `src/data.js`.
- Set `VITE_SOLANA_RPC_URL` to a dedicated Solana RPC endpoint for production rate limits; the default uses Solana's public mainnet endpoint with PublicNode as a fallback. A provider that returns HTTP 403 should be replaced with a valid HTTPS RPC URL.
- Visual artwork is stored in `public/images/` and can be replaced without changing the page components.

## Buy RONIN

The homepage **BUY $RONIN** button opens an in-page swap panel (SOL → RONIN)
powered by Jupiter's current Swap API — no redirect to jup.ag.

- `src/components/BuyRonin.jsx` — the swap UI and state machine (idle, quote
  loading, review, Phantom confirmation, processing, success/failure).
- `src/services/jupiterService.js` — talks to `/api/jupiter/*` (proxied to
  the backend) with a same-origin, keyless Jupiter fallback if the backend
  isn't running.
- `api/` — Vercel Serverless Functions that attach backend credentials only on
  the server, so keys are never bundled into the frontend. `/api/solana/rpc`
  also proxies wallet RPC reads server-side when a browser RPC provider blocks
  cross-origin requests.
- Everything shown (SOL balance, quote, rate, price impact, minimum
  received, transaction signature, Solscan link) is live data — there is no
  mock/fake data anywhere in this flow.
- A wallet signature is only ever requested when the user presses
  **CONFIRM BUY**; connecting the wallet or opening the panel never triggers
  a signature prompt.

Environment variables (see `.env.example`):

```env
VITE_SOLANA_RPC_URL=...        # optional browser RPC fallback/transaction confirmation
VITE_RONIN_MINT_ADDRESS=...    # optional frontend override for the $RONIN mint
SOLANA_RPC_URL=...             # server-only RPC for /api/solana/rpc; never use VITE_ for secrets
HELIUS_API_KEY=...             # server-only credential
RONIN_MINT_ADDRESS=...         # server-only mint configuration
RONIN_BURN_ADDRESS=...         # optional dead/burn wallet; defaults to the published RONIN burn wallet
JUPITER_API_KEY=...             # required for Swap V2 /order + /execute
JUPITER_BASE_URL=https://api.jup.ag
JUPITER_REFERRAL_ACCOUNT=Cx98B695q8Dvum68sUdyopp8Gxh4fhZv1QhmE1mgpu47
JUPITER_REFERRAL_FEE_BPS=50
SOL_INCINERATOR_API_KEY=...    # server-only
SOL_INCINERATOR_BASE_URL=https://v2.api.sol-incinerator.com
RONIN_SHIELD_TREASURY_ADDRESS=... # server-only public treasury address for optional native SOL support
```

RONIN Shield support is optional and uses a standard native SOL transfer signed
by the connected wallet. The treasury address is displayed before approval;
private keys and seed phrases are never requested or handled. The public SOL
total is calculated from native transfers received by the configured treasury.

## Jupiter Swap V2 referral fees

The RUIN / SELL panel uses Jupiter Swap V2 (`/swap/v2/order` + `/execute`) and
passes the RoninSamurai.com referral account and 50 bps referral fee on every
eligible order:

```
referralAccount = Cx98B695q8Dvum68sUdyopp8Gxh4fhZv1QhmE1mgpu47
referralFee     = 50
```

- `api/jupiter/order.mjs` proxies `GET /api/jup/ag/swap/v2/order`, always
  adding those two params. It returns `referralAccount`, `feeMint`, `feeBps`,
  `platformFee`, and the assembled `transaction` when `taker` is supplied.
- `api/jupiter/execute.mjs` proxies `POST /api/jup/ag/swap/v2/execute` for the
  managed-landing step. Its totals are used to verify the fee was actually
  collected and in which mint.
- The Buy modal shows a live REFERRAL FEE APPLIED / NOT VERIFIED badge and
  displays `feeBps`, `platformFee.feeBps`, `feeMint`, and (after a successful
  execute) the calculated fee amount and mint.

**Important:** Jupiter Swap V2 `/order` rejects a `referralAccount` unless the
account (and its V2 referral fee accounts) were initialized under the Jupiter
Swap V2 / Ultra Referral Project:

```
DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc
```

The older Swap/Trigger referral project is
`45ruCyfdRkWpRNGEqWzjCiXRHkZs8WXCLQ67Pnpye7Hp` and is **not** accepted by
`/swap/v2/order`. The provided account
`3PwKEvN2UURHW6q4sEL8ZzgzGyzNWeLVs8gqcCdFMV7x` is a named account
(`RoninSamurai`) under that legacy project, so `/swap/v2/order` returns
“Please check that referralAccount is initialized … for project
DkiqsTrw…”. A correct Swap V2 setup must be created under the Dkiqs project.

For the `RoninSamurai` name under Dkiqs, the derived addresses are:

| Item | Address |
| --- | --- |
| Swap V2 referral account | `Cx98B695q8Dvum68sUdyopp8Gxh4fhZv1QhmE1mgpu47` |
| SOL V2 fee account (ATA) | `91ouzTGLfFUnQVzD64QPHe6MJf6bSGrcimHJk5AuqLXh` |
| USDC V2 fee account (ATA) | `A3dnQZk52dXsJjmpqKpmsLaNbwuVfDpnzYuzGNMfZpVV` |
| USDT V2 fee account (ATA) | `4XkY4izexFFuiGEFJjCHdxXPJpE7x9tngUM2HwX8ARpm` |
| RONIN V2 fee account (ATA) | `4jRAjepVA5GvFxPaz3CA3C1zH6Fis9G6Cr8wjPM9z6q7` |

### RONIN referral token account

RONIN is not shown in the referral dashboard yet, so the V2 fee account must be
created on-chain. `scripts/referral-init-ronin.mjs` uses Jupiter's Referral
SDK (`initializeReferralAccountWithName` and
`initializeReferralTokenAccountV2`) to build (and, only if you explicitly
supply a keyfile on your own machine, send) the initialization transactions:

```bash
npm run referral:init-ronin -- \
  --payer YOUR_PAYER_PUBLIC_KEY \
  --name RoninSamurai \
  --create-referral-account
```

Run with `--dry-run` (the default when no `--keyfile` is passed) to print the
unsigned transactions. The transactions create the Dkiqs referral account and
the V2 ATA fee accounts for RONIN, SOL, USDC and USDT (override with
`--mints`). Never paste or share a seed phrase or private key in this
repository or in chat.

## Vercel deployment

Import the GitHub repository into Vercel. Use the Vite framework preset,
`npm run build` as the build command, and `dist` as the output directory.
Add the server-only variables above in Vercel Project Settings for the
Production, Preview, and Development environments as needed. Never commit
`.env.local` or real credentials.
#   r o n i n P - 2  
 