-- =====================================================================
-- Reward Payout Integration: Safe state-transition RPCs
-- =====================================================================
-- This migration adds two small RPCs needed for safe integration with
-- the deployed Solana Rewards Program (FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU).
--
-- Why we need these:
--   The existing public.claim_reward() RPC inserts the reward_claims
--   row with status = 'ENTITLED' and increments wallets.claimed_points
--   in the same transaction. After that, the backend calls the Solana
--   program to perform the actual SOL transfer. The on-chain call can
--   succeed or fail. The existing public.update_reward_claim_status()
--   RPC can set status to PENDING_PAYOUT / COMPLETED / FAILED / CANCELLED,
--   but it does NOT touch wallets.claimed_points.
--
--   That's a problem when the Solana payout FAILS:
--     - The wallet's claimed_points was already incremented at ENTITLED time.
--     - Without a rollback, the user permanently loses claimable_points
--       even though they never received any SOL.
--
--   This migration adds:
--     1. mark_reward_claim_pending_payout(claim_id, expected_entitled)
--        Atomically transitions ENTITLED → PENDING_PAYOUT. Used right
--        before the backend submits the Solana transaction. Returns the
--        updated row. If the claim is already COMPLETED, returns it
--        idempotently (so a retry of the entire flow is safe).
--     2. revert_failed_reward_claim(claim_id, failure_reason)
--        Atomically transitions PENDING_PAYOUT → FAILED AND decrements
--        wallets.claimed_points by the exact points_claimed amount,
--        restoring the user's claimable_points. Uses SELECT FOR UPDATE
--        on both the claim row and the wallet row for concurrency safety.
--        Idempotent on already-FAILED rows (no double-decrement).
--
--   Both RPCs are SECURITY DEFINER and restricted to service_role, so
--   only the backend can invoke them.
--
--   The existing update_reward_claim_status() RPC remains unchanged for
--   marking COMPLETED after a verified Solana transaction.
-- =====================================================================

-- ---------------------------------------------------------------------
-- mark_reward_claim_pending_payout
-- ---------------------------------------------------------------------
-- Atomically transition a claim from ENTITLED → PENDING_PAYOUT.
-- Used by the backend immediately BEFORE submitting the Solana
-- claim_reward() transaction.
--
-- If the claim is already COMPLETED: returns the existing row idempotently
--   (a retry of the entire flow should not re-submit a payout).
-- If the claim is PENDING_PAYOUT: returns it unchanged (the backend should
--   continue to confirm the existing Solana transaction rather than
--   submit a new one).
-- If the claim is FAILED or CANCELLED: raises an error.
-- If the claim is ENTITLED: transitions to PENDING_PAYOUT.
-- ---------------------------------------------------------------------
create or replace function public.mark_reward_claim_pending_payout(
  p_claim_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claim_row public.reward_claims;
begin
  if p_claim_id is null or p_claim_id = '' then
    raise exception 'CLAIM_ID_REQUIRED';
  end if;

  select * into claim_row from public.reward_claims
    where claim_id = p_claim_id
    for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND';
  end if;

  -- Idempotent: already completed (e.g. retry of whole flow) → return as-is.
  if claim_row.status = 'COMPLETED' then
    return jsonb_build_object(
      'transitioned', false,
      'reason', 'ALREADY_COMPLETED',
      'claim', to_jsonb(claim_row)
    );
  end if;

  -- Idempotent: already pending (e.g. retry of whole flow) → return as-is.
  if claim_row.status = 'PENDING_PAYOUT' then
    return jsonb_build_object(
      'transitioned', false,
      'reason', 'ALREADY_PENDING',
      'claim', to_jsonb(claim_row)
    );
  end if;

  -- Cannot transition out of FAILED / CANCELLED without admin intervention.
  if claim_row.status in ('FAILED', 'CANCELLED') then
    raise exception 'CLAIM_NOT_RESTARTABLE';
  end if;

  -- Only ENTITLED → PENDING_PAYOUT is allowed here.
  if claim_row.status <> 'ENTITLED' then
    raise exception 'INVALID_TRANSITION';
  end if;

  update public.reward_claims
    set status = 'PENDING_PAYOUT',
        updated_at = now()
    where id = claim_row.id
    returning * into claim_row;

  return jsonb_build_object(
    'transitioned', true,
    'reason', 'ENTITLED_TO_PENDING_PAYOUT',
    'claim', to_jsonb(claim_row)
  );
end;
$$;

revoke execute on function public.mark_reward_claim_pending_payout(text) from public, anon, authenticated;
grant execute on function public.mark_reward_claim_pending_payout(text) to service_role;

-- ---------------------------------------------------------------------
-- revert_failed_reward_claim
-- ---------------------------------------------------------------------
-- Atomically transition a claim from PENDING_PAYOUT → FAILED AND
-- decrement wallets.claimed_points by the exact points_claimed amount,
-- restoring the user's claimable_points.
--
-- Used by the backend when the Solana claim_reward() transaction fails
-- or cannot be confirmed.
--
-- Idempotent: if the claim is already FAILED, returns the existing row
--   unchanged (no double-decrement).
-- If the claim is COMPLETED, raises an error (the payout succeeded;
--   admin must use a separate admin path if a reversal is needed).
-- If the claim is ENTITLED, this RPC is the wrong tool — just delete
--   the row or set CANCELLED manually.
--
-- Locks both reward_claims and wallets rows for the duration of the
-- transaction to prevent races with concurrent claims on the same wallet.
-- ---------------------------------------------------------------------
create or replace function public.revert_failed_reward_claim(
  p_claim_id text,
  p_failure_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claim_row public.reward_claims;
  wallet_row public.wallets;
  new_claimed_points numeric;
begin
  if p_claim_id is null or p_claim_id = '' then
    raise exception 'CLAIM_ID_REQUIRED';
  end if;

  -- Lock the claim row.
  select * into claim_row from public.reward_claims
    where claim_id = p_claim_id
    for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND';
  end if;

  -- Idempotent: already FAILED → no-op.
  if claim_row.status = 'FAILED' then
    return jsonb_build_object(
      'reverted', false,
      'reason', 'ALREADY_FAILED',
      'claim', to_jsonb(claim_row),
      'claimed_points_delta', 0
    );
  end if;

  -- If the claim is COMPLETED, the payout DID happen on-chain — admin
  -- must NOT silently roll back the accounting.
  if claim_row.status = 'COMPLETED' then
    raise exception 'CANNOT_REVERT_COMPLETED';
  end if;

  -- Only allow reverting PENDING_PAYOUT (the normal failure path) or
  -- ENTITLED (defensive — if the backend fails before even submitting).
  if claim_row.status not in ('PENDING_PAYOUT', 'ENTITLED') then
    raise exception 'INVALID_REVERSION_STATE';
  end if;

  -- Lock the wallet row to safely decrement claimed_points.
  select * into wallet_row from public.wallets
    where id = claim_row.wallet_id
    for update;
  if not found then
    raise exception 'WALLET_NOT_FOUND';
  end if;

  -- Defensive: never let claimed_points go below zero.
  new_claimed_points := greatest(wallet_row.claimed_points - claim_row.points_claimed, 0);

  update public.wallets
    set claimed_points = new_claimed_points,
        updated_at = now()
    where id = wallet_row.id;

  update public.reward_claims
    set status = 'FAILED',
        failure_reason = p_failure_reason,
        updated_at = now()
    where id = claim_row.id
    returning * into claim_row;

  return jsonb_build_object(
    'reverted', true,
    'reason', 'PENDING_PAYOUT_TO_FAILED',
    'claim', to_jsonb(claim_row),
    'claimed_points_delta', -claim_row.points_claimed,
    'new_claimed_points', new_claimed_points
  );
end;
$$;

revoke execute on function public.revert_failed_reward_claim(text, text) from public, anon, authenticated;
grant execute on function public.revert_failed_reward_claim(text, text) to service_role;
