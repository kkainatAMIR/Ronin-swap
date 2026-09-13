alter table public.wallets add column if not exists wallet_chain_id integer not null default 101;
alter table public.wallets drop constraint if exists wallets_address_format;
alter table public.wallets add constraint wallets_address_format check (wallet_address ~ '(^[1-9A-HJ-NP-Za-km-z]{32,44}$)|(^0x[0-9a-fA-F]{40}$)');
alter table public.swap_transactions
  add column if not exists chain_id integer not null default 101,
  add column if not exists provider text not null default 'jupiter',
  add column if not exists sell_token_address text,
  add column if not exists buy_token_address text,
  add column if not exists sell_amount text,
  add column if not exists buy_amount text,
  add column if not exists volume_usd numeric(30, 6),
  add column if not exists transaction_hash text;
alter table public.swap_transactions add constraint swap_chain_id_supported check (chain_id in (1, 101));
create index if not exists swap_transactions_chain_id_idx on public.swap_transactions(chain_id, timestamp desc);
create index if not exists swap_transactions_provider_idx on public.swap_transactions(provider, timestamp desc);

alter table public.samurai_points add column if not exists chain_id integer not null default 101;
create index if not exists samurai_points_chain_id_idx on public.samurai_points(chain_id, created_at desc);