alter table public.samurai_seasons
  add constraint samurai_seasons_minimum_nonnegative check (minimum_qualifying_volume >= 0),
  add constraint samurai_seasons_rate_nonnegative check (base_points_per_usd >= 0);

update public.samurai_points sp
set season_id = null
where sp.season_id is not null
  and not exists (select 1 from public.samurai_seasons s where s.id = sp.season_id);

alter table public.samurai_points
  add constraint samurai_points_season_fk foreign key (season_id) references public.samurai_seasons(id);

create table if not exists public.samurai_season_leaderboard_snapshots (
  season_id text not null references public.samurai_seasons(id),
  wallet_address text not null,
  rank bigint not null check (rank > 0),
  verified_volume numeric(30, 6) not null default 0,
  samurai_points numeric(30, 6) not null default 0,
  qualifying_swaps bigint not null default 0,
  created_at timestamptz not null default now(),
  primary key (season_id, wallet_address),
  unique (season_id, rank)
);

create index if not exists samurai_season_snapshots_rank_idx
  on public.samurai_season_leaderboard_snapshots(season_id, rank);
alter table public.samurai_season_leaderboard_snapshots enable row level security;

create or replace function public.award_samurai_points(
  p_signature text,
  p_qualifying_volume_usd numeric,
  p_base_points numeric,
  p_multiplier numeric,
  p_final_points numeric,
  p_points_rule_version text,
  p_season_id text default null,
  p_eligibility_status text default 'qualified',
  p_exclusion_reason text default null
)
returns table (
  inserted boolean,
  signature text,
  wallet_address text,
  qualifying_volume_usd numeric,
  base_points numeric,
  multiplier numeric,
  final_points numeric,
  points_awarded numeric,
  season_points numeric,
  lifetime_points numeric,
  season_qualifying_volume_usd numeric,
  lifetime_qualifying_volume_usd numeric,
  qualifying_swap_count bigint,
  eligibility_status text,
  exclusion_reason text
)
language plpgsql security definer set search_path = public as $$
declare
  existing public.samurai_points;
  swap_row public.swap_transactions;
  season_row public.samurai_seasons;
  wallet_row public.wallets;
  effective_volume numeric;
  effective_points numeric;
begin
  select * into swap_row from public.swap_transactions where swap_transactions.signature = p_signature;
  if not found or swap_row.verification_status <> 'verified' then
    raise exception 'TRANSACTION_NOT_VERIFIED';
  end if;

  if p_season_id is not null then
    select * into season_row from public.samurai_seasons where id = p_season_id;
    if not found or season_row.status <> 'ACTIVE' or swap_row.timestamp is null
      or swap_row.timestamp < season_row.start_at or swap_row.timestamp >= season_row.end_at then
      raise exception 'SEASON_NOT_ACTIVE';
    end if;
  end if;

  select * into existing from public.samurai_points where samurai_points.signature = p_signature;
  if found then
    select * into wallet_row from public.wallets where id = existing.wallet_id;
    return query select false, existing.signature, existing.wallet_address,
      existing.qualifying_volume_usd, existing.base_points, existing.multiplier,
      existing.final_points, existing.points_awarded,
      coalesce((select sum(sp.final_points) from public.samurai_points sp where sp.wallet_id = existing.wallet_id and sp.season_id = existing.season_id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'), 0),
      coalesce((select sum(sp.final_points) from public.samurai_points sp where sp.wallet_id = existing.wallet_id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'), 0),
      coalesce((select sum(sp.qualifying_volume_usd) from public.samurai_points sp where sp.wallet_id = existing.wallet_id and sp.season_id = existing.season_id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'), 0),
      coalesce((select sum(sp.qualifying_volume_usd) from public.samurai_points sp where sp.wallet_id = existing.wallet_id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'), 0),
      coalesce((select count(*) from public.samurai_points sp where sp.wallet_id = existing.wallet_id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'), 0)::bigint,
      existing.eligibility_status, existing.exclusion_reason;
    return;
  end if;

  effective_volume := case when p_eligibility_status = 'qualified' then greatest(p_qualifying_volume_usd, 0) else 0 end;
  effective_points := case when p_eligibility_status = 'qualified' then greatest(p_final_points, 0) else 0 end;

  insert into public.samurai_points (
    signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded,
    points_rule_version, season_id, eligibility_status, exclusion_reason
  ) values (
    p_signature, swap_row.wallet_id, swap_row.wallet_address,
    effective_volume, greatest(p_base_points, 0), greatest(p_multiplier, 1), effective_points, effective_points,
    p_points_rule_version, p_season_id, p_eligibility_status, p_exclusion_reason
  ) returning * into existing;

  update public.wallets w
  set season_points = coalesce((select sum(sp.final_points) from public.samurai_points sp where sp.wallet_id = w.id and sp.season_id = p_season_id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'), 0),
      lifetime_points = coalesce((select sum(sp.final_points) from public.samurai_points sp where sp.wallet_id = w.id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'), 0),
      season_qualifying_volume_usd = coalesce((select sum(sp.qualifying_volume_usd) from public.samurai_points sp where sp.wallet_id = w.id and sp.season_id = p_season_id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'), 0),
      lifetime_qualifying_volume_usd = coalesce((select sum(sp.qualifying_volume_usd) from public.samurai_points sp where sp.wallet_id = w.id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'), 0),
      qualifying_swap_count = coalesce((select count(*) from public.samurai_points sp where sp.wallet_id = w.id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED'), 0),
      updated_at = now()
  where w.id = existing.wallet_id
  returning * into wallet_row;

  return query select true, existing.signature, existing.wallet_address,
    existing.qualifying_volume_usd, existing.base_points, existing.multiplier,
    existing.final_points, existing.points_awarded,
    wallet_row.season_points, wallet_row.lifetime_points,
    wallet_row.season_qualifying_volume_usd, wallet_row.lifetime_qualifying_volume_usd,
    wallet_row.qualifying_swap_count, existing.eligibility_status, existing.exclusion_reason;
end;
$$;

create or replace function public.freeze_samurai_season(p_id text)
returns public.samurai_seasons
language plpgsql security definer set search_path = public as $$
declare result public.samurai_seasons;
begin
  if not exists (select 1 from public.samurai_seasons where id = p_id and status = 'ENDED') then
    raise exception 'SEASON_NOT_FREEZABLE';
  end if;

  insert into public.samurai_season_leaderboard_snapshots (season_id, wallet_address, rank, verified_volume, samurai_points, qualifying_swaps)
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
  select p_id, wallet_address, rank, verified_volume, samurai_points, qualifying_swaps from ranked;

  update public.samurai_seasons s set status = 'FROZEN', frozen_at = now(), updated_at = now(),
    final_wallet_count = coalesce(x.wallet_count, 0), final_transaction_count = coalesce(x.transaction_count, 0),
    final_volume = coalesce(x.volume, 0), final_points = coalesce(x.points, 0)
  from (select count(distinct sp.wallet_address) wallet_count, count(*) transaction_count,
    sum(sp.qualifying_volume_usd) volume, sum(sp.final_points) points
    from public.samurai_points sp join public.wallets w on w.wallet_address = sp.wallet_address
    where sp.season_id = p_id and sp.eligibility_status = 'qualified'
      and sp.flag_status <> 'EXCLUDED' and w.flag_status <> 'EXCLUDED') x
  where s.id = p_id and s.status = 'ENDED'
  returning s.* into result;
  if not found then raise exception 'SEASON_NOT_FREEZABLE'; end if;
  return result;
end;
$$;

create or replace function public.recalculate_samurai_totals(p_wallet text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare count_wallets integer := 0;
begin
  with current_season as (
    select id from public.samurai_seasons where status = 'ACTIVE' and now() >= start_at and now() < end_at limit 1
  ), totals as (
    select w2.id,
      sum(sp.final_points) filter (where sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED') as lifetime_points,
      sum(sp.qualifying_volume_usd) filter (where sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED') as lifetime_volume,
      count(*) filter (where sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED') as lifetime_swaps,
      sum(sp.final_points) filter (where sp.season_id = cs.id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED') as season_points,
      sum(sp.qualifying_volume_usd) filter (where sp.season_id = cs.id and sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED') as season_volume
    from public.wallets w2
    left join public.samurai_points sp on sp.wallet_id = w2.id
    left join current_season cs on true
    where p_wallet is null or w2.wallet_address = p_wallet
    group by w2.id
  )
  update public.wallets w set
    season_points = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(t.season_points, 0) end,
    lifetime_points = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(t.lifetime_points, 0) end,
    season_qualifying_volume_usd = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(t.season_volume, 0) end,
    lifetime_qualifying_volume_usd = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(t.lifetime_volume, 0) end,
    qualifying_swap_count = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(t.lifetime_swaps, 0) end,
    updated_at = now()
  from totals t where w.id = t.id;
  get diagnostics count_wallets = row_count;
  return jsonb_build_object('walletsUpdated', count_wallets);
end;
$$;