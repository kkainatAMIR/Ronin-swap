alter table public.samurai_season_leaderboard_snapshots
  add column if not exists canonical_wallet_id uuid references public.wallets(id),
  add column if not exists eligible_points numeric(30, 6),
  add column if not exists total_eligible_points numeric(30, 6),
  add column if not exists snapshot_at timestamptz;

update public.samurai_season_leaderboard_snapshots
set eligible_points = coalesce(eligible_points, samurai_points),
    snapshot_at = coalesce(snapshot_at, created_at);

with totals as (
  select season_id, snapshot_version, sum(eligible_points)::numeric(30, 6) as total_points
  from public.samurai_season_leaderboard_snapshots
  group by season_id, snapshot_version
)
update public.samurai_season_leaderboard_snapshots snapshot
set total_eligible_points = coalesce(snapshot.total_eligible_points, totals.total_points)
from totals
where totals.season_id = snapshot.season_id
  and totals.snapshot_version = snapshot.snapshot_version;

alter table public.samurai_season_leaderboard_snapshots
  alter column eligible_points set default 0,
  alter column eligible_points set not null,
  alter column total_eligible_points set default 0,
  alter column total_eligible_points set not null,
  alter column snapshot_at set default now(),
  alter column snapshot_at set not null;

create unique index if not exists samurai_season_snapshot_canonical_wallet_version_uidx
  on public.samurai_season_leaderboard_snapshots(season_id, canonical_wallet_id, snapshot_version)
  where canonical_wallet_id is not null;

create or replace function public.freeze_samurai_season(p_id text)
returns public.samurai_seasons
language plpgsql
security definer
set search_path = public
as $$
declare
  season_row public.samurai_seasons;
  snapshot_version_value integer;
  snapshot_timestamp timestamptz;
begin
  select * into season_row
  from public.samurai_seasons
  where id = p_id
  for update;

  if not found then
    raise exception 'SEASON_NOT_FREEZABLE';
  end if;

  if season_row.status in ('FROZEN', 'ARCHIVED') and season_row.frozen_at is not null then
    return season_row;
  end if;

  if season_row.status <> 'ENDED' then
    raise exception 'SEASON_NOT_FREEZABLE';
  end if;

  snapshot_version_value := coalesce(nullif(season_row.allocation_version, 0), 1);
  snapshot_timestamp := clock_timestamp();

  with point_wallets as (
    select distinct
      point_wallet.id as wallet_id,
      point_wallet.wallet_address,
      point_wallet.flag_status
    from public.samurai_points sp
    join public.wallets point_wallet on point_wallet.id = sp.wallet_id
    where sp.season_id = p_id
  ), reward_identities as (
    select
      point_wallets.wallet_id,
      point_wallets.flag_status,
      identity->>'solana_wallet' as canonical_wallet
    from point_wallets
    cross join lateral public.get_verified_reward_identity(point_wallets.wallet_address) identity
  ), eligible_wallet_points as (
    select
      canonical.id as canonical_wallet_id,
      canonical.wallet_address as canonical_wallet,
      sum(sp.qualifying_volume_usd)::numeric(30, 6) as verified_volume,
      sum(sp.final_points)::numeric(30, 6) as eligible_points,
      count(*)::bigint as qualifying_swaps
    from public.samurai_points sp
    join public.swap_transactions st
      on st.signature = sp.signature
     and st.verification_status = 'verified'
    join public.wallets point_wallet
      on point_wallet.id = sp.wallet_id
    join reward_identities identity
      on identity.wallet_id = point_wallet.id
    join public.wallets canonical
      on canonical.wallet_address = identity.canonical_wallet
    where sp.season_id = p_id
      and sp.eligibility_status = 'qualified'
      and coalesce(sp.flag_status, '') <> 'EXCLUDED'
      and coalesce(point_wallet.flag_status, '') <> 'EXCLUDED'
      and coalesce(identity.flag_status, '') <> 'EXCLUDED'
      and coalesce(canonical.flag_status, '') <> 'EXCLUDED'
      and sp.final_points > 0
    group by canonical.id, canonical.wallet_address
  ), ranked as (
    select
      canonical_wallet_id,
      canonical_wallet,
      row_number() over (
        order by eligible_points desc, verified_volume desc, canonical_wallet asc
      ) as rank,
      verified_volume,
      eligible_points,
      qualifying_swaps,
      sum(eligible_points) over ()::numeric(30, 6) as total_eligible_points
    from eligible_wallet_points
  )
  insert into public.samurai_season_leaderboard_snapshots (
    season_id,
    wallet_address,
    rank,
    verified_volume,
    samurai_points,
    qualifying_swaps,
    snapshot_version,
    canonical_wallet_id,
    eligible_points,
    total_eligible_points,
    snapshot_at
  )
  select
    p_id,
    canonical_wallet,
    rank,
    verified_volume,
    eligible_points,
    qualifying_swaps,
    snapshot_version_value,
    canonical_wallet_id,
    eligible_points,
    total_eligible_points,
    snapshot_timestamp
  from ranked;

  update public.samurai_seasons s
  set status = 'FROZEN',
      frozen_at = snapshot_timestamp,
      final_wallet_count = snapshot.wallet_count,
      final_transaction_count = snapshot.transaction_count,
      final_volume = snapshot.verified_volume,
      final_points = snapshot.total_eligible_points,
      updated_at = now()
  from (
    select
      count(*)::bigint as wallet_count,
      coalesce(sum(ss.qualifying_swaps), 0)::bigint as transaction_count,
      coalesce(sum(ss.verified_volume), 0)::numeric(30, 6) as verified_volume,
      coalesce(sum(ss.eligible_points), 0)::numeric(30, 6) as total_eligible_points
    from public.samurai_season_leaderboard_snapshots ss
    where ss.season_id = p_id
      and ss.snapshot_version = snapshot_version_value
  ) snapshot
  where s.id = p_id and s.status = 'ENDED'
  returning s.* into season_row;

  if not found then
    raise exception 'SEASON_NOT_FREEZABLE';
  end if;

  return season_row;
end;
$$;

revoke execute on function public.freeze_samurai_season(text) from public, anon, authenticated;
grant execute on function public.freeze_samurai_season(text) to service_role;

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
  allocation_version_value integer;
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
      'allocation_version', season_row.allocation_version,
      'idempotent', true
    );
  end if;

  if season_row.reward_pool_status <> 'CONFIGURED' then
    raise exception 'REWARD_POOL_NOT_CONFIGURED';
  end if;

  if season_row.status <> 'FROZEN' or season_row.frozen_at is null then
    raise exception 'SEASON_NOT_FROZEN';
  end if;

  allocation_version_value := coalesce(nullif(season_row.allocation_version, 0), 1);

  if exists (
    select 1
    from public.samurai_season_leaderboard_snapshots ss
    where ss.season_id = p_id
      and ss.snapshot_version = allocation_version_value
      and (ss.canonical_wallet_id is null or ss.snapshot_at is null)
  ) then
    raise exception 'SEASON_SNAPSHOT_IDENTITY_INCOMPLETE';
  end if;

  select coalesce(sum(ss.eligible_points), 0)::numeric(30, 6)
  into total_points
  from public.samurai_season_leaderboard_snapshots ss
  where ss.season_id = p_id
    and ss.snapshot_version = allocation_version_value;

  if total_points is distinct from coalesce(season_row.final_points, 0)::numeric(30, 6) then
    raise exception 'SEASON_SNAPSHOT_TOTAL_MISMATCH';
  end if;

  insert into public.samurai_season_reward_allocations (
    season_id,
    wallet_id,
    wallet_address,
    eligible_points,
    total_eligible_points,
    reward_pool_amount,
    reward_amount,
    reward_asset,
    allocation_version
  )
  select
    p_id,
    ss.canonical_wallet_id,
    ss.wallet_address,
    ss.eligible_points,
    total_points,
    season_row.reward_pool_amount,
    floor(
      season_row.reward_pool_amount * ss.eligible_points
      / nullif(total_points, 0) * 1000000000
    ) / 1000000000,
    'SOL',
    allocation_version_value
  from public.samurai_season_leaderboard_snapshots ss
  where ss.season_id = p_id
    and ss.snapshot_version = allocation_version_value
    and total_points > 0
  on conflict (season_id, wallet_id, allocation_version) do nothing;

  select
    coalesce(sum(a.eligible_points), 0)::numeric(30, 6),
    count(*)::bigint
  into total_points, wallet_count
  from public.samurai_season_reward_allocations a
  where a.season_id = p_id
    and a.allocation_version = allocation_version_value;

  if total_points is distinct from coalesce(season_row.final_points, 0)::numeric(30, 6) then
    raise exception 'SEASON_ALLOCATION_TOTAL_MISMATCH';
  end if;

  update public.samurai_seasons
  set reward_pool_status = 'FINALIZED',
      total_eligible_points = total_points,
      eligible_wallet_count = wallet_count,
      reward_finalized_at = now(),
      allocation_version = allocation_version_value,
      updated_at = now()
  where id = p_id
    and status = 'FROZEN'
    and reward_pool_status = 'CONFIGURED'
  returning * into season_row;

  if not found then
    raise exception 'SEASON_FINALIZATION_CONFLICT';
  end if;

  return jsonb_build_object(
    'season_id', season_row.id,
    'reward_pool_status', season_row.reward_pool_status,
    'reward_pool_amount', season_row.reward_pool_amount,
    'total_eligible_points', season_row.total_eligible_points,
    'eligible_wallet_count', season_row.eligible_wallet_count,
    'reward_finalized_at', season_row.reward_finalized_at,
    'allocation_version', season_row.allocation_version,
    'idempotent', false
  );
end;
$$;

revoke execute on function public.finalize_samurai_season_rewards(text) from public, anon, authenticated;
grant execute on function public.finalize_samurai_season_rewards(text) to service_role;
