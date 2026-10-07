-- Preserve finalized allocation and leaderboard history while allowing an
-- explicitly restarted season to earn again and finalize a new version.
alter table public.samurai_season_reward_allocations
  add column if not exists allocation_version integer not null default 1;

alter table public.samurai_season_reward_allocations
  drop constraint if exists samurai_season_reward_allocations_identity_uidx;

create unique index if not exists samurai_season_reward_allocations_version_uidx
  on public.samurai_season_reward_allocations(season_id, wallet_id, allocation_version);

alter table public.samurai_season_reward_allocations
  add constraint samurai_season_reward_allocations_version_valid
    check (allocation_version > 0);

alter table public.samurai_season_leaderboard_snapshots
  add column if not exists snapshot_version integer not null default 1;

alter table public.samurai_season_leaderboard_snapshots
  drop constraint if exists samurai_season_leaderboard_snapshots_pkey,
  drop constraint if exists samurai_season_leaderboard_snapshots_season_id_rank_key;

create unique index if not exists samurai_season_leaderboard_snapshots_version_wallet_uidx
  on public.samurai_season_leaderboard_snapshots(season_id, wallet_address, snapshot_version);

create unique index if not exists samurai_season_leaderboard_snapshots_version_rank_uidx
  on public.samurai_season_leaderboard_snapshots(season_id, snapshot_version, rank);

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
  new_allocation_version integer;
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

  if season_row.status = 'ACTIVE' and season_row.end_at <= now() then
    update public.samurai_seasons
    set status = 'ENDED', updated_at = now()
    where id = p_id;
    season_row.status := 'ENDED';
  end if;

  if season_row.status not in ('ENDED', 'FROZEN') then
    raise exception 'SEASON_NOT_ENDED';
  end if;

  new_allocation_version := coalesce(nullif(season_row.allocation_version, 0), 1);

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
  insert into public.samurai_season_reward_allocations (
    season_id, wallet_id, wallet_address, eligible_points, total_eligible_points,
    reward_pool_amount, reward_amount, reward_asset, allocation_version
  )
  select p_id, e.wallet_id, e.wallet_address, e.eligible_points, t.total_points,
    season_row.reward_pool_amount,
    floor(season_row.reward_pool_amount * e.eligible_points / nullif(t.total_points, 0) * 1000000000)
      / 1000000000,
    'SOL', new_allocation_version
  from eligible_wallet_points e
  cross join totals t
  where t.total_points > 0
  on conflict (season_id, wallet_id, allocation_version) do nothing;

  select coalesce(sum(eligible_points), 0)::numeric(30, 6), count(*)
  into total_points, wallet_count
  from public.samurai_season_reward_allocations
  where season_id = p_id and allocation_version = new_allocation_version;

  update public.samurai_seasons
  set reward_pool_status = 'FINALIZED',
      total_eligible_points = total_points,
      eligible_wallet_count = wallet_count,
      reward_finalized_at = now(),
      allocation_version = new_allocation_version,
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
    'allocation_version', season_row.allocation_version,
    'idempotent', false
  );
end;
$$;

revoke execute on function public.finalize_samurai_season_rewards(text) from public, anon, authenticated;
grant execute on function public.finalize_samurai_season_rewards(text) to service_role;

create or replace function public.freeze_samurai_season(p_id text)
returns public.samurai_seasons
language plpgsql
security definer
set search_path = public
as $$
declare
  season_row public.samurai_seasons;
  snapshot_version_value integer;
begin
  select * into season_row
  from public.samurai_seasons
  where id = p_id and status = 'ENDED'
  for update;
  if not found then
    raise exception 'SEASON_NOT_FREEZABLE';
  end if;

  snapshot_version_value := coalesce(nullif(season_row.allocation_version, 0), 1);

  insert into public.samurai_season_leaderboard_snapshots (
    season_id, wallet_address, rank, verified_volume, samurai_points, qualifying_swaps, snapshot_version
  )
  with ranked as (
    select sp.wallet_address,
      row_number() over (order by sum(sp.final_points) desc, sum(sp.qualifying_volume_usd) desc, sp.wallet_address asc) as rank,
      sum(sp.qualifying_volume_usd) as verified_volume,
      sum(sp.final_points) as samurai_points,
      count(*)::bigint as qualifying_swaps
    from public.samurai_points sp
    join public.wallets w on w.wallet_address = sp.wallet_address
    where sp.season_id = p_id and sp.eligibility_status = 'qualified'
      and sp.flag_status <> 'EXCLUDED' and w.flag_status <> 'EXCLUDED'
    group by sp.wallet_address
  )
  select p_id, wallet_address, rank, verified_volume, samurai_points, qualifying_swaps, snapshot_version_value
  from ranked;

  update public.samurai_seasons s
  set status = 'FROZEN', frozen_at = now(), updated_at = now(),
    final_wallet_count = coalesce(x.wallet_count, 0),
    final_transaction_count = coalesce(x.transaction_count, 0),
    final_volume = coalesce(x.volume, 0),
    final_points = coalesce(x.points, 0)
  from (
    select count(distinct sp.wallet_address) wallet_count, count(*) transaction_count,
      sum(sp.qualifying_volume_usd) volume, sum(sp.final_points) points
    from public.samurai_points sp
    join public.wallets w on w.wallet_address = sp.wallet_address
    where sp.season_id = p_id and sp.eligibility_status = 'qualified'
      and sp.flag_status <> 'EXCLUDED' and w.flag_status <> 'EXCLUDED'
  ) x
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

create or replace function public.get_samurai_leaderboard(
  p_period text,
  p_season_id text default null,
  p_page integer default 1,
  p_limit integer default 25
)
returns table (rank bigint, wallet text, verified_volume numeric, samurai_points numeric, qualifying_swaps bigint, total_count bigint)
language sql
security definer
set search_path = public
as $$
  with period_swaps as (
    select st.chain_id, st.signature, st.wallet_address, st.timestamp, coalesce(st.volume_usd, 0) as volume_usd
    from public.swap_transactions st
    where st.verification_status = 'verified' and st.status = 'CONFIRMED'
      and (p_period = 'all-time'
        or (p_period = 'daily' and st.timestamp >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
        or (p_period = 'weekly' and st.timestamp >= date_trunc('week', now() at time zone 'utc') at time zone 'utc')
        or (p_period = 'monthly' and st.timestamp >= date_trunc('month', now() at time zone 'utc') at time zone 'utc')
        or (p_period = 'season' and p_season_id is not null and exists (
          select 1 from public.samurai_seasons s
          where s.id = p_season_id and st.timestamp >= s.start_at and st.timestamp < s.end_at
            and s.status not in ('FROZEN', 'ARCHIVED')
        )))
  ), live_wallets as (
    select ps.wallet_address,
      sum(ps.volume_usd) as verified_volume,
      coalesce(sum(case when sp.eligibility_status = 'qualified' then sp.final_points else 0 end), 0) as samurai_points,
      count(*)::bigint as qualifying_swaps
    from period_swaps ps
    left join public.samurai_points sp
      on sp.signature = ps.signature and sp.chain_id = ps.chain_id
      and sp.flag_status <> 'EXCLUDED'
      and (p_period <> 'season' or sp.season_id = p_season_id)
    where not exists (
      select 1 from public.wallets w
      where w.wallet_address = ps.wallet_address and w.flag_status = 'EXCLUDED'
    )
    group by ps.wallet_address
  ), snapshot_wallets as (
    select ss.wallet_address, ss.verified_volume, ss.samurai_points, ss.qualifying_swaps
    from public.samurai_season_leaderboard_snapshots ss
    join public.samurai_seasons s on s.id = ss.season_id
    where p_period = 'season' and ss.season_id = p_season_id
      and ss.snapshot_version = coalesce(nullif(s.allocation_version, 0), 1)
      and s.status in ('FROZEN', 'ARCHIVED')
  ), ranked_wallets as (
    select * from live_wallets
    union all
    select * from snapshot_wallets
  ), ranked as (
    select row_number() over (order by rw.samurai_points desc, rw.verified_volume desc, rw.wallet_address asc) as rank,
      rw.wallet_address as wallet, rw.verified_volume, rw.samurai_points, rw.qualifying_swaps, count(*) over () as total_count
    from ranked_wallets rw
  )
  select r.rank, r.wallet, r.verified_volume, r.samurai_points, r.qualifying_swaps, r.total_count
  from ranked r order by r.rank
  offset greatest(p_page - 1, 0) * least(greatest(p_limit, 1), 100)
  limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.get_samurai_wallet_stats(p_wallet text, p_season_id text default null)
returns table (wallet text, lifetime_points numeric, lifetime_volume numeric, lifetime_swaps bigint, season_points numeric, season_volume numeric, season_swaps bigint, current_rank bigint)
language sql
security definer
set search_path = public
as $$
  with lifetime as (
    select st.wallet_address,
      coalesce(sum(st.volume_usd), 0) volume,
      count(*)::bigint swaps,
      coalesce(sum(case when sp.eligibility_status = 'qualified' then sp.final_points else 0 end), 0) points
    from public.swap_transactions st
    left join public.samurai_points sp
      on sp.signature = st.signature and sp.chain_id = st.chain_id
      and sp.flag_status <> 'EXCLUDED'
    where st.verification_status = 'verified' and st.status = 'CONFIRMED'
      and not exists (
        select 1 from public.wallets w
        where w.wallet_address = st.wallet_address and w.flag_status = 'EXCLUDED'
      )
    group by st.wallet_address
  ), live_season as (
    select st.wallet_address,
      coalesce(sum(st.volume_usd), 0) volume,
      count(*)::bigint swaps,
      coalesce(sum(case when sp.eligibility_status = 'qualified' then sp.final_points else 0 end), 0) points
    from public.swap_transactions st
    left join public.samurai_points sp
      on sp.signature = st.signature and sp.chain_id = st.chain_id
      and sp.flag_status <> 'EXCLUDED'
      and sp.season_id = p_season_id
    join public.samurai_seasons ss
      on p_season_id is not null and ss.id = p_season_id
      and st.timestamp >= ss.start_at and st.timestamp < ss.end_at
    where st.verification_status = 'verified' and st.status = 'CONFIRMED'
      and ss.status not in ('FROZEN', 'ARCHIVED')
      and not exists (
        select 1 from public.wallets w
        where w.wallet_address = st.wallet_address and w.flag_status = 'EXCLUDED'
      )
    group by st.wallet_address
  ), snapshot_season as (
    select ss.wallet_address, ss.verified_volume as volume,
      ss.qualifying_swaps as swaps, ss.samurai_points as points
    from public.samurai_season_leaderboard_snapshots ss
    join public.samurai_seasons s on s.id = ss.season_id
    where ss.season_id = p_season_id
      and ss.snapshot_version = coalesce(nullif(s.allocation_version, 0), 1)
      and s.status in ('FROZEN', 'ARCHIVED')
  ), season as (
    select * from live_season
    union all
    select * from snapshot_season
  ), ranked as (
    select l.wallet_address,
      row_number() over (order by l.points desc, l.volume desc, l.wallet_address asc) current_rank
    from lifetime l
  ), season_ranked as (
    select s.wallet_address,
      row_number() over (order by s.points desc, s.volume desc, s.wallet_address asc) current_rank
    from season s
  )
  select p_wallet,
    coalesce(l.points, 0), coalesce(l.volume, 0), coalesce(l.swaps, 0),
    coalesce(s.points, 0), coalesce(s.volume, 0), coalesce(s.swaps, 0),
    case when p_season_id is not null then sr.current_rank else r.current_rank end
  from (select p_wallet as wallet_address) requested
  left join lifetime l on l.wallet_address = requested.wallet_address
  left join season s on s.wallet_address = requested.wallet_address
  left join ranked r on r.wallet_address = requested.wallet_address
  left join season_ranked sr on sr.wallet_address = requested.wallet_address;
$$;

create or replace function public.restart_finalized_samurai_season(
  p_id text,
  p_new_end_at timestamptz,
  p_claim_window_start timestamptz,
  p_claim_window_end timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  season_row public.samurai_seasons;
  previous_allocation_version integer;
begin
  select * into season_row
  from public.samurai_seasons
  where id = p_id
  for update;

  if not found then
    raise exception 'SEASON_NOT_FOUND';
  end if;

  if season_row.reward_pool_status <> 'FINALIZED'
    or season_row.status not in ('ENDED', 'FROZEN', 'ARCHIVED') then
    raise exception 'SEASON_NOT_RESTARTABLE';
  end if;

  if p_new_end_at is null or p_new_end_at <= now()
    or season_row.start_at > now()
    or p_claim_window_start is null
    or p_claim_window_start < p_new_end_at
    or p_claim_window_end is null
    or p_claim_window_end <= p_claim_window_start then
    raise exception 'INVALID_SEASON_RESTART_DATES';
  end if;

  if exists (
    select 1 from public.samurai_seasons s
    where s.id <> p_id
      and s.status = 'ACTIVE'
  ) then
    raise exception 'ACTIVE_SEASON_EXISTS';
  end if;

  previous_allocation_version := coalesce(season_row.allocation_version, 0);

  perform 1
  from public.samurai_season_reward_allocations a
  where a.season_id = p_id
  for update;

  if exists (
    select 1
    from public.reward_claims rc
    where rc.season_id = p_id
      and rc.status in ('ENTITLED', 'PENDING_PAYOUT', 'COMPLETED')
  ) then
    raise exception 'SEASON_RESTART_CLAIMS_EXIST';
  end if;

  update public.samurai_seasons
  set status = 'ACTIVE',
      end_at = p_new_end_at,
      allocation_version = coalesce(allocation_version, 0) + 1,
      reward_pool_status = 'CONFIGURED',
      claim_window_start = p_claim_window_start,
      claim_window_end = p_claim_window_end,
      reward_finalized_at = null,
      total_eligible_points = null,
      eligible_wallet_count = null,
      updated_at = now()
  where id = p_id
  returning * into season_row;

  perform public.refresh_samurai_season_reward_point_reservation(sp.signature)
  from public.samurai_points sp
  where sp.season_id = p_id;

  return jsonb_build_object(
    'season_id', season_row.id,
    'status', season_row.status,
    'end_at', season_row.end_at,
    'reward_pool_status', season_row.reward_pool_status,
    'allocation_version', season_row.allocation_version,
    'previous_allocation_version', previous_allocation_version
  );
end;
$$;

revoke execute on function public.restart_finalized_samurai_season(text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.restart_finalized_samurai_season(text, timestamptz, timestamptz, timestamptz) to service_role;

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
    'ENTITLED', jsonb_build_object('flow', 'finalized-season-reward', 'allocation_id', allocation.id,
      'allocation_version', allocation.allocation_version)
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
        and now() >= s.claim_window_start and now() < s.claim_window_end
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
