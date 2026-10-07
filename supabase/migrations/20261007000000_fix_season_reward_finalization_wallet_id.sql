-- Fix finalization against the existing wallets schema: the primary key is
-- wallets.id (not wallets.wallet_id). This replaces the RPC without changing
-- any existing points, allocations, claims, or season snapshots.
create or replace function public.finalize_samurai_season_rewards(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  season_row public.samurai_seasons;
  total_points numeric(30, 6);
  wallet_count bigint;
begin
  select * into season_row
  from public.samurai_seasons
  where id = p_id
  for update;

  if not found then
    raise exception 'SEASON_NOT_FOUND';
  end if;

  if season_row.reward_pool_status = 'FINALIZED' then
    return jsonb_build_object(
      'season_id', season_row.id,
      'reward_pool_status', season_row.reward_pool_status,
      'reward_pool_amount', season_row.reward_pool_amount,
      'total_eligible_points', season_row.total_eligible_points,
      'eligible_wallet_count', season_row.eligible_wallet_count,
      'reward_finalized_at', season_row.reward_finalized_at,
      'idempotent', true
    );
  end if;

  if season_row.reward_pool_status <> 'CONFIGURED' then
    raise exception 'REWARD_POOL_NOT_CONFIGURED';
  end if;

  if season_row.status = 'ACTIVE' and season_row.end_at <= now() then
    update public.samurai_seasons
    set status = 'ENDED', updated_at = now()
    where id = p_id;
    season_row.status := 'ENDED';
  end if;

  if season_row.status not in ('ENDED', 'FROZEN') then
    raise exception 'SEASON_NOT_ENDED';
  end if;

  perform public.refresh_samurai_season_reward_point_reservation(sp.signature)
  from public.samurai_points sp
  where sp.season_id = p_id;

  with season_wallets as (
    select distinct sp.wallet_id
    from public.samurai_points sp
    where sp.season_id = p_id
  ), wallet_identities as (
    select w.id as wallet_id,
      public.get_verified_reward_identity(w.wallet_address)->>'solana_wallet' as solana_wallet
    from season_wallets sw
    join public.wallets w on w.id = sw.wallet_id
  ), eligible_wallet_points as (
    select canonical.id as wallet_id, canonical.wallet_address,
      sum(sp.final_points)::numeric(30, 6) as eligible_points
    from public.samurai_points sp
    join public.swap_transactions st
      on st.signature = sp.signature
     and st.verification_status = 'verified'
    join public.wallets point_wallet
      on point_wallet.id = sp.wallet_id
    join wallet_identities identity
      on identity.wallet_id = point_wallet.id
    join public.wallets canonical
      on canonical.wallet_address = identity.solana_wallet
    where sp.season_id = p_id
      and sp.eligibility_status = 'qualified'
      and coalesce(sp.flag_status, '') <> 'EXCLUDED'
      and coalesce(point_wallet.flag_status, '') <> 'EXCLUDED'
      and coalesce(canonical.flag_status, '') <> 'EXCLUDED'
      and sp.final_points > 0
    group by canonical.id, canonical.wallet_address
  ), totals as (
    select coalesce(sum(eligible_points), 0)::numeric(30, 6) as total_points
    from eligible_wallet_points
  )
  -- Floor each share to a lamport; any remainder stays in the pool.
  insert into public.samurai_season_reward_allocations (
    season_id, wallet_id, wallet_address, eligible_points, total_eligible_points,
    reward_pool_amount, reward_amount, reward_asset
  )
  select p_id, e.wallet_id, e.wallet_address, e.eligible_points, t.total_points,
    season_row.reward_pool_amount,
    floor(season_row.reward_pool_amount * e.eligible_points / nullif(t.total_points, 0) * 1000000000)
      / 1000000000,
    'SOL'
  from eligible_wallet_points e
  cross join totals t
  where t.total_points > 0
  on conflict (season_id, wallet_id) do nothing;

  select coalesce(sum(eligible_points), 0)::numeric(30, 6), count(*)
  into total_points, wallet_count
  from public.samurai_season_reward_allocations
  where season_id = p_id;

  update public.samurai_seasons
  set reward_pool_status = 'FINALIZED',
      total_eligible_points = total_points,
      eligible_wallet_count = wallet_count,
      reward_finalized_at = now(),
      allocation_version = 1,
      updated_at = now()
  where id = p_id
  returning * into season_row;

  return jsonb_build_object(
    'season_id', season_row.id,
    'reward_pool_status', season_row.reward_pool_status,
    'reward_pool_amount', season_row.reward_pool_amount,
    'total_eligible_points', season_row.total_eligible_points,
    'eligible_wallet_count', season_row.eligible_wallet_count,
    'reward_finalized_at', season_row.reward_finalized_at,
    'idempotent', false
  );
end;
$$;

revoke execute on function public.finalize_samurai_season_rewards(text) from public, anon, authenticated;
grant execute on function public.finalize_samurai_season_rewards(text) to service_role;
