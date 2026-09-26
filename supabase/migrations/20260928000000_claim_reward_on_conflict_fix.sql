-- =====================================================================
-- Fix claim_reward() ON CONFLICT clause — partial-index predicate
-- =====================================================================
-- BUG
---
-- POST /api/rewards/claim-prepare returned 502 CLAIM_RPC_FAILED
-- because the claim_reward() RPC raised this Postgres error:
--
--   there is no unique or exclusion constraint matching the
--   ON CONFLICT specification
--
-- ROOT CAUSE
-- ---------
-- The FIFO-distribution loop inside claim_reward() does this INSERT:
--
--   INSERT INTO public.wallet_point_consumption
--     (wallet_id, claim_id, points_consumed, source)
--   VALUES (...)
--   ON CONFLICT (wallet_id, claim_id)
--   DO NOTHING;
--
-- But the unique constraint on (wallet_id, claim_id) is a PARTIAL
-- index — it only applies WHERE claim_id IS NOT NULL:
--
--   create unique index if not exists wallet_point_consumption_wallet_claim_uidx
--     on public.wallet_point_consumption(wallet_id, claim_id)
--     where claim_id is not null;
--
-- Postgres cannot use a partial unique index for ON CONFLICT unless
-- the index predicate is included in the ON CONFLICT clause. Without
-- the predicate, Postgres raises:
--
--   ERROR: there is no unique or exclusion constraint matching
--   the ON CONFLICT specification
--
-- This was the EXACT same bug we fixed in link_wallets() (see
-- migration 20260927000000_link_wallets_on_conflict_fix.sql) — just
-- in a different function. The pattern was duplicated.
--
-- THE FIX
-- -------
-- Add `WHERE claim_id IS NOT NULL` to the ON CONFLICT clause so
-- Postgres uses the partial unique index correctly:
--
--   ON CONFLICT (wallet_id, claim_id) WHERE claim_id IS NOT NULL
--   DO NOTHING
--
-- (claim_id is always non-null in this INSERT because the function
-- early-returns with INVALID_CLAIM_ID if p_claim_id is null/empty.)
--
-- This is a pure PL/pgSQL function definition update — no schema
-- changes, no table changes, no data changes. The migration is
-- idempotent (uses CREATE OR REPLACE FUNCTION) and safe to re-run.
--
-- This fix does NOT touch:
--   * the deployed Solana Anchor rewards program
--   * the reward PDA seeds / vault / claim instruction
--   * existing reward_claims rows or wallets.claimed_points values
--   * existing samurai_points awards
--   * the existing wallet_point_consumption ledger
--   * the existing wallet_links or wallet_link_challenges tables
-- =====================================================================

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
  v_input_is_solana boolean;
  v_input_is_evm boolean;
  v_solana_wallet text;
  v_identity jsonb;
  v_linked_evm_wallets_arr text[];
  v_wallet_addresses text[];
  v_wallet_ids uuid[];
  v_wallet_ids_ordered uuid[];
  wallet_row public.wallets;
  settings_row public.samurai_admin_settings;
  current_season public.samurai_seasons;
  earned_points numeric;
  consumed_points numeric;
  claimable_points numeric;
  points_to_claim numeric;
  conversion_rate numeric;
  reward_asset text;
  reward_amount numeric;
  existing_claim public.reward_claims;
  new_claim public.reward_claims;
  v_remaining numeric;
  v_wallet_id uuid;
  v_wallet_earned numeric;
  v_wallet_consumed numeric;
  v_wallet_available numeric;
  v_take numeric;
  evm_ids uuid[];
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

  v_input_is_solana := p_wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$';
  v_input_is_evm := p_wallet_address ~ '^0x[0-9a-fA-F]{40}$';

  -- SECURITY: EVM addresses can NEVER be Solana payout recipients.
  if v_input_is_evm then
    raise exception 'EVM_CLAIM_NOT_ALLOWED';
  end if;
  if not v_input_is_solana then
    raise exception 'INVALID_WALLET_FORMAT';
  end if;

  -- Resolve the verified identity.
  v_identity := public.get_verified_reward_identity(p_wallet_address);
  v_solana_wallet := v_identity->>'solana_wallet';
  -- Convert the linked_evm_wallets jsonb array to a Postgres text[].
  select array_agg(elem::text) into v_linked_evm_wallets_arr
    from jsonb_array_elements_text(
      coalesce(v_identity->'linked_evm_wallets', '[]'::jsonb)
    ) AS elem;

  if v_solana_wallet is null then
    raise exception 'SOLANA_REWARD_IDENTITY_NOT_FOUND';
  end if;

  v_wallet_addresses := array_append(coalesce(v_linked_evm_wallets_arr, ARRAY[]::text[]), v_solana_wallet);

  -- Lock the canonical Solana wallet row FOR UPDATE.
  select * into wallet_row from public.wallets
    where wallet_address = v_solana_wallet
    for update;
  if not found then
    raise exception 'WALLET_NOT_FOUND';
  end if;

  if wallet_row.flag_status = 'EXCLUDED' then
    raise exception 'WALLET_EXCLUDED';
  end if;

  -- Idempotency: if this claim_id already exists, return the existing claim.
  select * into existing_claim from public.reward_claims
    where claim_id = p_claim_id;
  if found then
    if existing_claim.wallet_id <> wallet_row.id then
      raise exception 'CLAIM_ID_CONFLICT';
    end if;
    select array_agg(id) into v_wallet_ids
      from public.wallets
      where wallet_address = any(v_wallet_addresses);
    if v_wallet_ids is null then
      raise exception 'REWARD_IDENTITY_WALLETS_NOT_FOUND';
    end if;
    select coalesce(sum(sp.final_points), 0) into earned_points
      from public.samurai_points sp
      where sp.wallet_id = any(v_wallet_ids)
        and sp.eligibility_status = 'qualified'
        and sp.flag_status <> 'EXCLUDED';
    select coalesce(sum(wpc.points_consumed), 0) into consumed_points
      from public.wallet_point_consumption wpc
      where wpc.wallet_id = any(v_wallet_ids);
    return jsonb_build_object(
      'success', true,
      'idempotent', true,
      'claim', to_jsonb(existing_claim),
      'earned_points', earned_points,
      'consumed_points', consumed_points,
      'claimable_points', greatest(earned_points - consumed_points, 0)
    );
  end if;

  -- Rewards ON/OFF gate.
  select * into settings_row from public.samurai_admin_settings
    where id = 'default';
  if not found or not coalesce(settings_row.sol_rewards_enabled, false) then
    raise exception 'REWARDS_DISABLED';
  end if;

  -- Active season required.
  select * into current_season from public.get_current_samurai_season();
  if not found then
    raise exception 'NO_ACTIVE_SEASON';
  end if;

  -- AUTHORITATIVE earned points.
  select array_agg(id) into v_wallet_ids
    from public.wallets
    where wallet_address = any(v_wallet_addresses);
  if v_wallet_ids is null then
    raise exception 'REWARD_IDENTITY_WALLETS_NOT_FOUND';
  end if;
  select coalesce(sum(sp.final_points), 0) into earned_points
    from public.samurai_points sp
    where sp.wallet_id = any(v_wallet_ids)
      and sp.eligibility_status = 'qualified'
      and sp.flag_status <> 'EXCLUDED';

  -- AUTHORITATIVE consumed points.
  select coalesce(sum(wpc.points_consumed), 0) into consumed_points
    from public.wallet_point_consumption wpc
    where wpc.wallet_id = any(v_wallet_ids);

  claimable_points := greatest(earned_points - consumed_points, 0);
  if claimable_points <= 0 then
    raise exception 'NO_CLAIMABLE_POINTS';
  end if;

  if p_points_to_claim is null then
    points_to_claim := claimable_points;
  else
    if p_points_to_claim > claimable_points then
      raise exception 'INSUFFICIENT_CLAIMABLE_POINTS';
    end if;
    points_to_claim := p_points_to_claim;
  end if;

  conversion_rate := coalesce(settings_row.reward_points_per_unit, 1000);
  reward_asset := coalesce(settings_row.reward_asset, 'SOL');
  if conversion_rate <= 0 then
    raise exception 'INVALID_CONVERSION_RATE';
  end if;
  reward_amount := points_to_claim / conversion_rate;

  -- Atomic insert of the reward_claims row. ON CONFLICT (claim_id)
  -- is safe here because reward_claims.claim_id has a NON-partial
  -- unique constraint (from migration 20260917000000_reward_claims.sql).
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
    select coalesce(sum(sp.final_points), 0) into earned_points
      from public.samurai_points sp
      where sp.wallet_id = any(v_wallet_ids)
        and sp.eligibility_status = 'qualified'
        and sp.flag_status <> 'EXCLUDED';
    select coalesce(sum(wpc.points_consumed), 0) into consumed_points
      from public.wallet_point_consumption wpc
      where wpc.wallet_id = any(v_wallet_ids);
    return jsonb_build_object(
      'success', true,
      'idempotent', true,
      'claim', to_jsonb(existing_claim),
      'earned_points', earned_points,
      'consumed_points', consumed_points,
      'claimable_points', greatest(earned_points - consumed_points, 0)
    );
  end if;

  -- ===================================================================
  -- FIFO DISTRIBUTION of consumed points across identity wallets.
  -- ===================================================================
  -- Build the FIFO-ordered wallet_id array:
  --   1. Canonical Solana wallet (already known via wallet_row.id)
  --   2. Linked EVM wallet_ids ordered by link verified_at ASC
  -- ===================================================================
  v_wallet_ids_ordered := array[wallet_row.id];
  begin
    select array_agg(w.id order by wl.verified_at asc) into evm_ids
      from public.wallet_links wl
      join public.wallets w on w.wallet_address = wl.evm_wallet
      where wl.solana_wallet = v_solana_wallet
        and wl.status = 'ACTIVE'
        and w.id <> wallet_row.id;
    if evm_ids is not null then
      v_wallet_ids_ordered := array_cat(v_wallet_ids_ordered, evm_ids);
    end if;
  end;

  v_remaining := points_to_claim;
  -- IMPORTANT: the FOREACH LOOP syntax in Postgres REQUIRES the
  -- `ARRAY` keyword: `FOREACH target IN ARRAY expression LOOP`.
  -- Without it, Postgres raises:
  --   ERROR: syntax error at or near "v_wallet_ids_ordered"
  -- (The original migration has the same keyword — this fix
  -- migration matches it exactly. Don't drop the ARRAY keyword.)
  foreach v_wallet_id in array v_wallet_ids_ordered
    loop
      if v_remaining <= 0 then exit; end if;

      select coalesce(sum(sp.final_points), 0) into v_wallet_earned
        from public.samurai_points sp
        where sp.wallet_id = v_wallet_id
          and sp.eligibility_status = 'qualified'
          and sp.flag_status <> 'EXCLUDED';

      select coalesce(sum(wpc.points_consumed), 0) into v_wallet_consumed
        from public.wallet_point_consumption wpc
        where wpc.wallet_id = v_wallet_id;

      v_wallet_available := greatest(v_wallet_earned - v_wallet_consumed, 0);
      v_take := least(v_remaining, v_wallet_available);

      if v_take > 0 then
        -- =================================================================
        -- THE FIX: ON CONFLICT (wallet_id, claim_id) WHERE claim_id IS NOT NULL
        -- =================================================================
        -- The unique index wallet_point_consumption_wallet_claim_uidx is
        -- PARTIAL — it only applies WHERE claim_id IS NOT NULL. Postgres
        -- cannot use a partial unique index for ON CONFLICT unless the
        -- index predicate is included in the ON CONFLICT clause.
        --
        -- Without the predicate, Postgres raises:
        --   "there is no unique or exclusion constraint matching the
        --    ON CONFLICT specification"
        -- which surfaces as HTTP 502 CLAIM_RPC_FAILED from the
        -- /api/rewards/claim-prepare handler.
        --
        -- claim_id is always non-null in this INSERT (the function
        -- early-returns with INVALID_CLAIM_ID if p_claim_id is null),
        -- so the partial index IS the right constraint to use.
        -- =================================================================
        insert into public.wallet_point_consumption (
          wallet_id, claim_id, points_consumed, source
        ) values (
          v_wallet_id, p_claim_id, v_take, 'CLAIM'
        )
        on conflict (wallet_id, claim_id) where claim_id is not null
        do nothing;

        v_remaining := v_remaining - v_take;
      end if;
    end loop;

  if v_remaining > 0 then
    raise exception 'CONSUMPTION_DISTRIBUTION_FAILED: remaining=%', v_remaining;
  end if;

  -- Legacy counter: increment wallets.claimed_points on the canonical
  -- Solana wallet. NOT authoritative (the authoritative source is
  -- wallet_point_consumption), but kept in sync for admin tools.
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
    'consumed_points', consumed_points + points_to_claim,
    'claimed_points', consumed_points + points_to_claim,
    'claimable_points', greatest(earned_points - (consumed_points + points_to_claim), 0),
    'verified_identity', jsonb_build_object(
      'solana_wallet', v_solana_wallet,
      'linked_evm_wallets', coalesce(v_linked_evm_wallets_arr, ARRAY[]::text[])
    )
  );
end;
$$;

revoke execute on function public.claim_reward(text, text, numeric, text, jsonb) from public, anon, authenticated;
grant execute on function public.claim_reward(text, text, numeric, text, jsonb) to service_role;
