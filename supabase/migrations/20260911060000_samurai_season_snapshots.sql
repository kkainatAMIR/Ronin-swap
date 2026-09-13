create or replace function public.get_current_samurai_season()
returns setof public.samurai_seasons
language plpgsql security definer set search_path = public as $$
begin
  update public.samurai_seasons
  set status = 'ENDED', updated_at = now()
  where status = 'ACTIVE' and now() >= end_at;
  return query
    select * from public.samurai_seasons
    where status = 'ACTIVE' and now() >= start_at and now() < end_at
    order by start_at desc limit 1;
end;
$$;

create or replace function public.get_samurai_leaderboard(
  p_period text,
  p_season_id text default null,
  p_page integer default 1,
  p_limit integer default 25
)
returns table (rank bigint, wallet text, verified_volume numeric, samurai_points numeric, qualifying_swaps bigint, total_count bigint)
language sql security definer set search_path = public as $$
  with live_filtered as (
    select sp.wallet_address,
      sum(sp.qualifying_volume_usd) as verified_volume,
      sum(sp.final_points) as samurai_points,
      count(*)::bigint as qualifying_swaps
    from public.samurai_points sp
    join public.swap_transactions st on st.signature = sp.signature
    where sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'
      and not exists (select 1 from public.wallets w where w.wallet_address = sp.wallet_address and w.flag_status = 'EXCLUDED')
      and (p_period = 'all-time'
        or (p_period = 'season' and p_season_id is not null and sp.season_id = p_season_id
          and not exists (select 1 from public.samurai_seasons s where s.id = p_season_id and s.status in ('FROZEN', 'ARCHIVED')))
        or (p_period = 'daily' and st.timestamp >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
        or (p_period = 'weekly' and st.timestamp >= date_trunc('week', now() at time zone 'utc') at time zone 'utc')
        or (p_period = 'monthly' and st.timestamp >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'))
    group by sp.wallet_address
  ), snapshot_filtered as (
    select ss.wallet_address, ss.verified_volume, ss.samurai_points, ss.qualifying_swaps
    from public.samurai_season_leaderboard_snapshots ss
    join public.samurai_seasons s on s.id = ss.season_id
    where p_period = 'season' and p_season_id is not null and ss.season_id = p_season_id and s.status in ('FROZEN', 'ARCHIVED')
  ), filtered as (
    select * from live_filtered
    union all
    select * from snapshot_filtered
  ), ranked as (
    select row_number() over (order by f.samurai_points desc, f.verified_volume desc, f.wallet_address asc) as rank,
      f.wallet_address as wallet, f.verified_volume, f.samurai_points, f.qualifying_swaps, count(*) over () as total_count
    from filtered f
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
    select sp.wallet_address, coalesce(sum(sp.final_points), 0) points, coalesce(sum(sp.qualifying_volume_usd), 0) volume, count(*)::bigint swaps
    from public.samurai_points sp
    where sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'
      and not exists (select 1 from public.wallets w where w.wallet_address = sp.wallet_address and w.flag_status = 'EXCLUDED')
    group by sp.wallet_address
  ), season as (
    select sp.wallet_address, coalesce(sum(sp.final_points), 0) points, coalesce(sum(sp.qualifying_volume_usd), 0) volume, count(*)::bigint swaps
    from public.samurai_points sp
    where p_season_id is not null and sp.season_id = p_season_id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'
      and not exists (select 1 from public.samurai_seasons s where s.id = p_season_id and s.status in ('FROZEN', 'ARCHIVED'))
      and not exists (select 1 from public.wallets w where w.wallet_address = sp.wallet_address and w.flag_status = 'EXCLUDED')
    group by sp.wallet_address
    union all
    select ss.wallet_address, ss.samurai_points, ss.verified_volume, ss.qualifying_swaps
    from public.samurai_season_leaderboard_snapshots ss
    join public.samurai_seasons s on s.id = ss.season_id
    where p_season_id is not null and ss.season_id = p_season_id and s.status in ('FROZEN', 'ARCHIVED')
  ), season_ranked as (
    select s.wallet_address, row_number() over (order by s.points desc, s.volume desc, s.wallet_address asc) current_rank from season s
  ), lifetime_ranked as (
    select l.wallet_address, row_number() over (order by l.points desc, l.volume desc, l.wallet_address asc) current_rank from lifetime l
  )
  select p_wallet, coalesce(l.points, 0), coalesce(l.volume, 0), coalesce(l.swaps, 0), coalesce(s.points, 0), coalesce(s.volume, 0), coalesce(s.swaps, 0),
    case when p_season_id is not null then sr.current_rank else lr.current_rank end
  from (select p_wallet as wallet_address) requested
  left join lifetime l on l.wallet_address = requested.wallet_address
  left join season s on s.wallet_address = requested.wallet_address
  left join season_ranked sr on sr.wallet_address = requested.wallet_address
  left join lifetime_ranked lr on lr.wallet_address = requested.wallet_address;
$$;