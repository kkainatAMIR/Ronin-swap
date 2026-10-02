-- Samurai Points central-ledger foundation.
-- This migration keeps the existing swap flow intact while making
-- public.samurai_points capable of representing future source types in a
-- single append-only ledger.

alter table public.samurai_points
  add column if not exists source text,
  add column if not exists source_event_id text,
  add column if not exists campaign_id text,
  add column if not exists bonus_points numeric(30, 6);

update public.samurai_points
set source = 'SWAP'
where source is null or btrim(source) = '';

update public.samurai_points
set bonus_points = 0
where bonus_points is null;

alter table public.samurai_points
  alter column source set default 'SWAP',
  alter column bonus_points set default 0,
  alter column source set not null;

alter table public.samurai_points
  add constraint samurai_points_source_not_blank
    check (source is not null and btrim(source) <> '');

alter table public.samurai_points
  add constraint samurai_points_bonus_points_nonnegative
    check (bonus_points >= 0);

create index if not exists samurai_points_source_idx
  on public.samurai_points (source, created_at desc);

create unique index if not exists samurai_points_unique_source_event_idx
  on public.samurai_points (source, source_event_id)
  where source_event_id is not null and source <> 'SWAP';

-- Keep the canonical ledger idempotent for future source types while preserving
-- the current swap-signature behavior.
create or replace function public.award_samurai_points(
  p_signature text,
  p_qualifying_volume_usd numeric,
  p_base_points numeric,
  p_multiplier numeric,
  p_final_points numeric,
  p_points_rule_version text,
  p_season_id text default null,
  p_eligibility_status text default 'qualified',
  p_exclusion_reason text default null,
  p_source text default 'SWAP',
  p_source_event_id text default null,
  p_campaign_id text default null,
  p_bonus_points numeric default 0
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
  exclusion_reason text,
  source text,
  source_event_id text,
  campaign_id text,
  bonus_points numeric
)
language plpgsql security definer set search_path = public as $$
declare
  existing public.samurai_points;
  swap_row public.swap_transactions;
  season_row public.samurai_seasons;
  wallet_row public.wallets;
  effective_volume numeric;
  effective_points numeric;
  normalized_source text;
  normalized_bonus_points numeric;
  normalized_multiplier numeric;
begin
  if p_signature is null or btrim(p_signature) = '' then
    raise exception 'SIGNATURE_REQUIRED';
  end if;

  normalized_source := coalesce(nullif(btrim(p_source), ''), 'SWAP');
  normalized_bonus_points := greatest(coalesce(p_bonus_points, 0), 0);
  normalized_multiplier := case
    when p_multiplier is null then 1
    when p_multiplier < 0 then 0
    else p_multiplier
  end;

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
      existing.eligibility_status, existing.exclusion_reason,
      existing.source, existing.source_event_id, existing.campaign_id, existing.bonus_points;
    return;
  end if;

  effective_volume := case when p_eligibility_status = 'qualified' then greatest(p_qualifying_volume_usd, 0) else 0 end;
  effective_points := case when p_eligibility_status = 'qualified' then greatest(p_final_points, 0) else 0 end;

  insert into public.samurai_points (
    signature, chain_id, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier,
    final_points, points_awarded, points_rule_version, season_id, eligibility_status,
    exclusion_reason, points_processed_at, source, source_event_id, campaign_id, bonus_points
  ) values (
    p_signature, swap_row.chain_id, swap_row.wallet_id, swap_row.wallet_address,
    effective_volume, greatest(p_base_points, 0), normalized_multiplier, effective_points, effective_points,
    p_points_rule_version, p_season_id, p_eligibility_status, p_exclusion_reason,
    case when p_eligibility_status = 'qualified' then now() else null end,
    normalized_source,
    case when normalized_source = 'SWAP' then null else coalesce(nullif(btrim(p_source_event_id), ''), p_signature) end,
    p_campaign_id,
    normalized_bonus_points
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
    wallet_row.qualifying_swap_count, existing.eligibility_status, existing.exclusion_reason,
    existing.source, existing.source_event_id, existing.campaign_id, existing.bonus_points;
end;
$$;

-- Backfill legacy rows into the new ledger shape without changing calculated
-- points or wallet totals.
update public.samurai_points
set source = 'SWAP',
    bonus_points = 0
where source is null or source = '' or bonus_points is null;
