alter table public.swap_transactions add column if not exists quote_id text;
create index if not exists swap_transactions_quote_id_idx on public.swap_transactions(quote_id);
