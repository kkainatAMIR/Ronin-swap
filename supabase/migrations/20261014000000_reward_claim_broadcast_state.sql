alter table public.reward_claims
  add column if not exists broadcast_status text
    check (broadcast_status in ('SIGNED', 'ATTEMPTED', 'ACKNOWLEDGED', 'UNKNOWN', 'REJECTED')),
  add column if not exists broadcast_attempted_at timestamptz,
  add column if not exists broadcast_acknowledged_at timestamptz;

create or replace function public.initialize_reward_claim_broadcast_state()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.claim_tx_signature is null
    and new.claim_tx_signature is not null
    and new.broadcast_status is null then
    new.broadcast_status := 'SIGNED';
  end if;
  return new;
end;
$$;

drop trigger if exists reward_claim_broadcast_state_init on public.reward_claims;
create trigger reward_claim_broadcast_state_init
before update of claim_tx_signature on public.reward_claims
for each row
execute function public.initialize_reward_claim_broadcast_state();

create or replace function public.update_reward_claim_broadcast_state(
  p_claim_id text,
  p_claim_tx_signature text,
  p_broadcast_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claim_row public.reward_claims;
  next_status text;
  reversion_result jsonb;
begin
  if p_claim_id is null or p_claim_id = '' then
    raise exception 'CLAIM_ID_REQUIRED';
  end if;
  if p_claim_tx_signature is null
    or p_claim_tx_signature !~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$' then
    raise exception 'INVALID_CLAIM_SIGNATURE';
  end if;
  if p_broadcast_status not in ('ATTEMPTED', 'ACKNOWLEDGED', 'UNKNOWN', 'REJECTED') then
    raise exception 'INVALID_BROADCAST_STATUS';
  end if;

  select * into claim_row
  from public.reward_claims
  where claim_id = p_claim_id
  for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND';
  end if;
  if claim_row.claim_tx_signature is distinct from p_claim_tx_signature then
    raise exception 'CLAIM_SIGNATURE_CONFLICT';
  end if;
  if p_broadcast_status = 'REJECTED'
    and claim_row.status = 'FAILED'
    and claim_row.broadcast_status = 'REJECTED' then
    return jsonb_build_object(
      'success', true,
      'broadcast_status', claim_row.broadcast_status,
      'broadcast_attempted_at', claim_row.broadcast_attempted_at,
      'broadcast_acknowledged_at', claim_row.broadcast_acknowledged_at,
      'claim_id', claim_row.claim_id,
      'reversion', jsonb_build_object(
        'reverted', false,
        'reason', 'ALREADY_FAILED',
        'claim', to_jsonb(claim_row)
      )
    );
  end if;
  if claim_row.status not in ('PENDING_PAYOUT', 'COMPLETED') then
    raise exception 'INVALID_BROADCAST_TRANSITION';
  end if;

  next_status := coalesce(claim_row.broadcast_status, 'UNKNOWN');
  if p_broadcast_status = 'ATTEMPTED' then
    if next_status not in ('SIGNED', 'ATTEMPTED') then
      raise exception 'INVALID_BROADCAST_TRANSITION';
    end if;
    next_status := 'ATTEMPTED';
  elsif p_broadcast_status = 'ACKNOWLEDGED' then
    if next_status not in ('ATTEMPTED', 'ACKNOWLEDGED') then
      raise exception 'INVALID_BROADCAST_TRANSITION';
    end if;
    next_status := 'ACKNOWLEDGED';
  elsif p_broadcast_status = 'UNKNOWN' then
    if next_status not in ('ATTEMPTED', 'UNKNOWN') then
      raise exception 'INVALID_BROADCAST_TRANSITION';
    end if;
    next_status := 'UNKNOWN';
  elsif p_broadcast_status = 'REJECTED' then
    if next_status not in ('ATTEMPTED', 'REJECTED') then
      raise exception 'INVALID_BROADCAST_TRANSITION';
    end if;
    update public.reward_claims
    set broadcast_status = 'REJECTED',
        broadcast_attempted_at = coalesce(broadcast_attempted_at, now()),
        updated_at = now()
    where id = claim_row.id
    returning * into claim_row;

    reversion_result := public.revert_reward_claim_internal(
      p_claim_id,
      'SOLANA_RPC_REJECTED_BEFORE_BROADCAST',
      p_claim_tx_signature
    );
    return jsonb_build_object(
      'success', true,
      'broadcast_status', claim_row.broadcast_status,
      'broadcast_attempted_at', claim_row.broadcast_attempted_at,
      'broadcast_acknowledged_at', claim_row.broadcast_acknowledged_at,
      'claim_id', claim_row.claim_id,
      'reversion', reversion_result
    );
  end if;

  update public.reward_claims
  set broadcast_status = next_status,
      broadcast_attempted_at = case
        when next_status in ('ATTEMPTED', 'ACKNOWLEDGED', 'UNKNOWN', 'REJECTED')
          then coalesce(broadcast_attempted_at, now())
        else broadcast_attempted_at
      end,
      broadcast_acknowledged_at = case
        when next_status = 'ACKNOWLEDGED'
          then coalesce(broadcast_acknowledged_at, now())
        else broadcast_acknowledged_at
      end,
      updated_at = now()
  where id = claim_row.id
  returning * into claim_row;

  return jsonb_build_object(
    'success', true,
    'broadcast_status', claim_row.broadcast_status,
    'broadcast_attempted_at', claim_row.broadcast_attempted_at,
    'broadcast_acknowledged_at', claim_row.broadcast_acknowledged_at,
    'claim_id', claim_row.claim_id
  );
end;
$$;

revoke execute on function public.update_reward_claim_broadcast_state(text, text, text) from public, anon, authenticated;
grant execute on function public.update_reward_claim_broadcast_state(text, text, text) to service_role;
