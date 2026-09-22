create table if not exists public.admin_auth_challenges (
  nonce text primary key,
  wallet text not null,
  message text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists admin_auth_challenges_expiry_idx
  on public.admin_auth_challenges(expires_at);

alter table public.admin_auth_challenges enable row level security;

revoke all on table public.admin_auth_challenges from public, anon, authenticated;
grant select, insert, update, delete on table public.admin_auth_challenges to service_role;
