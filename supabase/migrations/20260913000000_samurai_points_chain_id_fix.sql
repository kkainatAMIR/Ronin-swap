-- award_samurai_points() previously left samurai_points.chain_id at its
-- table default (101) for every swap, so EVM (Ethereum/Robinhood) points rows
-- were mislabeled as Solana and required a fragile best-effort REST PATCH
-- from api/evm/complete.mjs to fix up afterwards. This redefines the RPC to
-- take chain_id from the already-verified swap_transactions row and to set
-- points_processed_at at insert time, removing the need for that follow-up
-- patch entirely.

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
    signature, chain_id, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded,
    points_rule_version, season_id, eligibility_status, exclusion_reason, points_processed_at
  ) values (
    p_signature, swap_row.chain_id, swap_row.wallet_id, swap_row.wallet_address,
    effective_volume, greatest(p_base_points, 0), greatest(p_multiplier, 1), effective_points, effective_points,
    p_points_rule_version, p_season_id, p_eligibility_status, p_exclusion_reason,
    case when p_eligibility_status = 'qualified' then now() else null end
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

-- One-time backfill so existing EVM/LI.FI points rows reflect their swap's
-- real chain instead of the pre-fix default of 101.
update public.samurai_points sp
set chain_id = st.chain_id
from public.swap_transactions st
where st.signature = sp.signature and sp.chain_id <> st.chain_id;

-- swap_transactions.chain_id also needs Robinhood Chain (4663) as a valid value.
alter table public.swap_transactions drop constraint if exists swap_chain_id_supported;
alter table public.swap_transactions add constraint swap_chain_id_supported check (chain_id in (1, 101, 4663));

-- Rebuild wallet totals from the source of truth so a legacy bad chain_id or
-- older partial backfill does not leave wallet totals stuck at zero.
select public.recalculate_samurai_totals();
