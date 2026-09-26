# Ronin-swap Wallet Link — Accounting Fix + Supabase Compilation Fix

## Status (2026-09-26, updated)

PR #1 was merged to `main`. The current `main` has:

1. ✅ The original wallet-link implementation (commit `e8a3531`)
2. ❌ **The accounting bug** — `claim_reward()` used `wallets.claimed_points`
   on the canonical Solana wallet as the authoritative consumed-points
   counter for the entire verified identity. This creates a
   duplicate-claim vulnerability under link → claim → unlink → earn →
   relink cycles.
3. ❌ **A Supabase compilation error** — the original migration declared
   `v_identity public.get_verified_reward_identity%ROWTYPE`, but
   `%ROWTYPE` only works for tables/views, not for functions returning
   `jsonb`. PL/pgSQL raises `42P01: relation does not exist` when
   trying to compile the function.
4. ❌ **1,055 leaked environment-internal files** — the `skills/`,
   `download/`, `worklog.md` directories got swept into a container
   auto-commit and merged into `main`.

Branch `fix/wallet-link-accounting` on GitHub contains the fix for
all three problems (3 commits on top of `main`):

| Commit | Purpose |
|---|---|
| `cf52940` | Remove 1,055 leaked env-internal files + harden `.gitignore` |
| `1abc4b3` | Add `wallet_point_consumption` ledger; fix duplicate-claim bug |
| `ed7b251` | Replace `%ROWTYPE` with `jsonb` + `->>` operators — fixes the Supabase `42P01` error |

## Files in this download directory

| File | Size | Purpose |
|---|---|---|
| `cleanup-leaked-files.sh` | 5.0 KB | Shell script: removes 1,055 leaked files + hardens `.gitignore` (alternative to applying patch 0001, which would be 60 MB) |
| `0001-accounting-fix.patch` | 92 KB | Adds `wallet_point_consumption` ledger; fixes the duplicate-claim bug |
| `0002-supabase-compilation-fix.patch` | 16 KB | Replaces `%ROWTYPE` with `jsonb` — fixes the `42P01` compilation error |
| `README.md` | (this file) | Walkthrough |

## How to apply — TWO OPTIONS

### Option A — Pull the GitHub branch (recommended)

```bash
# On your local machine:
git clone https://github.com/kkainatAMIR/Ronin-swap.git
cd Ronin-swap

# Fetch and checkout the fix branch
git fetch origin fix/wallet-link-accounting
git checkout fix/wallet-link-accounting

# Verify the branch is at ed7b251 (the ROWTYPE fix)
git log --oneline -4
# Expected:
#   ed7b251 fix(wallet-link): replace %ROWTYPE with jsonb to fix Supabase compilation error
#   1abc4b3 fix(wallet-link): per-wallet consumption ledger prevents unlink/relink double-claim
#   cf52940 chore: remove leaked environment-internal files + .gitignore hardening
#   6f62be7 Merge pull request #1 from kkainatAMIR/feat/wallet-link-v1

# Merge to main (or open a PR)
git checkout main
git merge --ff-only fix/wallet-link-accounting  # fast-forward merge
git push origin main

# Apply the DB migration (idempotent — safe to re-run)
supabase db push
```

### Option B — Apply the patches manually

Use this if you can't pull from GitHub (e.g., the old PAT was revoked).

```bash
# On your local machine:
git clone https://github.com/kkainatAMIR/Ronin-swap.git
cd Ronin-swap
git checkout main
git pull origin main

# 1. Run the cleanup script (removes leaked files + hardens .gitignore)
bash /path/to/download/cleanup-leaked-files.sh

# 2. Apply the accounting-fix patch
git am /path/to/download/0001-accounting-fix.patch

# 3. Apply the Supabase-compilation-fix patch
git am /path/to/download/0002-supabase-compilation-fix.patch

# 4. Apply the DB migration
supabase db push

# 5. Push to your repo
git push origin chore/cleanup-leaked-files   # or whichever branch you're on
```

## How to verify before merging

```bash
# Install the new ethers dependency (already in package.json)
npm install

# Run the static tests (all should pass)
python3 scripts/test_wallet_link_migration.py            # 35 tests
node    scripts/test_wallet_link_security.mjs            # 58 tests
python3 scripts/test_wallet_link_accounting_scenarios.py  # 6 tests (S1-S5 + cross-identity hijack)

# Verify the SQL migration parses cleanly with a real Postgres parser
python3 scripts/validate_migration_parses.py
# Expected: "OK: parsed 43 top-level statement(s)."

# Run the live SQL accounting scenario tests against Supabase
psql $DATABASE_URL -f scripts/test_wallet_link_accounting_scenarios.sql
# Walks through S1-S5 with BEGIN/ROLLBACK per scenario — no production pollution.

# Build the frontend (confirm no syntax errors)
npm run build
```

## What the Supabase compilation fix does

### The error on Supabase

```text
ERROR:  42P01: relation "public.get_verified_reward_identity"
        does not exist
CONTEXT: compilation of PL/pgSQL function
         "get_wallet_reward_balance" near line 4
```

### Root cause

The original migration declared PL/pgSQL variables like this:

```sql
v_identity public.get_verified_reward_identity%ROWTYPE;
```

`%ROWTYPE` is for tables/views. It does NOT work for functions returning
scalar/composite types like `jsonb`. PL/pgSQL tried to resolve
`public.get_verified_reward_identity` as a table/view during function
compilation, and failed with `42P01`.

### The fix

```sql
v_identity jsonb;
```

Then access fields with jsonb operators:

```sql
v_identity := public.get_verified_reward_identity(p_wallet_address);
v_solana_wallet := v_identity->>'solana_wallet';

-- linked_evm_wallets is a jsonb array; convert to text[]:
select array_agg(elem::text) into v_linked_evm_wallets_arr
  from jsonb_array_elements_text(
    coalesce(v_identity->'linked_evm_wallets', '[]'::jsonb)
  ) AS elem;
```

### Verification

The migration parses cleanly with `pglast` (a real Postgres parser):

```text
$ python3 scripts/validate_migration_parses.py
Parsing 20260926000000_wallet_links.sql (44,831 bytes)...
OK: parsed 43 top-level statement(s).
Statement inventory:
  AlterTableStmt: 3
  CreateFunctionStmt: 6
  CreateStmt: 3
  GrantStmt: 18
  IndexStmt: 12
  InsertStmt: 1
```

## What the accounting fix does

### The bug (original `claim_reward`)

```text
earned_points(identity) = sum(samurai_points.final_points across linked wallets)
claimed_points(identity) = canonical_solana_wallet.claimed_points   ← THE BUG
claimable = earned - claimed
```

If the EVM is unlinked and re-linked to a DIFFERENT Solana wallet, the
EVM's previously-claimed points become claimable again because the
consumed counter lives on the Solana wallet row, not on the EVM's row.

### The fix (new `wallet_point_consumption` table)

Per-wallet consumption ledger that travels with the `wallet_id`, NOT
with the link.

```text
earned_points(wallet_id)   = sum(samurai_points.final_points)
consumed_points(wallet_id)  = sum(wallet_point_consumption.points_consumed)
claimable_points(identity)  = sum(earned across identity) - sum(consumed across identity)
```

The consumed amount stays tied to the `wallet_id` of the wallet that
originally earned the point — even after unlink/relink or even after
the EVM is linked to a different Solana wallet.

### FIFO distribution

When a claim is made, the consumed points are distributed FIFO across
the identity wallets:

1. Canonical Solana wallet (oldest by definition)
2. Linked EVM wallets ordered by `verified_at ASC` (oldest link first)

For each wallet, take `min(remaining, max(earned_for_wallet - consumed_for_wallet, 0))`
and insert a `wallet_point_consumption` row.

### Backward compatibility

- `wallets.claimed_points` column is PRESERVED (not dropped, not reset).
- Existing users with `claimed_points > 0` are BACKFILLED via a single
  `MIGRATION_BACKFILL` row in `wallet_point_consumption` per wallet.
- The backfill is IDEMPOTENT — a partial unique index on
  `(wallet_id) WHERE source='MIGRATION_BACKFILL'` makes the migration
  safe to re-run.
- The migration is purely additive — no existing data is touched.

## Scenario coverage (verified by tests)

| Scenario | Test | Expected result |
|---|---|---|
| S1: Normal link (25+150=175, claim all) | `test_wallet_link_accounting_scenarios.py::TestScenario1` | claimable becomes 0 |
| S2: Solana-only legacy user (50 SP, pre-existing claimed=10) | `TestScenario2` | only 40 claimable, then 0 |
| S3: Partial claims (200 SP, claim 100 twice) | `TestScenario3` | third claim rejected with NO_CLAIMABLE_POINTS |
| S4: Unlink after claim (175 SP claimed, then unlink EVM) | `TestScenario4` | EVM's 150 consumed stays tied to EVM wallet_id; no reclaim possible |
| S5: Unlink, earn +50, re-link | `TestScenario5` | only 50 SP claimable, NOT 175 or 225 |
| S6: Cross-identity hijack accounting | `TestCrossIdentityHijackAccounting` | EVM consumed travels with wallet_id; different Solana wallet cannot reclaim |
| S7: Fake localStorage | `test_wallet_link_security.mjs` (static) | Backend never consults localStorage; verified identity comes from DB only |
| S8: EVM cannot claim directly | `test_wallet_link_security.mjs` | `claim_reward(0xABC, ...)` raises `EVM_CLAIM_NOT_ALLOWED` |
| S9: Arbitrary wallet query | `test_wallet_link_security.mjs` | `?wallet=A,B` rejected by single-wallet validator |
| S10: Replay attack | `test_wallet_link_security.mjs` | Challenge marked USED atomically; replay raises `CHALLENGE_NOT_PENDING` |
| S11: Expired challenge | `test_wallet_link_security.mjs` | Marked EXPIRED; rejected with `CHALLENGE_EXPIRED` |
| S12: Wrong signature | `test_wallet_link_security.mjs` | EVM/Solana sig mismatch raises `EVM_SIGNATURE_INVALID` / `SOLANA_SIGNATURE_INVALID` |

## Total test counts (all pass)

- 58 Node tests (`scripts/test_wallet_link_security.mjs`)
- 35 Python migration static tests (`scripts/test_wallet_link_migration.py`)
- 6 Python accounting scenario simulations (`scripts/test_wallet_link_accounting_scenarios.py`)
- 1 SQL parse validation (`scripts/validate_migration_parses.py`)
- Live SQL scenarios (`scripts/test_wallet_link_accounting_scenarios.sql`) — apply against a Supabase instance to verify end-to-end

## Rust contract status

**UNCHANGED.** The deployed Anchor program at
`6Uyjo8oDGQJeb8zS1yFqwLCguc4gfUB1V4xWheAD7RYC` was not touched:
- Program ID — unchanged
- Reward PDA seeds — unchanged
- Reward vault — unchanged
- `claim_reward` instruction — unchanged
- Claim PDA derivation — unchanged
- Claim ID mechanism — unchanged
- On-chain reward calculation — unchanged
- Existing Solana payout mechanism — unchanged

## Existing claims preservation

**PRESERVED.** The migration is purely additive:
- Existing `reward_claims` rows — untouched
- Existing `samurai_points` awards — untouched
- Existing `wallets.claimed_points` values — preserved (backfilled into
  the new ledger, not reset)
- Existing claim transaction signatures — untouched
- Completed rewards — untouched
