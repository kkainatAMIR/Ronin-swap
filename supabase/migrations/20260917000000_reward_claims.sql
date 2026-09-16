-- =====================================================================
-- Reward Claim Accounting Layer
-- =====================================================================
-- This migration adds a reward/claim accounting layer on top of the
-- existing unified Samurai Points system. It does NOT modify any
-- existing points-awarding logic; it only adds new columns, a new
-- reward_claims table, and secure RPCs for recording reward claims.
--
-- Key design decisions:
--   1. Total earned points remain derived from public.samurai_points
--      (the existing trusted source). We DO NOT add a frontend-
--      controlled "earned points" value.
--   2. claimed_points is a wallet-level counter of points that have
--      been consumed by reward claims. claimable_points is always
--      derived: earned_points - claimed_points.
--   3. Reward conversion rate is configurable in samurai_admin_settings
--      (reward_asset + reward_points_per_unit). The DB only records
--      the entitlement; it does NOT perform on-chain SOL transfers.
--   4. The existing samurai_admin_settings.sol_rewards_enabled flag
--      (already present) is reused as the "Rewards ON/OFF" gate.
--   5. The existing samurai_seasons table is reused as the season/
--      earning-window mechanism. Turning Rewards OFF = season ends
--      (existing admin action). Existing points/claims are preserved.
--   6. The claim_reward RPC is:
--        - atomic (single transaction: insert claim + increment
--          claimed_points)
--        - idempotent (unique constraint on claim_id; resubmitting
--          the same claim_id returns the existing claim)
--        - concurrency-safe (SELECT ... FOR UPDATE on the wallet
--          row serializes per-wallet claims)
--   7. RLS is enabled on reward_claims with NO client policies
--      (defaults deny). All client access must go through the
--      security-definer RPCs restricted to service_role.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Wallet-level claimed_points counter
-- ---------------------------------------------------------------------
alter table public.wallets
  add column if not exists claimed_points numeric(30, 6) not null default 0;

alter table public.wallets
  drop constraint if exists wallets_claimed_points_nonnegative;
alter table public.wallets
  add constraint wallets_claimed_points_nonnegative check (claimed_points >= 0);

-- Defensive backfill: ensure existing wallets start at 0.
update public.wallets set claimed_points = 0 where claimed_points is null;

-- ---------------------------------------------------------------------
-- 2. Reward conversion configuration (reuses samurai_admin_settings)
-- ---------------------------------------------------------------------
alter table public.samurai_admin_settings
  add column if not exists reward_asset text not null default 'SOL';

alter table public.samurai_admin_settings
  add column if not exists reward_points_per_unit numeric(30, 6) not null default 1000;

alter table public.samurai_admin_settings
  drop constraint if exists admin_settings_reward_points_per_unit_positive;
alter table public.samurai_admin_settings
  add constraint admin_settings_reward_points_per_unit_positive check (reward_points_per_unit > 0);

alter table public.samurai_admin_settings
  drop constraint if exists admin_settings_reward_asset_nonempty;
alter table public.samurai_admin_settings
  add constraint admin_settings_reward_asset_nonempty check (reward_asset is not null and reward_asset <> '');

-- ---------------------------------------------------------------------
-- 3. reward_claims table
-- ---------------------------------------------------------------------
create table if not exists public.reward_claims (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets(id),
  wallet_address text not null,
  claim_id text not null unique,
  season_id text references public.samurai_seasons(id),
  points_claimed numeric(30, 6) not null,
  reward_asset text not null default 'SOL',
  reward_amount numeric(30, 6) not null,
  conversion_rate numeric(30, 6) not null,
  status text not null default 'ENTITLED'
    check (status in ('ENTITLED', 'PENDING_PAYOUT', 'COMPLETED', 'FAILED', 'CANCELLED')),
  claim_tx_signature text,
  client_nonce text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  constraint reward_claims_points_positive check (points_claimed > 0),
  constraint reward_claims_reward_nonnegative check (reward_amount >= 0),
  constraint reward_claims_rate_positive check (conversion_rate > 0),
  constraint reward_claims_claim_id_format check (claim_id ~ '^[A-Za-z0-9_-]{8,200}$')
);

-- Indexes for common reward queries
create index if not exists reward_claims_wallet_id_idx
  on public.reward_claims(wallet_id, created_at desc);
create index if not exists reward_claims_wallet_address_idx
  on public.reward_claims(wallet_address, created_at desc);
create index if not exists reward_claims_claim_id_idx
  on public.reward_claims(claim_id);
create index if not exists reward_claims_status_idx
  on public.reward_claims(status, created_at desc);
create index if not exists reward_claims_season_id_idx
  on public.reward_claims(season_id, created_at desc);
create unique index if not exists reward_claims_tx_signature_uidx
  on public.reward_claims(claim_tx_signature) where claim_tx_signature is not null;
create index if not exists reward_claims_created_at_idx
  on public.reward_claims(created_at desc);

alter table public.reward_claims enable row level security;

-- Clients cannot directly insert/update/delete reward claim rows.
revoke insert, update, delete on public.reward_claims from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. claim_reward RPC (atomic, idempotent, concurrency-safe)
-- ---------------------------------------------------------------------
-- Trusted backend RPC for recording a reward claim. The backend (with
-- service_role) calls this with a wallet address and a client-generated
-- claim_id. The RPC:
--   1. Locks the wallet row (FOR UPDATE) → serializes per-wallet claims.
--   2. Returns existing claim if claim_id already exists (idempotency).
--   3. Verifies sol_rewards_enabled = true (Rewards ON/OFF gate).
--   4. Verifies there is an active season (earning/claiming window).
--   5. Derives earned_points from samurai_points (NOT from a frontend
--      value).
--   6. Computes claimable = earned_points - claimed_points.
--   7. Validates requested points <= claimable.
--   8. Computes reward_amount from configured conversion rate (NOT from
--      a frontend value).
--   9. Inserts the reward_claims row and increments wallets.claimed_points
--      atomically.
-- ---------------------------------------------------------------------
create or replace function public.claim_reward(
  p_wallet_address text,
  p_claim_id text,
  p_points_to_claim numeric default null,
  p_client_nonce text default null,
  p_metadata jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  wallet_row public.wallets;
  settings_row public.samurai_admin_settings;
  current_season public.samurai_seasons;
  earned_points numeric;
  claimed_points numeric;
  claimable_points numeric;
  points_to_claim numeric;
  conversion_rate numeric;
  reward_asset text;
  reward_amount numeric;
  existing_claim public.reward_claims;
  new_claim public.reward_claims;
begin
  if p_wallet_address is null or p_wallet_address = '' then
    raise exception 'WALLET_REQUIRED';
  end if;

  if p_claim_id is null or p_claim_id = '' or p_claim_id !~ '^[A-Za-z0-9_-]{8,200}$' then
    raise exception 'INVALID_CLAIM_ID';
  end if;

  if p_points_to_claim is not null and p_points_to_claim <= 0 then
    raise exception 'INVALID_POINTS_AMOUNT';
  end if;

  -- Lock the wallet row → concurrent claims for the SAME wallet serialize.
  -- Different wallets remain fully parallel.
  select * into wallet_row from public.wallets
    where wallet_address = p_wallet_address
    for update;
  if not found then
    raise exception 'WALLET_NOT_FOUND';
  end if;

  if wallet_row.flag_status = 'EXCLUDED' then
    raise exception 'WALLET_EXCLUDED';
  end if;

  -- Idempotency: if this claim_id already exists for this wallet,
  -- return the existing claim without modifying any state.
  select * into existing_claim from public.reward_claims
    where claim_id = p_claim_id;
  if found then
    if existing_claim.wallet_id <> wallet_row.id then
      -- claim_id collision across wallets: reject rather than leak data.
      raise exception 'CLAIM_ID_CONFLICT';
    end if;
    earned_points := coalesce((
      select sum(sp.final_points) from public.samurai_points sp
      where sp.wallet_id = wallet_row.id
        and sp.eligibility_status = 'qualified'
        and sp.flag_status <> 'EXCLUDED'
    ), 0);
    return jsonb_build_object(
      'success', true,
      'idempotent', true,
      'claim', to_jsonb(existing_claim),
      'earned_points', earned_points,
      'claimed_points', wallet_row.claimed_points,
      'claimable_points', greatest(earned_points - wallet_row.claimed_points, 0)
    );
  end if;

  -- Rewards ON/OFF gate: reuse existing sol_rewards_enabled flag.
  select * into settings_row from public.samurai_admin_settings
    where id = 'default';
  if not found or not coalesce(settings_row.sol_rewards_enabled, false) then
    raise exception 'REWARDS_DISABLED';
  end if;

  -- Reuse existing season system: there must be an active season.
  -- get_current_samurai_season() auto-ends expired active seasons.
  select * into current_season from public.get_current_samurai_season();
  if not found then
    raise exception 'NO_ACTIVE_SEASON';
  end if;

  -- Trusted source: derive earned_points from samurai_points.
  select coalesce(sum(sp.final_points), 0) into earned_points
    from public.samurai_points sp
    where sp.wallet_id = wallet_row.id
      and sp.eligibility_status = 'qualified'
      and sp.flag_status <> 'EXCLUDED';

  claimed_points := coalesce(wallet_row.claimed_points, 0);
  claimable_points := greatest(earned_points - claimed_points, 0);

  if claimable_points <= 0 then
    raise exception 'NO_CLAIMABLE_POINTS';
  end if;

  -- Default to claiming all claimable, capped at claimable.
  if p_points_to_claim is null then
    points_to_claim := claimable_points;
  else
    if p_points_to_claim > claimable_points then
      raise exception 'INSUFFICIENT_CLAIMABLE_POINTS';
    end if;
    points_to_claim := p_points_to_claim;
  end if;

  -- Compute reward_amount from configurable conversion rate.
  conversion_rate := coalesce(settings_row.reward_points_per_unit, 1000);
  reward_asset := coalesce(settings_row.reward_asset, 'SOL');
  if conversion_rate <= 0 then
    raise exception 'INVALID_CONVERSION_RATE';
  end if;
  reward_amount := points_to_claim / conversion_rate;

  -- Atomic insert + claimed_points increment.
  -- ON CONFLICT (claim_id) DO NOTHING is the safety net for the
  -- (rare) case where two requests with the same claim_id arrive on
  -- different wallets and slip past the per-wallet lock.
  insert into public.reward_claims (
    wallet_id, wallet_address, claim_id, season_id,
    points_claimed, reward_asset, reward_amount, conversion_rate,
    status, client_nonce, metadata
  ) values (
    wallet_row.id, wallet_row.wallet_address, p_claim_id, current_season.id,
    points_to_claim, reward_asset, reward_amount, conversion_rate,
    'ENTITLED', p_client_nonce, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (claim_id) do nothing
  returning * into new_claim;

  if new_claim.id is null then
    -- Concurrent insert won → return the existing claim idempotently.
    select * into existing_claim from public.reward_claims
      where claim_id = p_claim_id;
    return jsonb_build_object(
      'success', true,
      'idempotent', true,
      'claim', to_jsonb(existing_claim),
      'earned_points', earned_points,
      'claimed_points', wallet_row.claimed_points,
      'claimable_points', greatest(earned_points - wallet_row.claimed_points, 0)
    );
  end if;

  -- Increment claimed_points on the wallet.
  update public.wallets w
    set claimed_points = w.claimed_points + points_to_claim,
        updated_at = now()
    where w.id = wallet_row.id
    returning * into wallet_row;

  return jsonb_build_object(
    'success', true,
    'idempotent', false,
    'claim', to_jsonb(new_claim),
    'earned_points', earned_points,
    'claimed_points', wallet_row.claimed_points,
    'claimable_points', greatest(earned_points - wallet_row.claimed_points, 0)
  );
end;
$$;

revoke execute on function public.claim_reward(text, text, numeric, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_reward(text, text, numeric, text, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- 5. get_wallet_reward_balance RPC (read-only, client-facing)
-- ---------------------------------------------------------------------
create or replace function public.get_wallet_reward_balance(
  p_wallet_address text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  wallet_row public.wallets;
  earned_points numeric;
  claimed_points numeric;
  claimable_points numeric;
  settings_row public.samurai_admin_settings;
  current_season public.samurai_seasons;
  recent_claims jsonb;
begin
  if p_wallet_address is null or p_wallet_address = '' then
    raise exception 'WALLET_REQUIRED';
  end if;

  select * into wallet_row from public.wallets
    where wallet_address = p_wallet_address;
  if not found then
    return jsonb_build_object(
      'wallet_address', p_wallet_address,
      'earned_points', 0,
      'claimed_points', 0,
      'claimable_points', 0,
      'rewards_enabled', false,
      'has_active_season', false,
      'recent_claims', '[]'::jsonb
    );
  end if;

  -- Trusted source: derive earned_points from samurai_points.
  select coalesce(sum(sp.final_points), 0) into earned_points
    from public.samurai_points sp
    where sp.wallet_id = wallet_row.id
      and sp.eligibility_status = 'qualified'
      and sp.flag_status <> 'EXCLUDED';

  claimed_points := coalesce(wallet_row.claimed_points, 0);
  claimable_points := greatest(earned_points - claimed_points, 0);

  select * into settings_row from public.samurai_admin_settings
    where id = 'default';
  select * into current_season from public.get_current_samurai_season();

  select coalesce(jsonb_agg(to_jsonb(rc)), '[]'::jsonb) into recent_claims
    from (
      select id, claim_id, points_claimed, reward_asset, reward_amount,
             conversion_rate, status, claim_tx_signature, season_id,
             created_at, claimed_at, completed_at
      from public.reward_claims
      where wallet_id = wallet_row.id
      order by created_at desc
      limit 25
    ) rc;

  return jsonb_build_object(
    'wallet_address', wallet_row.wallet_address,
    'earned_points', earned_points,
    'claimed_points', claimed_points,
    'claimable_points', claimable_points,
    'rewards_enabled', coalesce(settings_row.sol_rewards_enabled, false),
    'has_active_season', current_season.id is not null,
    'active_season_id', current_season.id,
    'reward_asset', coalesce(settings_row.reward_asset, 'SOL'),
    'reward_points_per_unit', coalesce(settings_row.reward_points_per_unit, 1000),
    'recent_claims', recent_claims
  );
end;
$$;

revoke execute on function public.get_wallet_reward_balance(text) from public, anon, authenticated;
grant execute on function public.get_wallet_reward_balance(text) to service_role;

-- ---------------------------------------------------------------------
-- 6. update_reward_claim_status RPC (admin marks payout state)
-- ---------------------------------------------------------------------
-- Used by the backend/admin after the future Solana reward program
-- performs the on-chain payout. Updates the status of an existing
-- reward claim. Does NOT touch claimed_points (that was already
-- incremented at claim time). The future Solana program is the
-- authoritative source of "did this payout actually happen?".
-- ---------------------------------------------------------------------
create or replace function public.update_reward_claim_status(
  p_claim_id text,
  p_status text,
  p_claim_tx_signature text default null,
  p_failure_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claim_row public.reward_claims;
begin
  if p_claim_id is null or p_claim_id = '' then
    raise exception 'CLAIM_ID_REQUIRED';
  end if;
  if p_status not in ('PENDING_PAYOUT', 'COMPLETED', 'FAILED', 'CANCELLED') then
    raise exception 'INVALID_STATUS';
  end if;

  select * into claim_row from public.reward_claims
    where claim_id = p_claim_id
    for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND';
  end if;

  update public.reward_claims
    set status = p_status,
        claim_tx_signature = coalesce(p_claim_tx_signature, claim_row.claim_tx_signature),
        failure_reason = case when p_status = 'FAILED' then p_failure_reason else claim_row.failure_reason end,
        completed_at = case when p_status = 'COMPLETED' then now() else claim_row.completed_at end,
        updated_at = now()
    where id = claim_row.id
    returning * into claim_row;

  return to_jsonb(claim_row);
end;
$$;

revoke execute on function public.update_reward_claim_status(text, text, text, text) from public, anon, authenticated;
grant execute on function public.update_reward_claim_status(text, text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- 7. recalculate_reward_totals RPC (admin backfill/repair)
-- ---------------------------------------------------------------------
-- Rebuilds wallets.claimed_points from the sum of all non-cancelled,
-- non-failed reward_claims rows. Useful if the database is restored
-- from a partial backup, or for an admin "reconcile" action.
-- ---------------------------------------------------------------------
create or replace function public.recalculate_reward_totals(p_wallet text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  count_wallets integer := 0;
begin
  -- Sync wallets that HAVE claims with the sum of their claim points.
  update public.wallets w
    set claimed_points = case when w.flag_status = 'EXCLUDED' then 0 else coalesce(x.total_claimed, 0) end,
        updated_at = now()
    from (
      select rc.wallet_id, sum(rc.points_claimed) as total_claimed
      from public.reward_claims rc
      where rc.status in ('ENTITLED', 'PENDING_PAYOUT', 'COMPLETED')
      group by rc.wallet_id
    ) x
    where w.id = x.wallet_id
      and (p_wallet is null or w.wallet_address = p_wallet);
  get diagnostics count_wallets = row_count;

  -- For a specific wallet with NO active claims, ensure claimed_points = 0.
  if p_wallet is not null then
    update public.wallets w
      set claimed_points = 0,
          updated_at = now()
      where w.wallet_address = p_wallet
        and not exists (
          select 1 from public.reward_claims rc
          where rc.wallet_id = w.id
            and rc.status in ('ENTITLED', 'PENDING_PAYOUT', 'COMPLETED')
        );
  end if;

  return jsonb_build_object('walletsUpdated', count_wallets);
end;
$$;

revoke execute on function public.recalculate_reward_totals(text) from public, anon, authenticated;
grant execute on function public.recalculate_reward_totals(text) to service_role;
