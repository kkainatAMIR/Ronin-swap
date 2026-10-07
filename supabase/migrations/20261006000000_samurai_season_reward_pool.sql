alter table public.samurai_seasons
  add column if not exists reward_pool_amount numeric(38, 9),
  add column if not exists reward_asset text not null default 'SOL',
  add column if not exists reward_pool_status text not null default 'UNCONFIGURED',
  add column if not exists claim_window_start timestamptz,
  add column if not exists claim_window_end timestamptz,
  add column if not exists reward_finalized_at timestamptz,
  add column if not exists total_eligible_points numeric(30, 6),
  add column if not exists eligible_wallet_count bigint,
  add column if not exists allocation_version integer;

alter table public.samurai_seasons
  add constraint samurai_seasons_reward_asset_sol
    check (reward_asset = 'SOL'),
  add constraint samurai_seasons_reward_status_valid
    check (reward_pool_status in ('UNCONFIGURED', 'CONFIGURED', 'FINALIZED')),
  add constraint samurai_seasons_reward_pool_state_valid
    check (
      (reward_pool_status = 'UNCONFIGURED'
        and reward_pool_amount is null
        and claim_window_start is null
        and claim_window_end is null)
      or
      (reward_pool_status in ('CONFIGURED', 'FINALIZED')
        and reward_pool_amount is not null
        and reward_pool_amount > 0
        and claim_window_start is not null
        and claim_window_end is not null
        and claim_window_end > claim_window_start)
    );

alter table public.wallet_point_consumption
  add column if not exists season_id text references public.samurai_seasons(id),
  add column if not exists signature text references public.swap_transactions(signature);

alter table public.wallet_point_consumption
  drop constraint if exists wallet_point_consumption_source_check;
alter table public.wallet_point_consumption
  add constraint wallet_point_consumption_source_check
    check (source in ('CLAIM', 'MIGRATION_BACKFILL', 'ADMIN_ADJUST', 'SEASON_REWARD_RESERVATION'));

create unique index if not exists wallet_point_consumption_season_reservation_uidx
  on public.wallet_point_consumption(signature)
  where source = 'SEASON_REWARD_RESERVATION' and signature is not null;

create table if not exists public.samurai_season_reward_allocations (
  id uuid primary key default gen_random_uuid(),
  season_id text not null references public.samurai_seasons(id),
  wallet_id uuid not null references public.wallets(id),
  wallet_address text not null,
  eligible_points numeric(30, 6) not null,
  total_eligible_points numeric(30, 6) not null,
  reward_pool_amount numeric(38, 9) not null,
  reward_amount numeric(38, 9) not null,
  reward_asset text not null default 'SOL',
  claim_status text not null default 'AVAILABLE'
    check (claim_status in ('AVAILABLE', 'ENTITLED', 'PENDING_PAYOUT', 'COMPLETED', 'FAILED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint samurai_season_reward_allocations_identity_uidx unique (season_id, wallet_id),
  constraint samurai_season_reward_allocations_points_valid
    check (eligible_points > 0 and total_eligible_points >= eligible_points),
  constraint samurai_season_reward_allocations_amount_valid
    check (reward_pool_amount > 0 and reward_amount >= 0 and reward_amount <= reward_pool_amount),
  constraint samurai_season_reward_allocations_asset_sol
    check (reward_asset = 'SOL')
);

create index if not exists samurai_season_reward_allocations_wallet_idx
  on public.samurai_season_reward_allocations(wallet_id, season_id);

alter table public.samurai_season_reward_allocations enable row level security;
revoke all on table public.samurai_season_reward_allocations from public, anon, authenticated;
grant select, insert, update on table public.samurai_season_reward_allocations to service_role;

alter table public.reward_claims
  add column if not exists season_reward_allocation_id uuid
    references public.samurai_season_reward_allocations(id);

alter table public.reward_claims
  alter column reward_amount type numeric(38, 9);

create or replace function public.preserve_legacy_reward_claim_precision()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.season_reward_allocation_id is null then
    new.reward_amount := round(new.reward_amount, 6);
  end if;
  return new;
end;
$$;

revoke execute on function public.preserve_legacy_reward_claim_precision() from public, anon, authenticated;

drop trigger if exists reward_claims_legacy_amount_precision on public.reward_claims;
create trigger reward_claims_legacy_amount_precision
  before insert or update of reward_amount, season_reward_allocation_id
  on public.reward_claims
  for each row execute function public.preserve_legacy_reward_claim_precision();

create unique index if not exists reward_claims_active_season_allocation_uidx
  on public.reward_claims(season_reward_allocation_id)
  where season_reward_allocation_id is not null
    and status in ('ENTITLED', 'PENDING_PAYOUT', 'COMPLETED');

create or replace function public.sync_samurai_season_reward_allocation_claim_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.season_reward_allocation_id is not null then
    update public.samurai_season_reward_allocations
    set claim_status = case new.status
          when 'ENTITLED' then 'ENTITLED'
          when 'PENDING_PAYOUT' then 'PENDING_PAYOUT'
          when 'COMPLETED' then 'COMPLETED'
          else 'FAILED'
        end,
        updated_at = now()
    where id = new.season_reward_allocation_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.sync_samurai_season_reward_allocation_claim_status() from public, anon, authenticated;

drop trigger if exists reward_claims_season_allocation_status on public.reward_claims;
create trigger reward_claims_season_allocation_status
  after insert or update of status on public.reward_claims
  for each row execute function public.sync_samurai_season_reward_allocation_claim_status();

create or replace function public.refresh_samurai_season_reward_point_reservation(p_signature text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  point_row public.samurai_points;
  season_status text;
  wallet_status text;
  point_wallet_address text;
  reward_identity jsonb;
  is_eligible boolean := false;
begin
  if p_signature is null then
    return;
  end if;

  select * into point_row
  from public.samurai_points
  where signature = p_signature;

  if not found then
    delete from public.wallet_point_consumption
    where signature = p_signature and source = 'SEASON_REWARD_RESERVATION';
    return;
  end if;

  select reward_pool_status into season_status
  from public.samurai_seasons
  where id = point_row.season_id
  for share;

  if season_status = 'FINALIZED' then
    return;
  end if;

  select flag_status, wallet_address
  into wallet_status, point_wallet_address
  from public.wallets
  where id = point_row.wallet_id;
  reward_identity := public.get_verified_reward_identity(point_wallet_address);

  if season_status = 'CONFIGURED'
    and point_row.eligibility_status = 'qualified'
    and coalesce(point_row.flag_status, '') <> 'EXCLUDED'
    and coalesce(wallet_status, '') <> 'EXCLUDED'
    and point_row.final_points > 0
    and exists (
      select 1 from public.swap_transactions st
      where st.signature = point_row.signature
        and st.verification_status = 'verified'
    )
    and reward_identity->>'solana_wallet' is not null then
    is_eligible := true;
  end if;

  if is_eligible then
    insert into public.wallet_point_consumption (
      wallet_id, points_consumed, source, season_id, signature
    ) values (
      point_row.wallet_id, point_row.final_points, 'SEASON_REWARD_RESERVATION',
      point_row.season_id, point_row.signature
    )
    on conflict (signature)
      where source = 'SEASON_REWARD_RESERVATION' and signature is not null
    do update set
      wallet_id = excluded.wallet_id,
      points_consumed = excluded.points_consumed,
      season_id = excluded.season_id;
  else
    delete from public.wallet_point_consumption
    where signature = point_row.signature and source = 'SEASON_REWARD_RESERVATION';
  end if;
end;
$$;

revoke execute on function public.refresh_samurai_season_reward_point_reservation(text) from public, anon, authenticated;
grant execute on function public.refresh_samurai_season_reward_point_reservation(text) to service_role;

create or replace function public.sync_samurai_season_reward_point_reservation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.refresh_samurai_season_reward_point_reservation(old.signature);
    return old;
  end if;

  perform public.refresh_samurai_season_reward_point_reservation(new.signature);
  return new;
end;
$$;

revoke execute on function public.sync_samurai_season_reward_point_reservation() from public, anon, authenticated;

drop trigger if exists samurai_season_reward_reservation_points on public.samurai_points;
create trigger samurai_season_reward_reservation_points
  after insert or update of final_points, eligibility_status, flag_status, season_id, wallet_id, signature
  or delete on public.samurai_points
  for each row execute function public.sync_samurai_season_reward_point_reservation();

create or replace function public.sync_samurai_season_reward_swap_reservation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_samurai_season_reward_point_reservation(new.signature);
  return new;
end;
$$;

revoke execute on function public.sync_samurai_season_reward_swap_reservation() from public, anon, authenticated;

drop trigger if exists samurai_season_reward_reservation_swaps on public.swap_transactions;
create trigger samurai_season_reward_reservation_swaps
  after update of verification_status, flag_status on public.swap_transactions
  for each row execute function public.sync_samurai_season_reward_swap_reservation();

create or replace function public.sync_samurai_season_reward_wallet_reservations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  point_row record;
begin
  for point_row in
    select sp.signature
    from public.samurai_points sp
    where sp.wallet_id = new.id
  loop
    perform public.refresh_samurai_season_reward_point_reservation(point_row.signature);
  end loop;
  return new;
end;
$$;

revoke execute on function public.sync_samurai_season_reward_wallet_reservations() from public, anon, authenticated;

drop trigger if exists samurai_season_reward_reservation_wallets on public.wallets;
create trigger samurai_season_reward_reservation_wallets
  after update of flag_status on public.wallets
  for each row when (old.flag_status is distinct from new.flag_status)
  execute function public.sync_samurai_season_reward_wallet_reservations();

create or replace function public.sync_samurai_season_reward_link_reservations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  evm_address text;
  point_row record;
begin
  evm_address := lower(case when tg_op = 'DELETE' then old.evm_wallet else new.evm_wallet end);
  for point_row in
    select sp.signature
    from public.samurai_points sp
    join public.wallets w on w.id = sp.wallet_id
    where lower(w.wallet_address) = evm_address
  loop
    perform public.refresh_samurai_season_reward_point_reservation(point_row.signature);
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke execute on function public.sync_samurai_season_reward_link_reservations() from public, anon, authenticated;

drop trigger if exists samurai_season_reward_reservation_links on public.wallet_links;
create trigger samurai_season_reward_reservation_links
  after insert or update of status, evm_wallet or delete on public.wallet_links
  for each row execute function public.sync_samurai_season_reward_link_reservations();

create or replace function public.configure_samurai_season_reward_pool(
  p_id text,
  p_pool_amount numeric,
  p_claim_window_start timestamptz,
  p_claim_window_end timestamptz
)
returns public.samurai_seasons
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.samurai_seasons;
begin
  if p_pool_amount is null or p_pool_amount <= 0
    or p_pool_amount <> round(p_pool_amount, 9)
    or p_claim_window_start is null
    or p_claim_window_end is null
    or p_claim_window_end <= p_claim_window_start then
    raise exception 'INVALID_REWARD_POOL';
  end if;

  update public.samurai_seasons
  set reward_pool_amount = p_pool_amount,
      reward_asset = 'SOL',
      reward_pool_status = 'CONFIGURED',
      claim_window_start = p_claim_window_start,
      claim_window_end = p_claim_window_end,
      updated_at = now()
  where id = p_id and status = 'DRAFT' and reward_pool_status = 'UNCONFIGURED'
  returning * into result;

  if not found then
    raise exception 'REWARD_POOL_NOT_CONFIGURABLE';
  end if;

  perform public.refresh_samurai_season_reward_point_reservation(sp.signature)
  from public.samurai_points sp
  where sp.season_id = p_id;

  return result;
end;
$$;

revoke execute on function public.configure_samurai_season_reward_pool(text, numeric, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.configure_samurai_season_reward_pool(text, numeric, timestamptz, timestamptz) to service_role;

create or replace function public.finalize_samurai_season_rewards(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  season_row public.samurai_seasons;
  total_points numeric(30, 6);
  wallet_count bigint;
begin
  select * into season_row
  from public.samurai_seasons
  where id = p_id
  for update;

  if not found then
    raise exception 'SEASON_NOT_FOUND';
  end if;

  if season_row.reward_pool_status = 'FINALIZED' then
    return jsonb_build_object(
      'season_id', season_row.id,
      'reward_pool_status', season_row.reward_pool_status,
      'reward_pool_amount', season_row.reward_pool_amount,
      'total_eligible_points', season_row.total_eligible_points,
      'eligible_wallet_count', season_row.eligible_wallet_count,
      'reward_finalized_at', season_row.reward_finalized_at,
      'idempotent', true
    );
  end if;

  if season_row.reward_pool_status <> 'CONFIGURED' then
    raise exception 'REWARD_POOL_NOT_CONFIGURED';
  end if;

  if season_row.status = 'ACTIVE' and season_row.end_at <= now() then
    update public.samurai_seasons
    set status = 'ENDED', updated_at = now()
    where id = p_id;
    season_row.status := 'ENDED';
  end if;

  if season_row.status not in ('ENDED', 'FROZEN') then
    raise exception 'SEASON_NOT_ENDED';
  end if;

  perform public.refresh_samurai_season_reward_point_reservation(sp.signature)
  from public.samurai_points sp
  where sp.season_id = p_id;

  with season_wallets as (
    select distinct sp.wallet_id
    from public.samurai_points sp
    where sp.season_id = p_id
  ), wallet_identities as (
    select w.id as wallet_id,
      public.get_verified_reward_identity(w.wallet_address)->>'solana_wallet' as solana_wallet
    from season_wallets sw
    join public.wallets w on w.id = sw.wallet_id
  ), eligible_wallet_points as (
    select canonical.wallet_id, canonical.wallet_address,
      sum(sp.final_points)::numeric(30, 6) as eligible_points
    from public.samurai_points sp
    join public.swap_transactions st
      on st.signature = sp.signature
     and st.verification_status = 'verified'
    join public.wallets point_wallet
      on point_wallet.id = sp.wallet_id
    join wallet_identities identity
      on identity.wallet_id = point_wallet.id
    join public.wallets canonical
      on canonical.wallet_address = identity.solana_wallet
    where sp.season_id = p_id
      and sp.eligibility_status = 'qualified'
      and coalesce(sp.flag_status, '') <> 'EXCLUDED'
      and coalesce(point_wallet.flag_status, '') <> 'EXCLUDED'
      and coalesce(canonical.flag_status, '') <> 'EXCLUDED'
      and sp.final_points > 0
    group by canonical.wallet_id, canonical.wallet_address
  ), totals as (
    select coalesce(sum(eligible_points), 0)::numeric(30, 6) as total_points
    from eligible_wallet_points
  )
  -- Floor each share to a lamport; any remainder stays in the pool.
  insert into public.samurai_season_reward_allocations (
    season_id, wallet_id, wallet_address, eligible_points, total_eligible_points,
    reward_pool_amount, reward_amount, reward_asset
  )
  select p_id, e.wallet_id, e.wallet_address, e.eligible_points, t.total_points,
    season_row.reward_pool_amount,
    floor(season_row.reward_pool_amount * e.eligible_points / nullif(t.total_points, 0) * 1000000000)
      / 1000000000,
    'SOL'
  from eligible_wallet_points e
  cross join totals t
  where t.total_points > 0
  on conflict (season_id, wallet_id) do nothing;

  select coalesce(sum(eligible_points), 0)::numeric(30, 6), count(*)
  into total_points, wallet_count
  from public.samurai_season_reward_allocations
  where season_id = p_id;

  update public.samurai_seasons
  set reward_pool_status = 'FINALIZED',
      total_eligible_points = total_points,
      eligible_wallet_count = wallet_count,
      reward_finalized_at = now(),
      allocation_version = 1,
      updated_at = now()
  where id = p_id
  returning * into season_row;

  return jsonb_build_object(
    'season_id', season_row.id,
    'reward_pool_status', season_row.reward_pool_status,
    'reward_pool_amount', season_row.reward_pool_amount,
    'total_eligible_points', season_row.total_eligible_points,
    'eligible_wallet_count', season_row.eligible_wallet_count,
    'reward_finalized_at', season_row.reward_finalized_at,
    'idempotent', false
  );
end;
$$;

revoke execute on function public.finalize_samurai_season_rewards(text) from public, anon, authenticated;
grant execute on function public.finalize_samurai_season_rewards(text) to service_role;

create or replace function public.claim_finalized_season_reward(
  p_wallet_address text,
  p_season_id text,
  p_claim_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  identity jsonb;
  canonical_wallet text;
  canonical_row public.wallets;
  allocation public.samurai_season_reward_allocations;
  settings_row public.samurai_admin_settings;
  existing_claim public.reward_claims;
  new_claim public.reward_claims;
begin
  if p_claim_id is null or p_claim_id !~ '^[A-Za-z0-9_-]{8,200}$' then
    raise exception 'INVALID_CLAIM_ID';
  end if;

  identity := public.get_verified_reward_identity(p_wallet_address);
  canonical_wallet := identity->>'solana_wallet';
  if canonical_wallet is null then
    raise exception 'SOLANA_REWARD_IDENTITY_NOT_FOUND';
  end if;

  select * into canonical_row
  from public.wallets
  where wallet_address = canonical_wallet
  for update;
  if not found or canonical_row.flag_status = 'EXCLUDED' then
    raise exception 'WALLET_EXCLUDED';
  end if;

  select * into existing_claim
  from public.reward_claims
  where claim_id = p_claim_id;
  if found then
    if existing_claim.wallet_id <> canonical_row.id
      or existing_claim.season_id <> p_season_id
      or existing_claim.season_reward_allocation_id is null then
      raise exception 'CLAIM_ID_CONFLICT';
    end if;
    return jsonb_build_object('success', true, 'idempotent', true, 'claim', to_jsonb(existing_claim));
  end if;

  select * into settings_row
  from public.samurai_admin_settings
  where id = 'default';
  if not found or not coalesce(settings_row.sol_rewards_enabled, false) then
    raise exception 'REWARDS_DISABLED';
  end if;

  select * into allocation
  from public.samurai_season_reward_allocations
  where season_id = p_season_id and wallet_id = canonical_row.id
  for update;
  if not found or allocation.reward_amount <= 0 then
    raise exception 'NO_SEASON_REWARD_ALLOCATION';
  end if;

  if not exists (
    select 1 from public.samurai_seasons s
    where s.id = p_season_id
      and s.reward_pool_status = 'FINALIZED'
      and now() >= s.claim_window_start
      and now() < s.claim_window_end
  ) then
    raise exception 'SEASON_CLAIM_WINDOW_CLOSED';
  end if;

  if exists (
    select 1 from public.reward_claims rc
    where rc.season_reward_allocation_id = allocation.id
      and rc.status in ('ENTITLED', 'PENDING_PAYOUT', 'COMPLETED')
  ) then
    raise exception 'SEASON_REWARD_ALREADY_CLAIMED';
  end if;

  insert into public.reward_claims (
    wallet_id, wallet_address, claim_id, season_id, season_reward_allocation_id,
    points_claimed, reward_asset, reward_amount, conversion_rate,
    status, metadata
  ) values (
    canonical_row.id, canonical_wallet, p_claim_id, p_season_id, allocation.id,
    allocation.eligible_points, 'SOL', allocation.reward_amount, 1,
    'ENTITLED', jsonb_build_object('flow', 'finalized-season-reward', 'allocation_id', allocation.id)
  )
  returning * into new_claim;

  return jsonb_build_object(
    'success', true,
    'idempotent', false,
    'claim', to_jsonb(new_claim),
    'allocation', to_jsonb(allocation)
  );
end;
$$;

revoke execute on function public.claim_finalized_season_reward(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_finalized_season_reward(text, text, text) to service_role;

create or replace function public.get_wallet_season_reward(p_wallet_address text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  identity jsonb;
  canonical_wallet text;
  wallet_addresses text[];
  season_rewards jsonb;
  reserved_points numeric;
begin
  identity := public.get_verified_reward_identity(p_wallet_address);
  canonical_wallet := identity->>'solana_wallet';
  select array_agg(address::text)
  into wallet_addresses
  from jsonb_array_elements_text(coalesce(identity->'linked_evm_wallets', '[]'::jsonb)) as linked(address);

  if canonical_wallet is not null then
    wallet_addresses := array_append(coalesce(wallet_addresses, array[]::text[]), canonical_wallet);
  else
    wallet_addresses := array[p_wallet_address];
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'season', jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'reward_pool_status', s.reward_pool_status,
        'reward_pool_amount', s.reward_pool_amount,
        'reward_asset', 'SOL',
        'claim_window_start', s.claim_window_start,
        'claim_window_end', s.claim_window_end,
        'total_eligible_points', s.total_eligible_points
      ),
      'allocation', case when a.id is null then null else to_jsonb(a) end,
      'claim', latest.claim,
      'claim_window_open', s.reward_pool_status = 'FINALIZED'
        and now() >= s.claim_window_start and now() < s.claim_window_end
    ) order by s.start_at desc
  ), '[]'::jsonb)
  into season_rewards
  from public.samurai_seasons s
  left join public.wallets canonical
    on canonical.wallet_address = canonical_wallet
  left join public.samurai_season_reward_allocations a
    on a.season_id = s.id and a.wallet_id = canonical.id
  left join lateral (
    select jsonb_build_object(
      'claim_id', rc.claim_id,
      'status', rc.status,
      'reward_amount', rc.reward_amount,
      'reward_asset', rc.reward_asset,
      'claim_tx_signature', rc.claim_tx_signature,
      'created_at', rc.created_at,
      'completed_at', rc.completed_at
    ) as claim
    from public.reward_claims rc
    where rc.season_reward_allocation_id = a.id
    order by rc.created_at desc
    limit 1
  ) latest on true
  where s.reward_pool_status in ('CONFIGURED', 'FINALIZED');

  select coalesce(sum(wpc.points_consumed), 0)
  into reserved_points
  from public.wallet_point_consumption wpc
  join public.wallets w on w.id = wpc.wallet_id
  where wpc.source = 'SEASON_REWARD_RESERVATION'
    and w.wallet_address = any(coalesce(wallet_addresses, array[]::text[]));

  return jsonb_build_object(
    'season_rewards', season_rewards,
    'reserved_points', reserved_points
  );
end;
$$;

revoke execute on function public.get_wallet_season_reward(text) from public, anon, authenticated;
grant execute on function public.get_wallet_season_reward(text) to service_role;

create or replace function public.revert_failed_reward_claim(
  p_claim_id text,
  p_failure_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claim_row public.reward_claims;
  wallet_row public.wallets;
  new_claimed_points numeric;
  consumption_rows_deleted integer := 0;
begin
  if p_claim_id is null or p_claim_id = '' then
    raise exception 'CLAIM_ID_REQUIRED';
  end if;

  select * into claim_row from public.reward_claims where claim_id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if claim_row.status = 'FAILED' then
    return jsonb_build_object('reverted', false, 'reason', 'ALREADY_FAILED', 'claim', to_jsonb(claim_row));
  end if;
  if claim_row.status = 'COMPLETED' then raise exception 'CANNOT_REVERT_COMPLETED'; end if;
  if claim_row.status not in ('PENDING_PAYOUT', 'ENTITLED') then
    raise exception 'INVALID_REVERSION_STATE';
  end if;

  if claim_row.season_reward_allocation_id is null then
    select * into wallet_row from public.wallets where id = claim_row.wallet_id for update;
    if not found then raise exception 'WALLET_NOT_FOUND'; end if;
    delete from public.wallet_point_consumption where claim_id = p_claim_id;
    get diagnostics consumption_rows_deleted = row_count;
    new_claimed_points := greatest(wallet_row.claimed_points - claim_row.points_claimed, 0);
    update public.wallets set claimed_points = new_claimed_points, updated_at = now()
    where id = wallet_row.id;
  end if;

  update public.reward_claims
  set status = 'FAILED', failure_reason = p_failure_reason, updated_at = now()
  where id = claim_row.id
  returning * into claim_row;

  return jsonb_build_object(
    'reverted', true,
    'reason', 'PENDING_PAYOUT_TO_FAILED',
    'claim', to_jsonb(claim_row),
    'claimed_points_delta', case when claim_row.season_reward_allocation_id is null then -claim_row.points_claimed else 0 end,
    'consumption_rows_deleted', consumption_rows_deleted
  );
end;
$$;

revoke execute on function public.revert_failed_reward_claim(text, text) from public, anon, authenticated;
grant execute on function public.revert_failed_reward_claim(text, text) to service_role;
