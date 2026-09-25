# Rewards Contract Upgrade — September 2026

This document records a breaking change to the on-chain `ronin_rewards`
Solana program and the backend changes required to support it. It is
intended for future engineers so they understand why the
`claim_reward` instruction builder emits only four accounts and why
the per-claim PDA helpers still exist but are no longer used by the
claim flow.

## TL;DR

The deployed program at `6Uyjo8oDGQJeb8zS1yFqwLCguc4gfUB1V4xWheAD7RYC`
was upgraded to remove the per-claim PDA and the System Program from
the `claim_reward` instruction. The backend's
`buildClaimRewardInstruction` was updated to send exactly the four
accounts the upgraded contract expects. **Do not re-add a `claim`
PDA or `system_program` to the keys array — Anchor will reject the
instruction with an account-count mismatch.**

## What changed on-chain

### Previous contract (pre-upgrade)

The `claim_reward` instruction accepted **six accounts**:

```
0. admin          (signer, mut)
1. reward_config  (mut)
2. reward_vault   (mut)
3. recipient      (mut)
4. claim          (mut)   — per-claim PDA derived from claim_id
5. system_program          — System program (used to allocate the PDA)
```

The contract used `init` semantics on the `claim` PDA, which meant
the System Program was required to allocate the account and the admin
keypair paid ~880 lamports of rent per claim.

### Upgraded contract (2026-09)

The `claim_reward` instruction now accepts **four accounts** only:

```rust
#[derive(Accounts)]
#[instruction(claim_id: String)]
pub struct ClaimReward<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(mut, seeds = [b"reward_config"], bump = reward_config.bump, has_one = admin)]
    pub reward_config: Account<'info, RewardConfig>,

    #[account(mut, seeds = [b"reward_vault"], bump = reward_config.vault_bump)]
    pub reward_vault: Account<'info, RewardVault>,

    #[account(mut)]
    pub recipient: SystemAccount<'info>,
}
```

Notable differences:

- **No `claim` account** — the contract no longer allocates a per-claim
  PDA. SOL is moved directly from the `reward_vault` PDA to the
  recipient via `**vault_info.try_borrow_mut_lamports()? -= amount`
  and the symmetric increment on the recipient.
- **No `system_program`** — because no account is being allocated, the
  System Program is not required as a signer/account.
- The contract's `Claim` struct is intentionally retained in the
  source for backward compatibility with old on-chain PDAs created by
  the previous program version. The new contract never creates new
  Claim accounts, and existing ones are left untouched.

### Why the upgrade was made

Removing the per-claim PDA has three benefits:

1. **Lower cost per claim** — saves ~880 lamports of rent per claim
   that previously went to allocating the per-claim PDA. Over
   thousands of claims this becomes material.
2. **Simpler instruction** — one fewer CPI, one fewer account to
   derive, smaller transaction.
3. **No orphan accounts** — the upgraded contract never creates
   per-claim accounts that would need to be closed later to recover
   rent.

### Idempotency impact

The previous contract enforced on-chain idempotency by deriving the
`claim` PDA from `sha256(claim_id)` — calling `claim_reward` with the
same `claim_id` twice would fail at the second call because the PDA
already existed.

The upgraded contract has **no on-chain idempotency layer**. This is
acceptable because the backend's database layer provides three
independent idempotency guarantees:

1. **Unique constraint** on `reward_claims.claim_id` — prevents two
   rows with the same claim_id from being inserted.
2. **Atomic state transitions** via `mark_reward_claim_pending_payout`
   RPC — `ENTITLED → PENDING_PAYOUT` is atomic and concurrency-safe
   (uses `SELECT ... FOR UPDATE` on both the claim row and the wallet
   row).
3. **Status short-circuits** in `api_routes/rewards/claim.mjs` — if
   the claim is already `COMPLETED`, `PENDING_PAYOUT`, or `FAILED`,
   the handler returns the existing state without re-submitting a
   Solana transaction.

The only theoretical gap is: if a transaction is broadcast but never
confirmed, AND a different backend instance retries the same
`claim_id` while the first is still in mempool, both could land. In
practice the backend is single-instance, and the atomic
`ENTITLED → PENDING_PAYOUT` transition means the second request sees
`PENDING_PAYOUT` and short-circuits. **Acceptable trade-off.**

## What changed in the backend

### `api/_lib/solanaRewardsAdmin.mjs`

#### `buildClaimRewardInstruction` (the only production code change)

The `keys` array now emits exactly four accounts:

```js
const keys = [
  { pubkey: admin, isSigner: true, isWritable: true },
  { pubkey: rewardConfig, isSigner: false, isWritable: true },
  { pubkey: rewardVault, isSigner: false, isWritable: true },
  { pubkey: recipient, isSigner: false, isWritable: true },
]
```

The unused `getClaimPda(claimId, programId)` call inside the builder
was removed. The data layout (discriminator + length-prefixed
`claim_id` UTF-8 + u64 LE `points_claimed` + u64 LE
`reward_amount`) is unchanged — the contract's instruction arguments
were not modified.

#### Untouched (intentionally)

- `getClaimPda`, `hashClaimId` — still exported, still used by
  `scripts/devnet-e2e-claim-test.mjs` and
  `scripts/test_solana_rewards_admin.py` to derive the **legacy** PDA
  for backward-compat inspection. They are no longer called by the
  production claim flow.
- `getRewardConfigPda`, `getRewardVaultPda` — unchanged.
- `submitClaimRewardTx` — unchanged. Still sets
  `tx.feePayer = admin.publicKey` and signs with the admin keypair.
  The admin still pays the transaction fee (~5100 lamports) and the
  priority fee (~100 lamports).
- `solToLamports` — unchanged.
- `getRewardsProgramState` — unchanged. Still reads the 59-byte
  `RewardConfig` account at the same offsets.
- `buildFundVaultInstruction`, `buildWithdrawVaultInstruction`,
  `buildSetPausedInstruction` — unchanged. The upgrade did not
  modify these instructions; their account lists still include the
  System Program where required (e.g. `fund_vault` still needs
  `system_program` because it performs a real
  `system_program::transfer` CPI).

### `api_routes/rewards/claim.mjs`

Not modified. The 9-step claim flow orchestrator is unchanged; it
just calls the upgraded `buildClaimRewardInstruction` underneath.
The pre-flight vault-balance check, the Supabase RPC calls, the
`ENTITLED → PENDING_PAYOUT → COMPLETED` state machine, and the
reconciliation logic (handle ambiguous confirmation, never revert on
timeout) are all unchanged.

### Supabase migrations

No changes required. The DB layer tracks `claim_id`,
`claim_tx_signature`, `wallet_address`, `points_claimed`,
`reward_amount`, and `status`. None of those fields depend on
whether the contract creates a per-claim PDA. Verified: zero
references to per-claim PDAs in any migration file.

### Test scripts

- `scripts/devnet-e2e-claim-test.mjs` — the obsolete PDA-existence
  check was replaced with a `RewardClaimed` event verification. The
  test now scans the transaction's `Program data:` log lines for the
  `event:RewardClaimed` discriminator and decodes the Borsh fields to
  verify `claim_id`, `wallet_address`, `points_claimed`, and
  `reward_amount` match the request. A secondary check confirms the
  legacy PDA derivation is NOT in the transaction's account list —
  proving the upgraded 4-account instruction was used.
- `scripts/test_solana_rewards_admin.py` — `test_instruction_byte_layout`
  was updated to expect exactly 4 accounts and to assert
  `accountCount === 4`. `test_claim_pda_deterministic` was retained
  because `getClaimPda` is still exported for backward-compat
  inspection of legacy PDAs.

## What did NOT change

| Concern | Status |
|---|---|
| Who pays the transaction fee | Admin wallet still pays (custodial payout model) |
| `RewardConfig` account layout | Unchanged (59 bytes, same offsets) |
| `RewardVault` account | Unchanged (still a PDA holding SOL) |
| `fund_vault` instruction | Unchanged (still needs system_program) |
| `withdraw_vault` instruction | Unchanged |
| `set_paused` instruction | Unchanged |
| `update_admin` instruction | Unchanged (not exposed via API; manual on-chain op) |
| `initialize` instruction | Unchanged (one-time setup) |
| Supabase `claim_reward` RPC | Unchanged |
| Supabase `mark_reward_claim_pending_payout` RPC | Unchanged |
| Supabase `revert_failed_reward_claim` RPC | Unchanged |
| Supabase `update_reward_claim_status` RPC | Unchanged |
| Supabase `get_wallet_reward_balance` RPC | Unchanged |
| Supabase `recalculate_reward_totals` RPC | Unchanged |
| Frontend rewards UI | Unchanged |

## Verification

After deploying the upgraded contract, verify the backend works:

1. **Static checks** — `node --check api/_lib/solanaRewardsAdmin.mjs`
   and `npm run build` both pass.
2. **Unit test** — `python3 scripts/test_solana_rewards_admin.py`
   should pass all tests including `test_instruction_byte_layout`
   (which now asserts exactly 4 accounts).
3. **E2E test (devnet)** — `node scripts/devnet-e2e-claim-test.mjs`
   should pass, now verifying the `RewardClaimed` event instead of a
   PDA.
4. **Production claim** — Click CLAIM in the UI. The transaction
   should land with 4 accounts in the instruction and emit a
   `RewardClaimed` event. The user's wallet should receive SOL
   within ~2 seconds; the admin wallet should be debited ~5100
   lamports for the transaction fee.

## Reference transaction

The first successful claim against the upgraded contract is
visible at:

```
https://explorer.solana.com/tx/4KADuhDv3f3SWcqY1Gibz8XBWsZ5dvLJ7nPJwrYGw5vA4Y5iaxSRKkaLv7z6ZqP2ALqmWoiePj6nHodKrzxd8SJs
```

Inspect the instruction's account list — it should contain exactly
4 accounts: admin, reward_config, reward_vault, recipient. No
`claim` PDA, no `system_program`.
