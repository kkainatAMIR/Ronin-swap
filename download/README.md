# Ronin-swap Wallet Link — Accounting Fix Package

## Status (2026-09-26)

PR #1 was merged to `main` but it included:

1. ✅ The original wallet-link implementation (commit `e8a3531`)
2. ❌ **The accounting bug** — `claim_reward()` used
   `wallets.claimed_points` on the canonical Solana wallet as the
   authoritative consumed-points counter for the entire verified
   identity. This creates a duplicate-claim vulnerability under
   link → claim → unlink → earn → relink cycles.
3. ❌ **1,055 leaked environment-internal files** (the `skills/`
   directory, `download/` directory, and `worklog.md` — all from
   the dev container's auto-commit).

This package contains two files that fix both problems:

| File | Purpose |
|---|---|
| `cleanup-leaked-files.sh` | Removes 1,055 leaked env-internal files + hardens `.gitignore` |
| `0001-fix-accounting-bug.patch` | Adds the `wallet_point_consumption` ledger; fixes the duplicate-claim vulnerability |

## How to apply

```bash
# 1. On your local machine, clone Ronin-swap fresh
git clone https://github.com/kkainatAMIR/Ronin-swap.git
cd Ronin-swap

# 2. Make sure main is up to date
git checkout main
git pull origin main

# 3. Run the cleanup script (removes leaked files + updates .gitignore)
bash /path/to/download/cleanup-leaked-files.sh

# 4. Apply the accounting fix patch
git am /path/to/download/0001-fix-accounting-bug.patch

# 5. Verify everything is correct
npm install                                    # picks up ethers v6
python3 scripts/test_wallet_link_migration.py  # 34 tests — should all pass
node    scripts/test_wallet_link_security.mjs  # 58 tests — should all pass
python3 scripts/test_wallet_link_accounting_scenarios.py  # 6 tests — S1-S5 + cross-identity hijack

# 6. Apply the DB migration to Supabase (the migration is idempotent — safe to re-run)
supabase db push
# OR paste supabase/migrations/20260926000000_wallet_links.sql
# into the Supabase SQL Editor → Run

# 7. Run the live SQL accounting scenario tests (optional but recommended)
psql $DATABASE_URL -f scripts/test_wallet_link_accounting_scenarios.sql

# 8. Push the cleanup + fix to your fork and open a PR
git push origin chore/cleanup-leaked-files
gh pr create --title "fix(wallet-link): per-wallet consumption ledger + leaked-file cleanup"
```

## What the accounting fix does

### The bug

Original `claim_reward()`:

```text
earned_points(identity) = sum(samurai_points.final_points across linked wallets)
claimed_points(identity) = canonical_solana_wallet.claimed_points   ← THE BUG
claimable = earned - claimed
```

If the EVM is unlinked and re-linked to a DIFFERENT Solana wallet, the
EVM's previously-claimed points become claimable again because the
consumed counter lives on the Solana wallet row, not on the EVM's row.

### The fix

New `wallet_point_consumption` table — a per-wallet consumption ledger
that travels with the `wallet_id`, NOT with the link.

```text
earned_points(wallet_id)    = sum(samurai_points.final_points)
consumed_points(wallet_id)   = sum(wallet_point_consumption.points_consumed)
claimable_points(identity)   = sum(earned across identity)
                             - sum(consumed across identity)
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
and insert a `wallet_point_consumption` row. This guarantees:

- The canonical Solana wallet is "drained" first (preserving the legacy
  semantics where Solana-only users' claims are tracked on their own
  wallet row).
- EVM wallets' consumption rows persist on the EVM `wallet_id`, so
  unlink/relink cannot reset them.

### Backward compatibility

- `wallets.claimed_points` column is PRESERVED (not dropped, not reset).
- It's kept in sync on new claims (incremented on canonical Solana)
  for legacy admin tooling, but it is NOT the authoritative source.
- Existing users with `claimed_points > 0` are BACKFILLED via a single
  `MIGRATION_BACKFILL` row in `wallet_point_consumption` per wallet.
- The backfill is IDEMPOTENT — a partial unique index on
  `(wallet_id) WHERE source='MIGRATION_BACKFILL'` makes the migration
  safe to re-run.

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

## Total test counts

- 58 Node tests (`scripts/test_wallet_link_security.mjs`) — all pass
- 34 Python migration static tests (`scripts/test_wallet_link_migration.py`) — all pass
- 6 Python accounting scenario simulations (`scripts/test_wallet_link_accounting_scenarios.py`) — all pass
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
