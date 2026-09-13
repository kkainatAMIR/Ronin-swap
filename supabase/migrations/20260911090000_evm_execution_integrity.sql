alter table public.swap_transactions drop constraint if exists swap_signature_format;
alter table public.swap_transactions add constraint swap_signature_format check (signature ~ '(^[1-9A-HJ-NP-Za-km-z]{32,88}$)|(^0x[0-9a-fA-F]{64}$)');
create unique index if not exists swap_transactions_chain_hash_uidx on public.swap_transactions(chain_id, transaction_hash) where transaction_hash is not null;
create unique index if not exists swap_transactions_solana_signature_uidx on public.swap_transactions(signature) where chain_id = 101;

create unique index if not exists samurai_points_chain_signature_uidx on public.samurai_points(chain_id, signature);