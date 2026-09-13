create or replace function public.get_samurai_leaderboard(
  p_period text,
  p_season_id text default null,
  p_page integer default 1,
  p_limit integer default 25
)
returns table (rank bigint, wallet text, verified_volume numeric, samurai_points numeric, qualifying_swaps bigint, total_count bigint)
language sql security definer set search_path = public as $$
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
    left join public.samurai_points sp on sp.signature = ps.signature and sp.chain_id = ps.chain_id and sp.flag_status <> 'EXCLUDED'
    where not exists (select 1 from public.wallets w where w.wallet_address = ps.wallet_address and w.flag_status = 'EXCLUDED')
    group by ps.wallet_address
  ), ranked as (
    select row_number() over (order by lw.samurai_points desc, lw.verified_volume desc, lw.wallet_address asc) as rank,
      lw.wallet_address as wallet, lw.verified_volume, lw.samurai_points, lw.qualifying_swaps, count(*) over () as total_count
    from live_wallets lw
  )
  select r.rank, r.wallet, r.verified_volume, r.samurai_points, r.qualifying_swaps, r.total_count
  from ranked r order by r.rank
  offset greatest(p_page - 1, 0) * least(greatest(p_limit, 1), 100)
  limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.get_samurai_wallet_stats(p_wallet text, p_season_id text default null)
returns table (wallet text, lifetime_points numeric, lifetime_volume numeric, lifetime_swaps bigint, season_points numeric, season_volume numeric, season_swaps bigint, current_rank bigint)
language sql security definer set search_path = public as $$
  with lifetime as (
    select st.wallet_address,
      coalesce(sum(st.volume_usd), 0) volume,
      count(*)::bigint swaps,
      coalesce(sum(case when sp.eligibility_status = 'qualified' then sp.final_points else 0 end), 0) points
    from public.swap_transactions st
    left join public.samurai_points sp on sp.signature = st.signature and sp.chain_id = st.chain_id and sp.flag_status <> 'EXCLUDED'
    where st.verification_status = 'verified' and st.status = 'CONFIRMED'
      and not exists (select 1 from public.wallets w where w.wallet_address = st.wallet_address and w.flag_status = 'EXCLUDED')
    group by st.wallet_address
  ), season as (
    select st.wallet_address,
      coalesce(sum(st.volume_usd), 0) volume,
      count(*)::bigint swaps,
      coalesce(sum(case when sp.eligibility_status = 'qualified' then sp.final_points else 0 end), 0) points
    from public.swap_transactions st
    left join public.samurai_points sp on sp.signature = st.signature and sp.chain_id = st.chain_id and sp.flag_status <> 'EXCLUDED'
    join public.samurai_seasons ss on p_season_id is not null and ss.id = p_season_id and st.timestamp >= ss.start_at and st.timestamp < ss.end_at
    where st.verification_status = 'verified' and st.status = 'CONFIRMED'
      and ss.status not in ('FROZEN', 'ARCHIVED')
      and not exists (select 1 from public.wallets w where w.wallet_address = st.wallet_address and w.flag_status = 'EXCLUDED')
    group by st.wallet_address
  ), ranked as (
    select l.wallet_address, row_number() over (order by l.points desc, l.volume desc, l.wallet_address asc) current_rank from lifetime l
  ), season_ranked as (
    select s.wallet_address, row_number() over (order by s.points desc, s.volume desc, s.wallet_address asc) current_rank from season s
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
