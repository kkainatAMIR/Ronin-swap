alter table public.wallets
  add column if not exists flag_status text not null default 'NORMAL' check (flag_status in ('NORMAL', 'FLAGGED', 'EXCLUDED')),
  add column if not exists excluded_at timestamptz,
  add column if not exists excluded_by text;

alter table public.swap_transactions
  add column if not exists flag_status text not null default 'NORMAL' check (flag_status in ('NORMAL', 'FLAGGED', 'EXCLUDED')),
  add column if not exists flag_reason text,
  add column if not exists flag_severity text,
  add column if not exists excluded_at timestamptz,
  add column if not exists excluded_by text;

alter table public.samurai_points
  add column if not exists flag_status text not null default 'NORMAL' check (flag_status in ('NORMAL', 'FLAGGED', 'EXCLUDED')),
  add column if not exists excluded_at timestamptz,
  add column if not exists excluded_by text;

create index if not exists swap_transactions_flag_status_idx on public.swap_transactions(flag_status, timestamp desc);
create index if not exists samurai_points_flag_status_idx on public.samurai_points(flag_status, created_at desc);

create table if not exists public.samurai_abuse_flags (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  signature text references public.swap_transactions(signature),
  reason text not null,
  severity text not null default 'medium',
  status text not null default 'FLAGGED' check (status in ('FLAGGED', 'EXCLUDED', 'NORMAL')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);

create table if not exists public.samurai_admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id text not null,
  action text not null,
  target_wallet text,
  transaction_signature text,
  previous_status text,
  new_status text,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists samurai_abuse_flags_status_idx on public.samurai_abuse_flags(status, created_at desc);
create index if not exists samurai_abuse_flags_wallet_idx on public.samurai_abuse_flags(wallet_address);
create index if not exists samurai_admin_audit_created_idx on public.samurai_admin_audit_log(created_at desc);

alter table public.samurai_abuse_flags enable row level security;
alter table public.samurai_admin_audit_log enable row level security;

create or replace function public.recalculate_samurai_totals(p_wallet text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare wallet_row record; count_wallets integer := 0;
begin
  if p_wallet is null then
    update public.wallets w set season_points = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(x.points, 0) end, lifetime_points = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(x.points, 0) end, 
      season_qualifying_volume_usd = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(x.volume, 0) end, lifetime_qualifying_volume_usd = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(x.volume, 0) end,
      qualifying_swap_count = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(x.swaps, 0) end, updated_at = now()
    from (select w2.id, sum(sp.final_points) filter (where sp.flag_status <> 'EXCLUDED' and sp.eligibility_status = 'qualified') points,
      sum(sp.final_points) filter (where w2.flag_status <> 'EXCLUDED' and sp.flag_status <> 'EXCLUDED' and sp.eligibility_status = 'qualified') points, 
      sum(sp.qualifying_volume_usd) filter (where w2.flag_status <> 'EXCLUDED' and sp.flag_status <> 'EXCLUDED' and sp.eligibility_status = 'qualified') volume, 
      count(*) filter (where w2.flag_status <> 'EXCLUDED' and sp.flag_status <> 'EXCLUDED' and sp.eligibility_status = 'qualified') swaps 
      from public.wallets w2 left join public.samurai_points sp on sp.wallet_id = w2.id group by w2.id) x where w.id = x.id;
    get diagnostics count_wallets = row_count;
  else
    update public.wallets w set season_points = coalesce(x.points, 0), lifetime_points = coalesce(x.points, 0),
      season_qualifying_volume_usd = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(x.volume, 0) end, lifetime_qualifying_volume_usd = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(x.volume, 0) end,
      qualifying_swap_count = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(x.swaps, 0) end, updated_at = now()
    from (select w2.id, sum(sp.final_points) filter (where sp.flag_status <> 'EXCLUDED' and sp.eligibility_status = 'qualified') points,
      sum(sp.final_points) filter (where w2.flag_status <> 'EXCLUDED' and sp.flag_status <> 'EXCLUDED' and sp.eligibility_status = 'qualified') points, 
      sum(sp.qualifying_volume_usd) filter (where w2.flag_status <> 'EXCLUDED' and sp.flag_status <> 'EXCLUDED' and sp.eligibility_status = 'qualified') volume, 
      count(*) filter (where w2.flag_status <> 'EXCLUDED' and sp.flag_status <> 'EXCLUDED' and sp.eligibility_status = 'qualified') swaps 
      from public.wallets w2 left join public.samurai_points sp on sp.wallet_id = w2.id where w2.wallet_address = p_wallet group by w2.id) x where w.id = x.id;
    get diagnostics count_wallets = row_count;
  end if;
  return jsonb_build_object('walletsUpdated', count_wallets);
end;
$$;

revoke execute on function public.recalculate_samurai_totals(text) from public, anon, authenticated;
grant execute on function public.recalculate_samurai_totals(text) to service_role;