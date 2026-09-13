# Production Deploy + ETH Swap End-to-End Verification Spec

**Created:** 2026-09-13
**Scope:** Deployment readiness verification, production endpoint availability, 1 complete Ethereum swap recorded in DB with Samurai Points, and 3-chain swap UI workflow documentation.

---

## 1. Problem & Goal

The ETH (0x) and Robinhood (LI.FI) swap completion pipelines, completion APIs, and their routes have been added locally. The local routing fix is complete and `npm run build` passes. We must now:

1. Confirm the current working tree is committed and deployable.
2. Deploy to Vercel and confirm **3 specific API endpoints** respond in production.
3. Confirm **8 specific production environment variables** are present.
4. Support the user performing **1 real ETH swap manually** on the deployed site.
5. After that swap, capture every step of the completion pipeline and verify:
   - on-chain confirmation
   - `/api/evm/complete` HTTP success
   - `swap_transactions` row inserted
   - `samurai_points` row inserted with correct Samurai Points
   - Leaderboard reflects the new points
6. If the on-chain swap succeeds but the completion API fails, fix **exactly that failure** (do not touch Samurai Points logic, DB schema, Jupiter/Solana, LI.FI routing, or UI redesign).
7. Document, in one place, the identical **3-chain swap UI flow** (Solana / Ethereum / Robinhood) so the user can compare the UX parity.

### Users affected
- Site visitors to `/api/health`, `/api/evm/complete`, `/api/lifi/complete` on production.
- The end user performing **one real ETH swap** on the production website, plus any subsequent Samurai Leaderboard viewers.

### Non-goals (explicitly forbidden by the user)
- Modify Samurai Points logic.
- Modify the database schema.
- Modify Jupiter / Solana swap flow.
- Redesign the UI.
- Change LI.FI routing logic or quote fetching.
- Create a new points system.
- Automatically perform a real swap (user will do this manually).
- Test Robinhood / LI.FI end-to-end before ETH succeeds (not in scope of this spec).

---

## 2. Functional Requirements (FR)

### FR-1: Git state clean & deployed to Vercel
Current working tree (git status output from 2026-09-13 listing 12 modified + 23 untracked items: admin auth, evm/lifi/robinhood libs, samurai points, supabase backend, admin/evm/leaderboard/lifi/robinhood/samurai/swap APIs, scripts, chains/ethereum/robinhood configs, admin page, ethereum/lifi/leaderboard/liveTrending/providerRouter/robinhoodToken services, supabase migrations) must be committed to git before deployment, so the Vercel build picks up the exact local code.

### FR-2: Three endpoints respond in production
After deploy, on the real deployed domain:
- `GET /api/health` → HTTP 200 JSON.
- `POST /api/evm/complete` with an empty/invalid payload → reachable and returns an explicit 4xx validation response (not a 404 HTML fallback from Vercel SPA routing, not 500/502).
- `POST /api/lifi/complete` with an empty/invalid payload → same reachable 4xx validation response.

### FR-3: Vercel deployment contains the latest routing files
The deployed Vercel commit SHA must contain, in its file tree, the latest contents of:
- `vite.config.js` (LOCAL_API_HANDLERS map with `/api/evm/complete`, `/api/lifi/complete` entries).
- `server.mjs` routes Map with `POST /api/evm/complete` → `evmComplete` and `POST /api/lifi/complete` → `lifiComplete`.
- Files `api/evm/complete.mjs` and `api/lifi/complete.mjs`.
- Files `api/_lib/supabaseBackend.mjs` (with `persistEthereumSwap`, `awardSamuraiPoints`), `api/_lib/samuraiPoints.mjs`, `api/_lib/ethereum.mjs`, `api/_lib/lifi.mjs`.

### FR-4: Eight required environment variables present in Vercel Project
In Vercel's Environment Variables UI (or CLI), the following must be defined (any appropriate environment: Production/Preview):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ETHEREUM_RPC_URL`
- `ADMIN_SESSION_SECRET`
- `LIFI_BASE_URL`
- `LIFI_API_KEY`
- `LIFI_FEE_ENABLED`
- `SAMURAI_MINIMUM_QUALIFYING_SWAP_USD`

### FR-5: Production ETH swap pipeline (manual user swap)
After the user performs 1 real ETH swap on the deployed site end-to-end:
- Record the **transaction hash** and **wallet address**.
- Record **HTTP status code** from the browser's call to `/api/evm/complete`.
- Record the **response body** of `/api/evm/complete`.
- Record whether `persistEthereumSwap()` in [supabaseBackend.mjs](file:///C:/Users/user/Desktop/Assignment/Ronin%202/Ronin-repo/api/_lib/supabaseBackend.mjs#L82-L90) executed (via explicit evidence: e.g. response.swap field, and/or a direct `swap_transactions` DB query).
- Confirm a row was inserted into Supabase `swap_transactions` with `chain_id = 1`, `transaction_hash = <hash>`, `verification_status = 'verified'`, `status = 'CONFIRMED'`.
- Record whether `awardSamuraiPoints()` in [supabaseBackend.mjs](file:///C:/Users/user/Desktop/Assignment/Ronin%202/Ronin-repo/api/_lib/supabaseBackend.mjs#L139-L156) executed (via response.points field and/or direct `samurai_points` DB query).
- Record **Samurai Points result**: `points_awarded`, `eligibility_status`, `exclusion_reason` (if any) for that signature.
- Record **any Supabase error** returned (status, body.message, code if available).

### FR-6: Exact-failure remediation if completion API fails
If the real ETH swap succeeds on-chain (transaction confirmed, status=0x1) but `/api/evm/complete` returns non-2xx or 2xx with `success:false`:
- Identify the **exact failure step** among: quote proof verification, existing-duplicate check, eth_getTransactionByHash, eth_getTransactionReceipt, tx.from/to/data/value match, eth_getBlockByNumber, `persistEthereumSwap`, season lookup, admin settings, points calculation, `awardSamuraiPoints`.
- Fix **only that step's immediate issue** (smallest possible change set).
- Re-run `/api/evm/complete` for the same transaction hash (idempotent — duplicate check at line 33 of evm/complete.mjs must either re-return existing row, or the fix must make the fresh call succeed on the previously-failing step).
- Verify DB rows exist after fix.

### FR-7: Leaderboard reflects the ETH swap points
After a successful completion (FR-5), the Samurai leaderboard table on Rank page must include the user's wallet with points matching the Samurai Points result. Specifically:
- The wallet should appear in either the top-100 leaderboard list or the personal stats strip at the top.
- Lifetime Points >= the points awarded.
- If the swap volume is >= the qualifying threshold, then "Qualifying Swaps" increments by at least 1.

### FR-8: 3-chain swap UI workflow documented in one place
Provide a single detailed description of the **Swap page UI flow parity** across all three chains (Solana / Ethereum / Robinhood). For each chain, the flow must be described step-by-step, listing the UI screens/states a user sees in order, using the implementation in:
- Solana: BuyRonin.jsx + JupiterService + Swap verify/record APIs.
- Ethereum: [EthereumSwapPanel](file:///C:/Users/user/Desktop/Assignment/Ronin%202/Ronin-repo/src/pages/Swap.jsx#L146-L329) + [ethereumService.js](file:///C:/Users/user/Desktop/Assignment/Ronin%202/Ronin-repo/src/services/ethereumService.js) + [/api/evm/complete](file:///C:/Users/user/Desktop/Assignment/Ronin%202/Ronin-repo/api/evm/complete.mjs#L1-L52).
- Robinhood: [RobinhoodSwapPanel](file:///C:/Users/user/Desktop/Assignment/Ronin%202/Ronin-repo/src/pages/Swap.jsx#L410-L616) + [lifiService.js](file:///C:/Users/user/Desktop/Assignment/Ronin%202/Ronin-repo/src/services/lifiService.js) + [/api/lifi/complete](file:///C:/Users/user/Desktop/Assignment/Ronin%202/Ronin-repo/api/lifi/complete.mjs#L1-L49).

Each documented flow must enumerate in order: **Token Selection → Amount Entry → Quote Request → Quote Display → Wallet Connect/Ensure Chain → Approval (if needed) → Signing → On-chain Confirmation → Completion API Call → Success Screen (with Points shown) → Leaderboard Reflection**.

---

## 3. Non-Functional Requirements (NFR)

- **NFR-1 (No regression zones):** The following must not be touched during this entire spec unless the "exact failure remediation" FR-6 explicitly proves they are the root cause of `/api/evm/complete` failure:
  - `samuraiPoints.mjs` (Samurai Points logic)
  - `supabase/migrations/*` (database schema)
  - Jupiter/Solana files: `api/jupiter/*`, `src/services/jupiterService.js`, `src/components/BuyRonin.jsx`
  - LI.FI quote/routing: `api/lifi/quote.mjs`, `api/lifi/status.mjs`, `src/services/lifiService.js` quote path
  - UI redesign files, style sheets beyond minimal fixes
  - Any new points system / table / RPC outside the existing award pipeline
- **NFR-2 (Idempotency):** Re-running `/api/evm/complete` for the same transactionHash must not create duplicate rows (guaranteed by line 33-34 of evm/complete.mjs, but we must verify this with evidence).
- **NFR-3 (Evidence preservation):** Every acceptance check below must include concrete evidence (command outputs, curl responses, screenshot/log links, Supabase SQL query outputs). No "assumed good".

---

## 4. Constraints, Dependencies, Assumptions

### Constraints
- User will perform the real ETH swap manually; we **must not** send a real transaction ourselves.
- Vercel deploy target is preconfigured (project likely linked to existing Vercel project with custom domain).
- Only 1 successful ETH swap recording is required before Robinhood testing.

### Dependencies
- Vercel CLI or Vercel project linked via `.vercel/project.json`.
- Supabase project URL + service role key already present in Vercel env (verified by FR-4).
- Ethereum RPC URL working for `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getBlockByNumber` on mainnet.
- User's MetaMask has ETH on Ethereum Mainnet to pay gas + swap input.

### Assumptions (will validate during implementation)
1. Vercel auto-discovers files in `/api/**` as serverless functions, so the explicit route map in `server.mjs` is only for `node server.mjs` deployments and NOT required for Vercel deploys. The `LOCAL_API_HANDLERS` map in `vite.config.js` is only used for Vite dev. We will explicitly validate both (FR-3) and confirm via real curl that the production domain serves these routes.
2. `shield-scan.mjs` missing file from server.mjs does NOT affect Vercel production because Vercel does not import `server.mjs`. We will not fix it in this spec unless it causes a deploy build failure.
3. `bs58` missing dep (burn service) does NOT affect the ETH swap pipeline.
4. README-specified Jupiter referral account mismatch does NOT affect ETH swap (different provider).

### Open Questions
- **Q1:** What is the Vercel project name / deployed domain we are targeting? If not yet deployed, we will use the default `*.vercel.app` domain from the first deploy.
- **Q2:** What is the Supabase project URL we are connecting against? Used for direct DB queries after the swap. (We can read `SUPABASE_URL` from `.env.local` as long as it matches Vercel prod env.)
- **Q3:** Does the user want git commit messages specified, or a single commit? (Default: single descriptive commit, no push forced.)

---

## 5. Acceptance Criteria (rule / rubric)

| ID | Type | Statement | Pass evidence |
|---|---|---|---|
| AC-1 | **rule** | `git status --short --branch` after commit shows only `## main...origin/main` with zero entries below (or only expected ignored files like `.env.local`). | Raw `git status` output. |
| AC-2 | **rule** | Vercel deploy completes with deployment URL printed and `READY` state. | Raw Vercel deploy log + final deployed domain. |
| AC-3 | **rule** | `curl -i <DEPLOYED>/api/health` shows HTTP/2 200 (or HTTP/1.1 200) with JSON body. | Raw curl stdout. |
| AC-4 | **rule** | `curl -i -X POST <DEPLOYED>/api/evm/complete -H 'Content-Type: application/json' -d '{}'` returns a 4xx response with `Content-Type: application/json` and an `error` field in the body (404 from SPA fallback is a fail; 400/405/422 with JSON is pass). | Raw curl stdout. |
| AC-5 | **rule** | `curl -i -X POST <DEPLOYED>/api/lifi/complete -H 'Content-Type: application/json' -d '{}'` returns a 4xx response with `Content-Type: application/json` and an `error` field in the body. | Raw curl stdout. |
| AC-6 | **rule** | The git commit SHA deployed to Vercel matches the local committed SHA, and the Vercel Source page shows both `vite.config.js` and `server.mjs` with the new route entries, plus `api/evm/complete.mjs` and `api/lifi/complete.mjs`. | Screenshots or `vercel ls` / file listing of the deploy with file paths present. |
| AC-7 | **rule** | All 8 required environment variables from FR-4 are present in Vercel (non-empty values). | `vercel env ls` output (or annotated screenshot of env UI). |
| AC-8 | **rule** | After the user's manual ETH swap: the 9-item capture log from FR-5 is complete. 9 of 9 items populated. | Structured 9-field report in tasks.md. |
| AC-9 | **rule** | After swap: Supabase `swap_transactions` row exists for the hash, and `samurai_points` row exists for the same signature with non-null `eligibility_status` and numeric `points_awarded`. | Two SQL SELECT outputs with rows visible. |
| AC-10 | **rule** | IF the first `/api/evm/complete` call fails despite on-chain success, then: (a) exact failing step is named (one of the 9 pipeline steps), (b) diffs to fix are <10 lines and only touch files in that failing step, (c) re-running `/api/evm/complete` succeeds (or returns `duplicate: true` success), (d) AC-9 passes after remediation. | Named failing step + small diff + output after fix. |
| AC-11 | **rubric 0-2** (pass threshold: 2) | **3-chain swap UI workflow documentation completeness.** 2: Every step enumerated for all 3 chains with file references; parity comparison included. 1: 2 of 3 chains fully enumerated. 0: Less than 2 chains documented or missing step ranges. | Documented step table in spec.md tasks.md or review.md. |
| AC-12 | **rubric 0-2** (pass threshold: 2) | **End-to-end ETH swap → leaderboard connection.** 2: Swap hash appears in Swap History table (filter chain=ethereum) AND Rank page leaderboard shows personal stats increment. 1: Only one of the two (history OR leaderboard) reflects. 0: Neither reflects. | Two screenshots: Swap History filtered to Ethereum with row visible, + Rank page personal stats strip. |
