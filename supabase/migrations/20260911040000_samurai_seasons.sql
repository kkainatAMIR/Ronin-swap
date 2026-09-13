create table if not exists public.samurai_seasons (
  id text primary key,
  name text not null,
  description text not null default '',
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'ACTIVE', 'ENDED', 'FROZEN', 'ARCHIVED')),
  points_enabled boolean not null default true,
  minimum_qualifying_volume numeric(30, 6) not null default 10,
  base_points_per_usd numeric(30, 6) not null default 1,
  leaderboard_enabled boolean not null default true,
  multiplier_rules jsonb not null default '[]'::jsonb,
  final_wallet_count bigint,
  final_transaction_count bigint,
  final_volume numeric(30, 6),
  final_points numeric(30, 6),
  frozen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint samurai_seasons_dates_valid check (end_at > start_at)
);

create unique index if not exists samurai_one_active_season_idx
  on public.samurai_seasons(status) where status = 'ACTIVE';
create index if not exists samurai_seasons_dates_idx on public.samurai_seasons(start_at, end_at);
alter table public.samurai_seasons enable row level security;

create or replace function public.get_current_samurai_season()
returns setof public.samurai_seasons
language sql security definer set search_path = public as $$
  select * from public.samurai_seasons
  where status = 'ACTIVE' and now() >= start_at and now() < end_at
  order by start_at desc limit 1;
$$;

revoke execute on function public.get_current_samurai_season() from public, anon, authenticated;
grant execute on function public.get_current_samurai_season() to service_role;

create or replace function public.freeze_samurai_season(p_id text)
returns public.samurai_seasons
language plpgsql security definer set search_path = public as $$
declare result public.samurai_seasons;
begin
  update public.samurai_seasons s set status = 'FROZEN', frozen_at = now(), updated_at = now(),
    final_wallet_count = coalesce(x.wallet_count, 0), final_transaction_count = coalesce(x.transaction_count, 0),
    final_volume = coalesce(x.volume, 0), final_points = coalesce(x.points, 0)
  from (select count(distinct sp.wallet_address) wallet_count, count(*) transaction_count,
    sum(sp.qualifying_volume_usd) volume, sum(sp.final_points) points
    from public.samurai_points sp join public.wallets w on w.wallet_address = sp.wallet_address
    where sp.season_id = p_id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED' and w.flag_status <> 'EXCLUDED') x
  where s.id = p_id and s.status in ('ENDED', 'ACTIVE') returning s.* into result;
  if not found then raise exception 'SEASON_NOT_FREEZABLE'; end if;
  return result;
end;
$$;

revoke execute on function public.freeze_samurai_season(text) from public, anon, authenticated;
grant execute on function public.freeze_samurai_season(text) to service_role;