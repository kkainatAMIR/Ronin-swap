-- Persist the signed transaction before it is broadcast. This makes
-- cancellation and submission serialize on the same reward_claims row.

create or replace function public.record_reward_claim_submission(
  p_claim_id text,
  p_claim_tx_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claim_row public.reward_claims;
  was_idempotent boolean;
begin
  if p_claim_id is null or p_claim_id = '' then
    raise exception 'CLAIM_ID_REQUIRED';
  end if;
  if p_claim_tx_signature is null
    or p_claim_tx_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$' then
    raise exception 'INVALID_CLAIM_SIGNATURE';
  end if;

  select * into claim_row
  from public.reward_claims
  where claim_id = p_claim_id
  for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND';
  end if;

  if claim_row.claim_tx_signature is not null
    and claim_row.claim_tx_signature <> p_claim_tx_signature then
    raise exception 'CLAIM_SIGNATURE_CONFLICT';
  end if;
  if claim_row.status in ('FAILED', 'CANCELLED') then
    raise exception 'CLAIM_NOT_RESTARTABLE';
  end if;
  if claim_row.status = 'COMPLETED' then
    if claim_row.claim_tx_signature = p_claim_tx_signature then
      return jsonb_build_object('success', true, 'idempotent', true, 'claim', to_jsonb(claim_row));
    end if;
    raise exception 'CLAIM_ALREADY_COMPLETED';
  end if;
  if claim_row.status not in ('ENTITLED', 'PENDING_PAYOUT') then
    raise exception 'INVALID_TRANSITION';
  end if;

  was_idempotent := claim_row.claim_tx_signature = p_claim_tx_signature
    and claim_row.status = 'PENDING_PAYOUT';

  begin
    update public.reward_claims
    set claim_tx_signature = p_claim_tx_signature,
        status = 'PENDING_PAYOUT',
        updated_at = now()
    where id = claim_row.id
    returning * into claim_row;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'CLAIM_SIGNATURE_ALREADY_USED';
  end;

  return jsonb_build_object(
    'success', true,
    'idempotent', was_idempotent,
    'claim', to_jsonb(claim_row)
  );
end;
$$;

revoke execute on function public.record_reward_claim_submission(text, text) from public, anon, authenticated;
grant execute on function public.record_reward_claim_submission(text, text) to service_role;

-- Keep status writes from replacing the signature or making a signed
-- payout claim look safely failed/cancelled.
create or replace function public.update_reward_claim_status(
  p_claim_id text,
  p_status text,
  p_claim_tx_signature text default null,
  p_failure_reason text default null
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
  if p_status not in ('PENDING_PAYOUT', 'COMPLETED', 'FAILED', 'CANCELLED') then
    raise exception 'INVALID_STATUS';
  end if;

  select * into claim_row
  from public.reward_claims
  where claim_id = p_claim_id
  for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND';
  end if;

  if claim_row.claim_tx_signature is not null
    and p_claim_tx_signature is not null
    and claim_row.claim_tx_signature <> p_claim_tx_signature then
    raise exception 'CLAIM_SIGNATURE_CONFLICT';
  end if;
  if claim_row.claim_tx_signature is not null
    and p_status in ('FAILED', 'CANCELLED') then
    raise exception 'CLAIM_OUTCOME_UNCERTAIN';
  end if;
  if p_status in ('FAILED', 'CANCELLED') and p_claim_tx_signature is not null then
    raise exception 'CLAIM_OUTCOME_UNCERTAIN';
  end if;
  if claim_row.status = 'COMPLETED' and p_status = 'COMPLETED' then
    return to_jsonb(claim_row);
  end if;

  update public.reward_claims
  set status = p_status,
      claim_tx_signature = coalesce(p_claim_tx_signature, claim_row.claim_tx_signature),
      failure_reason = case when p_status = 'FAILED' then p_failure_reason else claim_row.failure_reason end,
      completed_at = case when p_status = 'COMPLETED' then now() else claim_row.completed_at end,
      updated_at = now()
  where id = claim_row.id
  returning * into claim_row;

  return to_jsonb(claim_row);
end;
$$;

revoke execute on function public.update_reward_claim_status(text, text, text, text) from public, anon, authenticated;
grant execute on function public.update_reward_claim_status(text, text, text, text) to service_role;

-- Shared implementation. A claim with a persisted signature can only
-- be reverted through the verified-failure RPC with that exact signature.
create or replace function public.revert_reward_claim_internal(
  p_claim_id text,
  p_failure_reason text,
  p_expected_signature text
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

  select * into claim_row
  from public.reward_claims
  where claim_id = p_claim_id
  for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND';
  end if;

  if claim_row.claim_tx_signature is not null
    and claim_row.claim_tx_signature is distinct from p_expected_signature then
    raise exception 'CLAIM_OUTCOME_UNCERTAIN';
  end if;
  if p_expected_signature is not null
    and claim_row.claim_tx_signature is distinct from p_expected_signature then
    raise exception 'CLAIM_SIGNATURE_MISMATCH';
  end if;
  if claim_row.status = 'FAILED' then
    return jsonb_build_object(
      'reverted', false,
      'reason', 'ALREADY_FAILED',
      'claim', to_jsonb(claim_row),
      'claimed_points_delta', 0,
      'consumption_rows_deleted', 0
    );
  end if;
  if claim_row.status = 'COMPLETED' then
    raise exception 'CANNOT_REVERT_COMPLETED';
  end if;
  if claim_row.status not in ('PENDING_PAYOUT', 'ENTITLED') then
    raise exception 'INVALID_REVERSION_STATE';
  end if;

  if claim_row.season_reward_allocation_id is null then
    select * into wallet_row
    from public.wallets
    where id = claim_row.wallet_id
    for update;
    if not found then
      raise exception 'WALLET_NOT_FOUND';
    end if;

    delete from public.wallet_point_consumption where claim_id = p_claim_id;
    get diagnostics consumption_rows_deleted = row_count;

    new_claimed_points := greatest(wallet_row.claimed_points - claim_row.points_claimed, 0);
    update public.wallets
    set claimed_points = new_claimed_points,
        updated_at = now()
    where id = wallet_row.id;
  end if;

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
    'claimed_points_delta', case when claim_row.season_reward_allocation_id is null then -claim_row.points_claimed else 0 end,
    'consumption_rows_deleted', consumption_rows_deleted
  );
end;
$$;

revoke execute on function public.revert_reward_claim_internal(text, text, text) from public, anon, authenticated;

create or replace function public.revert_failed_reward_claim(
  p_claim_id text,
  p_failure_reason text default null
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.revert_reward_claim_internal(p_claim_id, p_failure_reason, null);
$$;

revoke execute on function public.revert_failed_reward_claim(text, text) from public, anon, authenticated;
grant execute on function public.revert_failed_reward_claim(text, text) to service_role;

create or replace function public.cancel_unsubmitted_reward_claim(
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
begin
  if p_claim_id is null or p_claim_id = '' then
    raise exception 'CLAIM_ID_REQUIRED';
  end if;

  select * into claim_row
  from public.reward_claims
  where claim_id = p_claim_id
  for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND';
  end if;
  if claim_row.claim_tx_signature is not null
    or claim_row.status <> 'ENTITLED' then
    raise exception 'CLAIM_OUTCOME_UNCERTAIN';
  end if;

  return public.revert_reward_claim_internal(p_claim_id, p_failure_reason, null);
end;
$$;

revoke execute on function public.cancel_unsubmitted_reward_claim(text, text) from public, anon, authenticated;
grant execute on function public.cancel_unsubmitted_reward_claim(text, text) to service_role;

create or replace function public.revert_verified_failed_reward_claim(
  p_claim_id text,
  p_failure_reason text,
  p_claim_tx_signature text
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.revert_reward_claim_internal(p_claim_id, p_failure_reason, p_claim_tx_signature);
$$;

revoke execute on function public.revert_verified_failed_reward_claim(text, text, text) from public, anon, authenticated;
grant execute on function public.revert_verified_failed_reward_claim(text, text, text) to service_role;
