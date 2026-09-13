# Implementation Tasks — Production Deploy + ETH Swap Verification

Derived from `spec.md` Acceptance Criteria.

---

## Task 1: Commit deployable working tree to git
**Status:** pending
**Priority:** high
**Maps to AC:** AC-1
**Scope:** Commits only, no code changes, no file modifications.

### Task-local Test Requirements
| ID | Type | Statement |
|---|---|---|
| TR-1.1 | **rule** | `git status --short --branch` output has **no lines starting with ` M`, ` D`, `??`, ` A`** (i.e., no tracked changes, no untracked files besides explicitly ignored ones like `.env.local`). |

### Completion Evidence
- `git status --short --branch` output after commit.
- `git log --oneline -1` showing the commit message + SHA.

---

## Task 2: Deploy current commit to Vercel production
**Status:** pending
**Priority:** high
**Maps to AC:** AC-2, AC-6
**Depends on:** Task 1

### Task-local Test Requirements
| ID | Type | Statement |
|---|---|---|
| TR-2.1 | **rule** | `vercel --prod` (or equivalent deploy command) exits with code 0, prints a production deployment URL ending in `.vercel.app` or custom domain, and state is `READY`. |
| TR-2.2 | **rule** | The deployed SHA matches the local git HEAD SHA from Task 1. |

### Completion Evidence
- Full `vercel --prod` deploy log.
- Deployed production domain URL, saved as a reusable variable for Tasks 3–6.

---

## Task 3: Verify production endpoints reachability (3 routes)
**Status:** pending
**Priority:** high
**Maps to AC:** AC-3, AC-4, AC-5
**Depends on:** Task 2

### Task-local Test Requirements
| ID | Type | Statement |
|---|---|---|
| TR-3.1 | **rule** | `curl -i <PROD_DOMAIN>/api/health` returns HTTP `200` and `Content-Type: application/json` body with `configSummary`. |
| TR-3.2 | **rule** | `curl -i -X POST <PROD_DOMAIN>/api/evm/complete -H 'Content-Type: application/json' -d '{}'` returns HTTP `4xx` (not 404 HTML) and body contains `error`. |
| TR-3.3 | **rule** | `curl -i -X POST <PROD_DOMAIN>/api/lifi/complete -H 'Content-Type: application/json' -d '{}'` returns HTTP `4xx` and body contains `error`. |

### Completion Evidence
- 3 raw curl stdouts, each with response headers + body captured.

---

## Task 4: Confirm Vercel env vars (8 required)
**Status:** pending
**Priority:** high
**Maps to AC:** AC-7
**Depends on:** Task 2

### Task-local Test Requirements
| ID | Type | Statement |
|---|---|---|
| TR-4.1 | **rule** | `vercel env ls` output (or annotated Vercel env UI screenshot) contains all 8 env vars from FR-4 with non-empty values: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ETHEREUM_RPC_URL`, `ADMIN_SESSION_SECRET`, `LIFI_BASE_URL`, `LIFI_API_KEY`, `LIFI_FEE_ENABLED`, `SAMURAI_MINIMUM_QUALIFYING_SWAP_USD`. |

### Completion Evidence
- `vercel env ls` raw output or annotated screenshot.

---

## Task 5: Confirm deployed files contain latest routing
**Status:** pending
**Priority:** medium
**Maps to AC:** AC-6
**Depends on:** Task 2

### Task-local Test Requirements
| ID | Type | Statement |
|---|---|---|
| TR-5.1 | **rule** | Vercel Source / Deploy File Tree view (or `vercel inspect <URL>` / deployed git tree compare) confirms: `vite.config.js` entries for `/api/evm/complete` + `/api/lifi/complete` exist; `server.mjs` lines 79 and 83 route entries exist; files `api/evm/complete.mjs` and `api/lifi/complete.mjs` exist. |

### Completion Evidence
- Screenshot or raw listing showing each of the 6 required items (2 from vite.config.js, 2 from server.mjs, 2 file-exists checks).

---

## Task 6: Wait for user to perform 1 manual ETH swap on deployed site
**Status:** pending
**Priority:** high
**Maps to AC:** AC-8 items 1-2 (tx hash + wallet)
**Depends on:** Task 3, Task 4, Task 5

### Task-local Test Requirements
| ID | Type | Statement |
|---|---|---|
| TR-6.1 | **rule** | User confirms in chat: (a) they initiated a real ETH swap on the production domain `/swap` page Ethereum panel, (b) MetaMask opened, (c) the UI moved to status "pending" → "confirmed" (or any intermediate status). User provides the Ethereum **transaction hash** (0x…64) and **wallet address** (0x…40) they used. |

### Completion Evidence
- User's chat message containing the 2 values above, copied verbatim into tasks.md.

---

## Task 7: Capture the 9-item completion log for the real ETH swap
**Status:** pending
**Priority:** high
**Maps to AC:** AC-8, AC-9
**Depends on:** Task 6

### Task-local Test Requirements
| ID | Type | Statement |
|---|---|---|
| TR-7.1 | **rule** | All 9 capture items from FR-5 are populated: (1) transaction hash, (2) wallet address, (3) HTTP status from `/api/evm/complete`, (4) completion API response body, (5) whether `persistEthereumSwap()` executed (via evidence — response contains swap field OR DB row exists), (6) `swap_transactions` SELECT result (row present), (7) whether `awardSamuraiPoints()` executed (response contains points OR DB row exists), (8) Samurai Points result (points_awarded + eligibility_status + exclusion_reason), (9) any Supabase error returned (if any). |
| TR-7.2 | **rule** | `SELECT * FROM swap_transactions WHERE chain_id=1 AND transaction_hash='<HASH>'` returns exactly 1 row with `verification_status='verified'` and `status='CONFIRMED'`. |
| TR-7.3 | **rule** | `SELECT * FROM samurai_points WHERE signature='<HASH>'` returns exactly 1 row with numeric `points_awarded` and non-null `eligibility_status`. |

### Completion Evidence
- Structured 9-field report (text table).
- Two Supabase SELECT outputs (copy-paste JSON/table output from Supabase SQL Editor or CLI).

---

## Task 8: (Conditional) Exact-failure remediation if completion API failed
**Status:** pending
**Priority:** high
**Maps to AC:** AC-10
**Depends on:** Task 7 — ONLY activated IF `AC-9` fails (swap confirmed on-chain but completion API failed OR missing DB rows).

### Task-local Test Requirements
| ID | Type | Statement |
|---|---|---|
| TR-8.1 | **rule** | The **exact failing step** among the 9 pipeline stages (quote-proof → duplicate-check → getTx → getReceipt → tx.from/to/data/value → getBlock → persistEthereumSwap → season/admin-settings → calculateSamuraiPoints → awardSamuraiPoints) is explicitly named with evidence (error message, stack trace, or missing intermediate row). |
| TR-8.2 | **rule** | The fix diff touches ≤ 2 files and ≤ 20 lines total, and modifies only code in or directly called by the failing step. |
| TR-8.3 | **rule** | After re-deploy (or direct retry if the issue was transient/local), a fresh POST to `/api/evm/complete` with the same body returns HTTP 200 and `success: true` (either `duplicate: false` or `duplicate: true` with correct swap + points). |
| TR-8.4 | **rule** | Re-query of `swap_transactions` + `samurai_points` now shows the rows (AC-9). |

### Completion Evidence
- Named failing step + evidence.
- Unified diff of the fix.
- Fresh curl after fix showing 200 success.
- Re-issued Supabase SELECT results.

---

## Task 9: Verify ETH swap → Swap History + Leaderboard reflection
**Status:** pending
**Priority:** medium
**Maps to AC:** AC-12 (rubric 0-2, threshold 2)
**Depends on:** Task 7 success (or Task 8 remediation if needed)

### Task-local Test Requirements
| ID | Type | Statement |
|---|---|---|
| TR-9.1 | **rule** | On the deployed `/swap` page connected to the same wallet, scrolling down to **Unified Swap History → Ethereum filter** shows the swap row with Network="Ethereum", non-null Volume, Status="CONFIRMED", non-null Points. |
| TR-9.2 | **rule** | On the deployed `/rank` page Samurai Leaderboard section, the connected wallet's stats strip shows: Lifetime Points >= the awarded points AND (if qualifying) Qualifying Swaps >= 1. |

### Completion Evidence
- Screenshot 1: `/swap` → Unified Swap History filtered to Ethereum, row visible with all 6 column non-empty values.
- Screenshot 2: `/rank` → Personal stats strip with at least Lifetime Points > 0 and matching the swap's points_awarded.

---

## Task 10: Document 3-chain swap UI workflow parity (all 3 chains)
**Status:** pending
**Priority:** high
**Maps to AC:** AC-11 (rubric 0-2, threshold 2)
**Depends on:** None — can be done in parallel with Tasks 3-5.

### Task-local Test Requirements
| ID | Type | Statement |
|---|---|---|
| TR-10.1 | **rule** | For Solana: step-by-step flow fully enumerated with source file references and line ranges for each step's implementation. |
| TR-10.2 | **rule** | For Ethereum: step-by-step flow fully enumerated with source file references and line ranges for each step's implementation. |
| TR-10.3 | **rule** | For Robinhood: step-by-step flow fully enumerated with source file references and line ranges for each step's implementation. |
| TR-10.4 | **rule** | A single "UI Flow Parity Summary" table compares: Token Selector, Quote Request, Quote Display, Wallet Connect, Approval Flow, Signing UI, Confirmation Polling, Completion API, Points Banner, Success Screen, Leaderboard Reflection — across all 3 chains. |

### Completion Evidence
- Structured per-chain step list with code references.
- Parity comparison table (markdown).
