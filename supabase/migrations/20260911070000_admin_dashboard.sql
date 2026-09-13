create table if not exists public.samurai_admin_settings (
  id text primary key default 'default',
  points_enabled boolean not null default true,
  minimum_qualifying_swap_usd numeric(30, 6) not null default 10,
  points_per_usd numeric(30, 6) not null default 1,
  transaction_points_cap_enabled boolean not null default false,
  transaction_points_cap numeric(30, 6),
  campaigns jsonb not null default '[]'::jsonb,
  swap_enabled boolean not null default true,
  sol_rewards_enabled boolean not null default false,
  platform_fee_enabled boolean not null default false,
  platform_fee_bps numeric(12, 6) not null default 0,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint admin_settings_minimum_nonnegative check (minimum_qualifying_swap_usd >= 0),
  constraint admin_settings_rate_nonnegative check (points_per_usd >= 0),
  constraint admin_settings_cap_nonnegative check (transaction_points_cap is null or transaction_points_cap >= 0),
  constraint admin_settings_fee_nonnegative check (platform_fee_bps >= 0)
);
insert into public.samurai_admin_settings (id) values ('default') on conflict (id) do nothing;
alter table public.samurai_admin_settings enable row level security;

create table if not exists public.samurai_admin_notes (
  id uuid primary key default gen_random_uuid(),
  wallet_address text,
  transaction_signature text,
  note text not null,
  admin_id text not null,
  created_at timestamptz not null default now(),
  constraint admin_note_target check (wallet_address is not null or transaction_signature is not null)
);
create index if not exists samurai_admin_notes_wallet_idx on public.samurai_admin_notes(wallet_address, created_at desc);
create index if not exists samurai_admin_notes_signature_idx on public.samurai_admin_notes(transaction_signature, created_at desc);
alter table public.samurai_admin_notes enable row level security;

create or replace function public.get_admin_overview()
returns table (
  volume_24h numeric,
  total_volume numeric,
  total_swaps bigint,
  unique_wallets bigint,
  points_issued numeric,
  flagged_activity bigint,
  active_season jsonb
)
language sql security definer set search_path = public as $$
  select
    coalesce(sum(case when st.timestamp >= now() - interval '24 hours' then coalesce(sp.qualifying_volume_usd, 0) else 0 end), 0),
    coalesce(sum(coalesce(sp.qualifying_volume_usd, 0)), 0),
    count(distinct st.signature),
    count(distinct st.wallet_address),
    coalesce(sum(case when sp.eligibility_status = 'qualified' and sp.flag_status <> 'EXCLUDED' then sp.final_points else 0 end), 0),
    (select count(*) from public.samurai_abuse_flags where status = 'FLAGGED'),
    (select to_jsonb(s) from public.samurai_seasons s where s.status = 'ACTIVE' and now() >= s.start_at and now() < s.end_at order by s.start_at desc limit 1)
  from public.swap_transactions st
  left join public.samurai_points sp on sp.signature = st.signature
  where st.verification_status = 'verified';
$$;
revoke execute on function public.get_admin_overview() from public, anon, authenticated;
grant execute on function public.get_admin_overview() to service_role;