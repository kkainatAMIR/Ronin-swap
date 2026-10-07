alter table public.samurai_admin_settings
  add column if not exists effective_multiplier_ceiling numeric not null default 3;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'samurai_admin_settings_effective_multiplier_ceiling_positive'
      and conrelid = 'public.samurai_admin_settings'::regclass
  ) then
    alter table public.samurai_admin_settings
      add constraint samurai_admin_settings_effective_multiplier_ceiling_positive
      check (effective_multiplier_ceiling > 0);
  end if;
end;
$$;
