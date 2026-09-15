update public.samurai_admin_settings
set minimum_qualifying_swap_usd = 0.5,
    updated_at = now()
where id = 'default';