create or replace function public.get_samurai_leaderboard(
  p_period text,
  p_season_id text default null,
  p_page integer default 1,
  p_limit integer default 25
)
returns table (
  rank bigint,
  wallet text,
  verified_volume numeric,
  samurai_points numeric,
  qualifying_swaps bigint,
  total_count bigint
)
language sql
security definer
set search_path = public
as $$
  with period_swaps as (
    select
      st.chain_id,
      st.signature,
      st.wallet_address,
      st.timestamp,
      coalesce(st.volume_usd, 0) as volume_usd
    from public.swap_transactions st
    where st.verification_status = 'verified'
      and st.status = 'CONFIRMED'
      and (
        p_period = 'all-time'
        or (p_period = 'daily' and st.timestamp >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
        or (p_period = 'weekly' and st.timestamp >= date_trunc('week', now() at time zone 'utc') at time zone 'utc')
        or (p_period = 'monthly' and st.timestamp >= date_trunc('month', now() at time zone 'utc') at time zone 'utc')
        or (
          p_period = 'season'
          and p_season_id is not null
          and exists (
            select 1
            from public.samurai_seasons s
            where s.id = p_season_id
              and st.timestamp >= s.start_at
              and st.timestamp < s.end_at
              and s.status not in ('FROZEN', 'ARCHIVED')
          )
        )
      )
  ), live_wallets_by_address as (
    select
      ps.wallet_address,
      sum(ps.volume_usd) as verified_volume,
      coalesce(sum(case when sp.eligibility_status = 'qualified' then sp.final_points else 0 end), 0) as samurai_points,
      count(*)::bigint as qualifying_swaps
    from period_swaps ps
    left join public.samurai_points sp
      on sp.signature = ps.signature
      and sp.chain_id = ps.chain_id
      and sp.flag_status <> 'EXCLUDED'
      and (p_period <> 'season' or sp.season_id = p_season_id)
    where not exists (
      select 1
      from public.wallets w
      where w.wallet_address = ps.wallet_address
        and w.flag_status = 'EXCLUDED'
    )
    group by ps.wallet_address
  ), live_wallets as (
    select
      coalesce(identity.result->>'solana_wallet', raw.wallet_address) as wallet_address,
      sum(raw.verified_volume) as verified_volume,
      sum(raw.samurai_points) as samurai_points,
      sum(raw.qualifying_swaps)::bigint as qualifying_swaps
    from live_wallets_by_address raw
    cross join lateral (
      select public.get_verified_reward_identity(raw.wallet_address) as result
    ) identity
    group by coalesce(identity.result->>'solana_wallet', raw.wallet_address)
  ), snapshot_wallets as (
    select
      ss.wallet_address,
      ss.verified_volume,
      ss.samurai_points,
      ss.qualifying_swaps
    from public.samurai_season_leaderboard_snapshots ss
    join public.samurai_seasons s on s.id = ss.season_id
    where p_period = 'season'
      and ss.season_id = p_season_id
      and ss.snapshot_version = coalesce(nullif(s.allocation_version, 0), 1)
      and s.status in ('FROZEN', 'ARCHIVED')
  ), ranked_wallets as (
    select * from live_wallets
    union all
    select * from snapshot_wallets
  ), ranked as (
    select
      row_number() over (
        order by rw.samurai_points desc, rw.verified_volume desc, rw.wallet_address asc
      ) as rank,
      rw.wallet_address as wallet,
      rw.verified_volume,
      rw.samurai_points,
      rw.qualifying_swaps,
      count(*) over () as total_count
    from ranked_wallets rw
  )
  select
    r.rank,
    r.wallet,
    r.verified_volume,
    r.samurai_points,
    r.qualifying_swaps,
    r.total_count
  from ranked r
  order by r.rank
  offset greatest(p_page - 1, 0) * least(greatest(p_limit, 1), 100)
  limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.get_samurai_wallet_stats(
  p_wallet text,
  p_season_id text default null
)
returns table (
  wallet text,
  lifetime_points numeric,
  lifetime_volume numeric,
  lifetime_swaps bigint,
  season_points numeric,
  season_volume numeric,
  season_swaps bigint,
  current_rank bigint
)
language sql
security definer
set search_path = public
as $$
  with lifetime as (
    select
      st.wallet_address,
      coalesce(sum(st.volume_usd), 0) as volume,
      count(*)::bigint as swaps,
      coalesce(sum(case when sp.eligibility_status = 'qualified' then sp.final_points else 0 end), 0) as points
    from public.swap_transactions st
    left join public.samurai_points sp
      on sp.signature = st.signature
      and sp.chain_id = st.chain_id
      and sp.flag_status <> 'EXCLUDED'
    where st.verification_status = 'verified'
      and st.status = 'CONFIRMED'
      and not exists (
        select 1
        from public.wallets w
        where w.wallet_address = st.wallet_address
          and w.flag_status = 'EXCLUDED'
      )
    group by st.wallet_address
  ), live_season_by_address as (
    select
      st.wallet_address,
      coalesce(sum(st.volume_usd), 0) as volume,
      count(*)::bigint as swaps,
      coalesce(sum(case when sp.eligibility_status = 'qualified' then sp.final_points else 0 end), 0) as points
    from public.swap_transactions st
    left join public.samurai_points sp
      on sp.signature = st.signature
      and sp.chain_id = st.chain_id
      and sp.flag_status <> 'EXCLUDED'
      and sp.season_id = p_season_id
    join public.samurai_seasons ss
      on p_season_id is not null
      and ss.id = p_season_id
      and st.timestamp >= ss.start_at
      and st.timestamp < ss.end_at
    where st.verification_status = 'verified'
      and st.status = 'CONFIRMED'
      and ss.status not in ('FROZEN', 'ARCHIVED')
      and not exists (
        select 1
        from public.wallets w
        where w.wallet_address = st.wallet_address
          and w.flag_status = 'EXCLUDED'
      )
    group by st.wallet_address
  ), live_season as (
    select
      coalesce(identity.result->>'solana_wallet', raw.wallet_address) as wallet_address,
      sum(raw.volume) as volume,
      sum(raw.swaps)::bigint as swaps,
      sum(raw.points) as points
    from live_season_by_address raw
    cross join lateral (
      select public.get_verified_reward_identity(raw.wallet_address) as result
    ) identity
    group by coalesce(identity.result->>'solana_wallet', raw.wallet_address)
  ), snapshot_season as (
    select
      ss.wallet_address,
      ss.verified_volume as volume,
      ss.qualifying_swaps as swaps,
      ss.samurai_points as points
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
    select
      l.wallet_address,
      row_number() over (order by l.points desc, l.volume desc, l.wallet_address asc) as current_rank
    from lifetime l
  ), season_ranked as (
    select
      s.wallet_address,
      row_number() over (order by s.points desc, s.volume desc, s.wallet_address asc) as current_rank
    from season s
  ), requested as (
    select
      p_wallet as wallet_address,
      coalesce(identity.result->>'solana_wallet', p_wallet) as season_wallet
    from (
      select public.get_verified_reward_identity(p_wallet) as result
    ) identity
  )
  select
    p_wallet,
    coalesce(l.points, 0),
    coalesce(l.volume, 0),
    coalesce(l.swaps, 0),
    coalesce(s.points, 0),
    coalesce(s.volume, 0),
    coalesce(s.swaps, 0),
    case when p_season_id is not null then sr.current_rank else r.current_rank end
  from requested
  left join lifetime l on l.wallet_address = requested.wallet_address
  left join season s on s.wallet_address = requested.season_wallet
  left join ranked r on r.wallet_address = requested.wallet_address
  left join season_ranked sr on sr.wallet_address = requested.season_wallet;
$$;
