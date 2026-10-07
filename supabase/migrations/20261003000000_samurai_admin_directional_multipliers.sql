alter table public.samurai_admin_settings
  add column if not exists ronin_buy_multiplier numeric(30, 6) not null default 2,
  add column if not exists ronin_sell_multiplier numeric(30, 6) not null default 0.25;

update public.samurai_admin_settings
set ronin_buy_multiplier = 2
where ronin_buy_multiplier is null;

update public.samurai_admin_settings
set ronin_sell_multiplier = 0.25
where ronin_sell_multiplier is null;

alter table public.samurai_admin_settings
  alter column ronin_buy_multiplier set default 2,
  alter column ronin_sell_multiplier set default 0.25;

alter table public.samurai_admin_settings
  add constraint samurai_admin_settings_ronin_buy_multiplier_nonnegative
    check (ronin_buy_multiplier >= 0),
  add constraint samurai_admin_settings_ronin_sell_multiplier_nonnegative
    check (ronin_sell_multiplier >= 0);
