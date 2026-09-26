-- =====================================================================
-- Fix revert_failed_reward_claim() — must also delete wallet_point_consumption rows
-- =====================================================================
-- BUG
-- ---
-- When a claim is reverted (ENTITLED/PENDING_PAYOUT → FAILED), the
-- revert_failed_reward_claim() RPC:
--   ✅ Decrements wallets.claimed_points (the LEGACY counter)
--   ❌ Does NOT delete the wallet_point_consumption rows for that claim
--
-- In the NEW accounting model (migration 20260926000000_wallet_links.sql),
-- the AUTHORITATIVE consumed-points source is wallet_point_consumption,
-- NOT wallets.claimed_points. So:
--
--   get_wallet_reward_balance computes:
--     consumed_points = SUM(wallet_point_consumption.points_consumed)
--     claimable = earned - consumed
--
--   If wallet_point_consumption rows are NOT deleted on revert,
--   the consumed_points stays high → claimable stays at 0 → the
--   user thinks their points weren't restored.
--
-- THE FIX
-- --------
-- Update revert_failed_reward_claim() to ALSO delete the
-- wallet_point_consumption rows WHERE claim_id = p_claim_id.
--
-- This makes the revert consistent with the new accounting model:
--   - wallets.claimed_points is decremented (legacy counter, for
--     admin tooling that still reads it)
--   - wallet_point_consumption rows are deleted (authoritative
--     ledger — this is what get_wallet_reward_balance + claim_reward
--     actually use)
--
-- After the fix, when a claim is reverted:
--   - claim status → FAILED
--   - wallet_point_consumption rows for that claim_id are deleted
--   - wallets.claimed_points is decremented
--   - get_wallet_reward_balance recomputes: consumed drops →
--     claimable increases → user sees their points restored
--
-- This is a pure PL/pgSQL function definition update — no schema
-- changes, no table changes, no data changes. Idempotent (uses
-- CREATE OR REPLACE FUNCTION). Safe to re-run.
-- =====================================================================

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
  consumption_rows_deleted integer := 0;
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
      'claimed_points_delta', 0,
      'consumption_rows_deleted', 0
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

  -- ===================================================================
  -- THE FIX: delete the wallet_point_consumption rows for this claim.
  -- ===================================================================
  -- In the new accounting model (migration 20260926000000_wallet_links.sql),
  -- wallet_point_consumption is the AUTHORITATIVE consumed-points ledger.
  -- If we don't delete these rows, get_wallet_reward_balance still
  -- sees the consumed points → claimable stays at 0 → user thinks
  -- their points weren't restored.
  --
  -- The rows are safe to delete because:
  --   1. The claim is being marked FAILED — no payout happened.
  --   2. The FIFO distribution rows were only created during
  --      claim_reward's INSERT loop. If the claim is being reverted,
  --      those rows should never have existed.
  --   3. MIGRATION_BACKFILL rows have claim_id = NULL, so they're
  --      NOT affected by `where claim_id = p_claim_id`.
  -- ===================================================================
  delete from public.wallet_point_consumption
    where claim_id = p_claim_id;

  get diagnostics consumption_rows_deleted = row_count;

  -- Defensive: never let claimed_points go below zero.
  new_claimed_points := greatest(wallet_row.claimed_points - claim_row.points_claimed, 0);

  -- Decrement the legacy claimed_points counter (for admin tools
  -- that still read wallets.claimed_points). The AUTHORITATIVE
  -- source is now wallet_point_consumption (which we just deleted
  -- the relevant rows from above).
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
    'new_claimed_points', new_claimed_points,
    'consumption_rows_deleted', consumption_rows_deleted
  );
end;
$$;

revoke execute on function public.revert_failed_reward_claim(text, text) from public, anon, authenticated;
grant execute on function public.revert_failed_reward_claim(text, text) to service_role;
