alter table public.wallets
  add column if not exists wallet_chain_id integer not null default 101;

alter table public.wallets drop constraint if exists wallets_address_format;
alter table public.wallets add constraint wallets_address_format
  check (wallet_address ~ '(^[1-9A-HJ-NP-Za-km-z]{32,44}$)|(^0x[0-9a-fA-F]{40}$)');
alter table public.swap_transactions drop constraint if exists swap_wallet_address_format;
alter table public.swap_transactions add constraint swap_wallet_address_format
  check (wallet_address ~ '(^[1-9A-HJ-NP-Za-km-z]{32,44}$)|(^0x[0-9a-fA-F]{40}$)');