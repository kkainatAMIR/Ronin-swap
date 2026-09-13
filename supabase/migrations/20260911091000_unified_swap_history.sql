alter table public.swap_transactions
  add column if not exists status text not null default 'CONFIRMED',
  add column if not exists sell_token_id text,
  add column if not exists buy_token_id text;

update public.swap_transactions
set chain_id = coalesce(chain_id, 101),
    provider = coalesce(provider, 'jupiter'),
    transaction_hash = coalesce(transaction_hash, signature),
    status = coalesce(status, 'CONFIRMED'),
    sell_token_id = coalesce(sell_token_id, chain_id::text || ':' || input_mint),
    buy_token_id = coalesce(buy_token_id, chain_id::text || ':' || output_mint)
where true;

alter table public.swap_transactions add constraint swap_status_valid check (status in ('QUOTE_CREATED', 'PENDING_APPROVAL', 'APPROVAL_CONFIRMED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED'));
create index if not exists swap_transactions_status_idx on public.swap_transactions(status, created_at desc);
create index if not exists swap_transactions_sell_token_id_idx on public.swap_transactions(sell_token_id);
create index if not exists swap_transactions_buy_token_id_idx on public.swap_transactions(buy_token_id);
create index if not exists samurai_points_points_awarded_idx on public.samurai_points(points_awarded desc);

alter table public.samurai_points add column if not exists points_processed_at timestamptz;
update public.samurai_points set points_processed_at = coalesce(points_processed_at, created_at) where eligibility_status = 'qualified';

revoke insert, update, delete on public.wallets, public.swap_transactions, public.samurai_points from anon, authenticated;
revoke insert, update, delete on public.samurai_admin_settings, public.samurai_admin_notes, public.samurai_admin_audit_log from anon, authenticated;