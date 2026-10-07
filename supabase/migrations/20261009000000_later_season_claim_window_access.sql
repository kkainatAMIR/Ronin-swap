create or replace function public.claim_finalized_season_reward(
  p_wallet_address text,
  p_season_id text,
  p_claim_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  identity jsonb;
  canonical_wallet text;
  canonical_row public.wallets;
  allocation public.samurai_season_reward_allocations;
  settings_row public.samurai_admin_settings;
  existing_claim public.reward_claims;
  new_claim public.reward_claims;
begin
  if p_claim_id is null or p_claim_id !~ '^[A-Za-z0-9_-]{8,200}$' then
    raise exception 'INVALID_CLAIM_ID';
  end if;

  identity := public.get_verified_reward_identity(p_wallet_address);
  canonical_wallet := identity->>'solana_wallet';
  if canonical_wallet is null then
    raise exception 'SOLANA_REWARD_IDENTITY_NOT_FOUND';
  end if;

  select * into canonical_row
  from public.wallets
  where wallet_address = canonical_wallet
  for update;
  if not found or canonical_row.flag_status = 'EXCLUDED' then
    raise exception 'WALLET_EXCLUDED';
  end if;

  select * into existing_claim
  from public.reward_claims
  where claim_id = p_claim_id;
  if found then
    if existing_claim.wallet_id <> canonical_row.id
      or existing_claim.season_id <> p_season_id
      or existing_claim.season_reward_allocation_id is null then
      raise exception 'CLAIM_ID_CONFLICT';
    end if;
    return jsonb_build_object('success', true, 'idempotent', true, 'claim', to_jsonb(existing_claim));
  end if;

  select * into settings_row
  from public.samurai_admin_settings
  where id = 'default';
  if not found or not coalesce(settings_row.sol_rewards_enabled, false) then
    raise exception 'REWARDS_DISABLED';
  end if;

  select a.* into allocation
  from public.samurai_season_reward_allocations a
  join public.samurai_seasons s on s.id = a.season_id
  where a.season_id = p_season_id
    and a.wallet_id = canonical_row.id
    and a.allocation_version = s.allocation_version
    and s.reward_pool_status = 'FINALIZED'
  for update of a;
  if not found or allocation.reward_amount <= 0 then
    raise exception 'NO_SEASON_REWARD_ALLOCATION';
  end if;

  if not exists (
    select 1 from public.samurai_seasons s
    where s.id = p_season_id
      and s.reward_pool_status = 'FINALIZED'
      and now() >= s.claim_window_start
      and now() < s.claim_window_end
  ) and not exists (
    select 1
    from public.samurai_seasons original
    join public.samurai_seasons later
      on later.start_at > original.start_at
     and later.reward_pool_status = 'FINALIZED'
     and now() >= later.claim_window_start
     and now() < later.claim_window_end
    where original.id = p_season_id
      and original.reward_pool_status = 'FINALIZED'
  ) then
    raise exception 'SEASON_CLAIM_WINDOW_CLOSED';
  end if;

  if exists (
    select 1 from public.reward_claims rc
    where rc.season_reward_allocation_id = allocation.id
      and rc.status in ('ENTITLED', 'PENDING_PAYOUT', 'COMPLETED')
  ) then
    raise exception 'SEASON_REWARD_ALREADY_CLAIMED';
  end if;

  insert into public.reward_claims (
    wallet_id, wallet_address, claim_id, season_id, season_reward_allocation_id,
    points_claimed, reward_asset, reward_amount, conversion_rate,
    status, metadata
  ) values (
    canonical_row.id, canonical_wallet, p_claim_id, p_season_id, allocation.id,
    allocation.eligible_points, 'SOL', allocation.reward_amount, 1,
    'ENTITLED', jsonb_build_object(
      'flow', 'finalized-season-reward',
      'allocation_id', allocation.id,
      'allocation_version', allocation.allocation_version
    )
  )
  returning * into new_claim;

  return jsonb_build_object(
    'success', true,
    'idempotent', false,
    'claim', to_jsonb(new_claim),
    'allocation', to_jsonb(allocation)
  );
end;
$$;

revoke execute on function public.claim_finalized_season_reward(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_finalized_season_reward(text, text, text) to service_role;

create or replace function public.get_wallet_season_reward(p_wallet_address text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  identity jsonb;
  canonical_wallet text;
  wallet_addresses text[];
  season_rewards jsonb;
  reserved_points numeric;
begin
  identity := public.get_verified_reward_identity(p_wallet_address);
  canonical_wallet := identity->>'solana_wallet';
  select array_agg(address::text)
  into wallet_addresses
  from jsonb_array_elements_text(coalesce(identity->'linked_evm_wallets', '[]'::jsonb)) as linked(address);

  if canonical_wallet is not null then
    wallet_addresses := array_append(coalesce(wallet_addresses, array[]::text[]), canonical_wallet);
  else
    wallet_addresses := array[p_wallet_address];
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'season', jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'reward_pool_status', s.reward_pool_status,
        'reward_pool_amount', s.reward_pool_amount,
        'reward_asset', 'SOL',
        'claim_window_start', s.claim_window_start,
        'claim_window_end', s.claim_window_end,
        'total_eligible_points', s.total_eligible_points,
        'allocation_version', s.allocation_version
      ),
      'allocation', case when a.id is null then null else to_jsonb(a) end,
      'claim', latest.claim,
      'claim_window_open', s.reward_pool_status = 'FINALIZED'
        and (
          (now() >= s.claim_window_start and now() < s.claim_window_end)
          or later_claim.id is not null
        ),
      'claim_window_via', case
        when s.reward_pool_status = 'FINALIZED'
          and now() >= s.claim_window_start and now() < s.claim_window_end
          then jsonb_build_object('id', s.id, 'name', s.name)
        when later_claim.id is not null
          then jsonb_build_object('id', later_claim.id, 'name', later_claim.name)
        else null
      end
    ) order by s.start_at desc
  ), '[]'::jsonb)
  into season_rewards
  from public.samurai_seasons s
  left join public.wallets canonical
    on canonical.wallet_address = canonical_wallet
  left join public.samurai_season_reward_allocations a
    on a.season_id = s.id
   and a.wallet_id = canonical.id
   and a.allocation_version = s.allocation_version
   and s.reward_pool_status = 'FINALIZED'
  left join lateral (
    select later_season.id, later_season.name
    from public.samurai_seasons later_season
    where later_season.start_at > s.start_at
      and later_season.reward_pool_status = 'FINALIZED'
      and now() >= later_season.claim_window_start
      and now() < later_season.claim_window_end
    order by later_season.start_at desc
    limit 1
  ) later_claim on true
  left join lateral (
    select jsonb_build_object(
      'claim_id', rc.claim_id,
      'status', rc.status,
      'reward_amount', rc.reward_amount,
      'reward_asset', rc.reward_asset,
      'claim_tx_signature', rc.claim_tx_signature,
      'created_at', rc.created_at,
      'completed_at', rc.completed_at
    ) as claim
    from public.reward_claims rc
    where rc.season_reward_allocation_id = a.id
    order by rc.created_at desc
    limit 1
  ) latest on true
  where s.reward_pool_status in ('CONFIGURED', 'FINALIZED');

  select coalesce(sum(wpc.points_consumed), 0)
  into reserved_points
  from public.wallet_point_consumption wpc
  join public.wallets w on w.id = wpc.wallet_id
  where wpc.source = 'SEASON_REWARD_RESERVATION'
    and w.wallet_address = any(coalesce(wallet_addresses, array[]::text[]));

  return jsonb_build_object(
    'season_rewards', season_rewards,
    'reserved_points', reserved_points
  );
end;
$$;

revoke execute on function public.get_wallet_season_reward(text) from public, anon, authenticated;
grant execute on function public.get_wallet_season_reward(text) to service_role;
