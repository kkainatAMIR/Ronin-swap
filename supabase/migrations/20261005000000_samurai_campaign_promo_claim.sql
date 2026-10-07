alter table public.swap_transactions
  add column if not exists requested_promo_code text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'swap_transactions_requested_promo_code_valid'
      and conrelid = 'public.swap_transactions'::regclass
  ) then
    alter table public.swap_transactions
      add constraint swap_transactions_requested_promo_code_valid
      check (
        requested_promo_code is null
        or (btrim(requested_promo_code) <> '' and length(requested_promo_code) <= 64)
      );
  end if;
end;
$$;

create or replace function public.preserve_swap_requested_promo_code()
returns trigger
language plpgsql
as $$
begin
  new.requested_promo_code := old.requested_promo_code;
  return new;
end;
$$;

drop trigger if exists preserve_swap_requested_promo_code on public.swap_transactions;
create trigger preserve_swap_requested_promo_code
before update of requested_promo_code on public.swap_transactions
for each row
execute function public.preserve_swap_requested_promo_code();
