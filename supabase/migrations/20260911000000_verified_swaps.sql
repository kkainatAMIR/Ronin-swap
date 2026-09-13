create extension if not exists pgcrypto;

create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wallets_address_format check (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);

create table if not exists public.swap_transactions (
  id uuid primary key default gen_random_uuid(),
  signature text not null unique,
  wallet_id uuid not null references public.wallets(id),
  wallet_address text not null,
  input_mint text not null,
  output_mint text not null,
  input_amount_raw text not null,
  output_amount_raw text not null,
  input_decimals smallint not null check (input_decimals between 0 and 255),
  output_decimals smallint not null check (output_decimals between 0 and 255),
  timestamp timestamptz,
  slot bigint not null check (slot > 0),
  confirmation_status text not null check (confirmation_status in ('confirmed', 'finalized')),
  verification_status text not null check (verification_status = 'verified'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint swap_signature_format check (signature ~ '^[1-9A-HJ-NP-Za-km-z]{32,88}$'),
  constraint swap_wallet_address_format check (wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  constraint swap_input_amount_format check (input_amount_raw ~ '^[0-9]+$'),
  constraint swap_output_amount_format check (output_amount_raw ~ '^[0-9]+$')
);

create index if not exists swap_transactions_wallet_address_idx on public.swap_transactions(wallet_address);
create index if not exists swap_transactions_timestamp_idx on public.swap_transactions(timestamp desc);
create index if not exists swap_transactions_input_mint_idx on public.swap_transactions(input_mint);
create index if not exists swap_transactions_output_mint_idx on public.swap_transactions(output_mint);

alter table public.wallets enable row level security;
alter table public.swap_transactions enable row level security;