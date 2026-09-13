alter table public.wallets add column if not exists flag_status text not null default 'NORMAL';
alter table public.samurai_points add column if not exists flag_status text not null default 'NORMAL';

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
  with bounds as (
    select case p_period
      when 'daily' then date_trunc('day', now() at time zone 'utc') at time zone 'utc'
      when 'weekly' then date_trunc('week', now() at time zone 'utc') at time zone 'utc'
      when 'monthly' then date_trunc('month', now() at time zone 'utc') at time zone 'utc'
      else null
    end as starts_at
  ), filtered as (
    select sp.wallet_address,
      sum(sp.qualifying_volume_usd) as verified_volume,
      sum(sp.final_points) as samurai_points,
      count(*) filter (where sp.eligibility_status = 'qualified')::bigint as qualifying_swaps
    from public.samurai_points sp
    join public.swap_transactions st on st.signature = sp.signature
    cross join bounds b
    where sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'
      and not exists (select 1 from public.wallets w where w.wallet_address = sp.wallet_address and w.flag_status = 'EXCLUDED')
      and (p_period = 'all-time' or (p_period = 'season' and p_season_id is not null and sp.season_id = p_season_id)
        or (p_period in ('daily', 'weekly', 'monthly') and st.timestamp >= b.starts_at))
    group by sp.wallet_address
  ), ranked as (
    select row_number() over (order by f.samurai_points desc, f.verified_volume desc, f.wallet_address asc) as rank,
      f.wallet_address as wallet, f.verified_volume, f.samurai_points, f.qualifying_swaps,
      count(*) over () as total_count
    from filtered f
  )
  select r.rank, r.wallet, r.verified_volume, r.samurai_points, r.qualifying_swaps, r.total_count
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
    select sp.wallet_address,
      coalesce(sum(sp.final_points), 0) as points,
      coalesce(sum(sp.qualifying_volume_usd), 0) as volume,
      count(*)::bigint as swaps
    from public.samurai_points sp
    where sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'
      and not exists (select 1 from public.wallets w where w.wallet_address = sp.wallet_address and w.flag_status = 'EXCLUDED')
    group by sp.wallet_address
  ), season as (
    select sp.wallet_address,
      coalesce(sum(sp.final_points), 0) as points,
      coalesce(sum(sp.qualifying_volume_usd), 0) as volume,
      count(*)::bigint as swaps
    from public.samurai_points sp
    where sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'
      and not exists (select 1 from public.wallets w where w.wallet_address = sp.wallet_address and w.flag_status = 'EXCLUDED')
      and p_season_id is not null and sp.season_id = p_season_id
    group by sp.wallet_address
  ), season_ranked as (
    select s.wallet_address,
      row_number() over (order by s.points desc, s.volume desc, s.wallet_address asc) as current_rank
    from season s
  ), lifetime_ranked as (
    select l.wallet_address,
      row_number() over (order by l.points desc, l.volume desc, l.wallet_address asc) as current_rank
    from lifetime l
  )
  select p_wallet, coalesce(l.points, 0), coalesce(l.volume, 0), coalesce(l.swaps, 0),
    coalesce(s.points, 0), coalesce(s.volume, 0), coalesce(s.swaps, 0),
    case when p_season_id is not null then sr.current_rank else lr.current_rank end
  from (select p_wallet as wallet_address) requested
  left join lifetime l on l.wallet_address = requested.wallet_address
  left join season s on s.wallet_address = requested.wallet_address
  left join season_ranked sr on sr.wallet_address = requested.wallet_address
  left join lifetime_ranked lr on lr.wallet_address = requested.wallet_address;
$$;

revoke execute on function public.get_samurai_leaderboard(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.get_samurai_leaderboard(text, text, integer, integer) to service_role;
revoke execute on function public.get_samurai_wallet_stats(text, text) from public, anon, authenticated;
grant execute on function public.get_samurai_wallet_stats(text, text) to service_role;