alter table public.wallets
  add column if not exists season_points numeric(30, 6) not null default 0,
  add column if not exists lifetime_points numeric(30, 6) not null default 0,
  add column if not exists season_qualifying_volume_usd numeric(30, 6) not null default 0,
  add column if not exists lifetime_qualifying_volume_usd numeric(30, 6) not null default 0,
  add column if not exists qualifying_swap_count bigint not null default 0;

create table if not exists public.samurai_points (
  id uuid primary key default gen_random_uuid(),
  signature text not null unique references public.swap_transactions(signature),
  wallet_id uuid not null references public.wallets(id),
  wallet_address text not null,
  qualifying_volume_usd numeric(30, 6) not null default 0,
  base_points numeric(30, 6) not null default 0,
  multiplier numeric(12, 6) not null default 1,
  final_points numeric(30, 6) not null default 0,
  points_awarded numeric(30, 6) not null default 0,
  points_rule_version text not null,
  season_id text,
  eligibility_status text not null check (eligibility_status in ('qualified', 'not_qualified')),
  exclusion_reason text,
  created_at timestamptz not null default now(),
  constraint samurai_points_amounts_nonnegative check (qualifying_volume_usd >= 0 and points_awarded >= 0)
);

alter table public.samurai_points
  add column if not exists base_points numeric(30, 6) not null default 0,
  add column if not exists multiplier numeric(12, 6) not null default 1,
  add column if not exists final_points numeric(30, 6) not null default 0;

create index if not exists samurai_points_wallet_address_idx on public.samurai_points(wallet_address);
create index if not exists samurai_points_created_at_idx on public.samurai_points(created_at desc);
create index if not exists samurai_points_season_id_idx on public.samurai_points(season_id);

alter table public.samurai_points enable row level security;

drop function if exists public.award_samurai_points(text, numeric, numeric, text, text, text, text);

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
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.samurai_points;
  swap_row public.swap_transactions;
  wallet_row public.wallets;
  effective_volume numeric;
  effective_points numeric;
  wallet_season_points numeric;
  wallet_lifetime_points numeric;
  wallet_season_volume numeric;
  wallet_lifetime_volume numeric;
  wallet_swap_count bigint;
begin
  select * into swap_row from public.swap_transactions where swap_transactions.signature = p_signature;
  if not found or swap_row.verification_status <> 'verified' then
    raise exception 'TRANSACTION_NOT_VERIFIED';
  end if;

  select * into existing from public.samurai_points where samurai_points.signature = p_signature;
  if found then
    select w.season_points, w.lifetime_points, w.season_qualifying_volume_usd,
      w.lifetime_qualifying_volume_usd, w.qualifying_swap_count
    into wallet_season_points, wallet_lifetime_points, wallet_season_volume,
      wallet_lifetime_volume, wallet_swap_count
    from public.wallets w where w.id = existing.wallet_id;
    return query select false, existing.signature, existing.wallet_address,
      existing.qualifying_volume_usd, existing.base_points, existing.multiplier,
      existing.final_points, existing.points_awarded,
      wallet_season_points, wallet_lifetime_points, wallet_season_volume,
      wallet_lifetime_volume, wallet_swap_count, existing.eligibility_status,
      existing.exclusion_reason;
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
    set season_points = w.season_points + effective_points,
      lifetime_points = w.lifetime_points + effective_points,
      season_qualifying_volume_usd = w.season_qualifying_volume_usd + effective_volume,
      lifetime_qualifying_volume_usd = w.lifetime_qualifying_volume_usd + effective_volume,
      qualifying_swap_count = w.qualifying_swap_count + case when p_eligibility_status = 'qualified' then 1 else 0 end,
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

revoke execute on function public.award_samurai_points(text, numeric, numeric, numeric, numeric, text, text, text, text) from public, anon, authenticated;
grant execute on function public.award_samurai_points(text, numeric, numeric, numeric, numeric, text, text, text, text) to service_role;