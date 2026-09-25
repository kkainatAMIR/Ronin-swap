# Rewards — User-Pays-Fee Flow

This document explains the user-pays-fee reward claim flow that lets
the **user** pay the Solana transaction fee when claiming rewards,
instead of the backend admin wallet.

## TL;DR

When a user clicks **CLAIM** in the rewards panel:

1. Frontend calls `POST /api/rewards/claim-prepare` → backend creates
   an ENTITLED claim row + returns a partially-signed transaction
   (admin signs the instruction; user is set as fee payer).
2. Frontend passes the partially-signed tx to Phantom, which adds
   the user's fee-payer signature.
3. Frontend submits the fully-signed tx to Solana via
   `connection.sendRawTransaction`.
4. Frontend calls `POST /api/rewards/claim-confirm` with the resulting
   signature → backend verifies the tx landed + matches the claim +
   marks it COMPLETED.

If the user rejects the Phantom popup or closes it:

- Frontend calls `POST /api/rewards/claim-cancel` → backend reverts
  the ENTITLED row + restores the user's `claimed_points`.

If the user starts the flow but never finishes it (browser closed,
network died, navigated away):

- A cron job (`scripts/cleanup-orphan-claims.mjs`) reverts ENTITLED
  claims older than 5 minutes and restores the user's points.

## Why user-pays-fee?

| Aspect | Admin pays (legacy) | User pays (new) |
|---|---|---|
| Who signs | Admin keypair | User's Phantom wallet |
| Who pays gas | Admin wallet | User wallet |
| Phantom popup | No | Yes |
| User needs SOL for gas | No | Yes (~0.000005 SOL) |
| Admin wallet drain rate | Per-claim fees + reward | Reward only |
| Decentralization | Low | Higher |

The user-pays model moves the gas burden from the admin wallet to the
user. The admin wallet no longer needs to be topped up for fees — only
for the vault that holds the actual reward SOL.

## Contract compatibility

The deployed `ronin_rewards` program at
`6Uyjo8oDGQJeb8zS1yFqwLCguc4gfUB1V4xWheAD7RYC` requires no changes.
The on-chain `claim_reward` instruction:

```rust
#[derive(Accounts)]
#[instruction(claim_id: String)]
pub struct ClaimReward<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,            // admin must still sign the instruction
    #[account(mut, ..., has_one = admin)]
    pub reward_config: Account<'info, RewardConfig>,
    #[account(mut, ...)]
    pub reward_vault: Account<'info, RewardVault>,
    #[account(mut)]
    pub recipient: SystemAccount<'info>, // user — NOT a signer on the instruction
}
```

Key insight: **the instruction signer (admin) and the transaction fee
payer are independent concepts in Solana**. The admin signs the
instruction to satisfy `has_one = admin`. The user pays the network fee
because `tx.feePayer = userWallet`. Both signatures are required for
the tx to land — neither alone is sufficient.

This means:
- The user cannot forge a claim (they can't sign the instruction)
- The admin cannot be charged the fee (they didn't set themselves as
  fee payer)
- The vault still dispenses the reward SOL to the recipient

## Endpoints

### `POST /api/rewards/claim-prepare`

**Body:** `{ wallet, claimId, pointsToClaim? }`

**Returns:**
```json
{
  "success": true,
  "flow": "user-pays-fee",
  "claim": { "claim_id": "...", "points_claimed": 100, "reward_amount": 0.1, ... },
  "partiallySignedTx": "<base64>",
  "feePayer": "<user wallet address>",
  "blockhash": "...",
  "lastValidBlockHeight": 123456,
  "rewardAmountLamports": 100000000,
  "pointsClaimed": 100,
  "programId": "6Uyjo8...",
  "network": "mainnet-beta",
  "earned_points": 100,
  "claimed_points": 0,
  "claimable_points": 0,
  "message": "Sign the transaction in your wallet to claim your reward. You will pay the network fee."
}
```

The `partiallySignedTx` is a base64-encoded serialized `Transaction`
with:
- `recentBlockhash` set
- `feePayer = userWallet`
- Admin's partial signature (only signs the instruction, not the fee
  payer)

The frontend passes this to Phantom's `signTransaction()` which adds
the user's signature.

### `POST /api/rewards/claim-confirm`

**Body:** `{ claimId, signature, wallet }`

**Returns (success):**
```json
{
  "success": true,
  "claim_id": "...",
  "signature": "...",
  "explorer_url": "https://explorer.solana.com/tx/...",
  "claim": { ... },
  "recipient_balance_before": 100000,
  "recipient_balance_after": 200000,
  "message": "Reward claim completed. SOL has been transferred to your wallet."
}
```

**Returns (pending — tx not yet confirmed):**
```json
{
  "success": false,
  "pending": true,
  "claim_id": "...",
  "signature": "...",
  "message": "The transaction has not been confirmed on Solana yet. Wait a few seconds and retry /api/rewards/claim-confirm."
}
```

The backend verifies the tx:
1. Polls `getTransaction` for up to 30 seconds
2. Confirms `meta.err == null` (tx succeeded)
3. Confirms the tx called our `claim_reward` instruction on our program
4. Confirms the recipient's balance actually increased

If all checks pass, transitions `ENTITLED → PENDING_PAYOUT → COMPLETED`
via the existing Supabase RPCs.

### `POST /api/rewards/claim-cancel`

**Body:** `{ claimId, reason? }`

**Returns:**
```json
{
  "success": true,
  "reverted": true,
  "claim_id": "...",
  "claim": { ... },
  "points_restored": 100,
  "message": "Claim cancelled. Your points have been restored and can be claimed again."
}
```

Idempotent — calling it twice is safe. The second call returns
`{ success: true, idempotent: true, message: "This claim was already cancelled." }`.

## Orphan cleanup

If a user calls `/api/rewards/claim-prepare` but never finishes the
flow (closes browser, network dies, etc.), the ENTITLED row sits in
the DB indefinitely — locking the user's `claimed_points`.

Run `scripts/cleanup-orphan-claims.mjs` as a cron job every 5 minutes:

```bash
*/5 * * * * cd /path/to/Ronin-swap && node scripts/cleanup-orphan-claims.mjs >> /var/log/orphan-claims.log 2>&1
```

Or on Vercel Cron — add an endpoint `/api/admin/rewards/cleanup` that
calls the same logic. (Not implemented yet — would need a new admin
endpoint registered in `_routes.mjs`.)

The script:
1. Queries `reward_claims` for ENTITLED rows older than 5 minutes
2. For each, calls `revert_failed_reward_claim` (idempotent)
3. Logs the result

Configurable via env:
```bash
ORPHAN_CLAIM_TTL_MINUTES=5  # default
```

## Backward compatibility

The legacy `POST /api/rewards/claim` endpoint (admin-pays-fee,
custodial flow) is **retained** and unchanged. It's used as a fallback
in two scenarios:

1. **Mobile browsers without Phantom**: the `RewardClaimPanel`
   detects `getSolanaProvider() === null` and falls back to the
   admin-pays flow automatically.
2. **Admin/devnet testing**: the legacy endpoint can be called
   directly to test the custodial flow without a Phantom popup.

The legacy endpoint remains the source of truth for admin-only
operations (e.g. bulk payouts from the admin dashboard, if ever added).

## Failure modes + reconciliation

| Failure | Detection | Recovery |
|---|---|---|
| User rejects Phantom popup | Frontend catches `signTransaction` rejection | Frontend calls `/claim-cancel` → ENTITLED → FAILED, points restored |
| User closes browser mid-flow | Orphan cleanup cron | `/cleanup-orphan-claims` reverts ENTITLED rows older than 5 min |
| Tx submitted but not confirmed in 90s | Frontend `confirmSolanaTransaction` timeout | Frontend still calls `/claim-confirm` in background; backend polls Solana for 30s and either marks COMPLETED or leaves ENTITLED for retry |
| Backend crashes after `/claim-prepare` | ENTITLED row in DB, no signature submitted | Orphan cleanup cron reverts after 5 min |
| Backend crashes after tx submission but before `/claim-confirm` | Tx landed on-chain; ENTITLED row in DB | User retries `/claim-confirm` later (works for up to ~60s after submission); otherwise admin reconciles via signature lookup |
| Tx lands but fails on-chain | Backend `/claim-confirm` detects `meta.err != null` | Backend calls `revert_failed_reward_claim` → ENTITLED → FAILED, points restored |
| Tx never lands (rejected by network before broadcast) | Backend `/claim-confirm` returns `not_found` after 30s | Frontend can retry `/claim-confirm` later, or call `/claim-cancel` to give up |

## Idempotency

Every step is idempotent:

- `claim_reward` RPC: unique constraint on `claim_id` → no duplicate ENTITLED rows
- `mark_reward_claim_pending_payout`: idempotent on already-PENDING rows
- `revert_failed_reward_claim`: idempotent on already-FAILED rows
- `update_reward_claim_status`: idempotent on already-COMPLETED rows
- `/claim-cancel`: idempotent — second call returns success without modifying state

This means the user can:
- Retry `/claim-confirm` if it times out
- Cancel and re-claim with a fresh `claim_id` if anything goes wrong
- Never double-spend or double-receive

## Configuration

No new env vars required. The flow uses the existing:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (DB access)
- `NEW_SOLANA_REWARDS_ADMIN_SECRET_KEY` (admin signs the instruction)
- `SOLANA_RPC_URL` or `HELIUS_API_KEY` (Solana RPC)
- `SOLANA_REWARDS_PROGRAM_ID` (defaults to the Mainnet program)

Optional:
- `ORPHAN_CLAIM_TTL_MINUTES=5` (orphan cleanup threshold)
