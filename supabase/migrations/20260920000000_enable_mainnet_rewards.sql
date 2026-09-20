-- =====================================================================
-- Enable Rewards for Mainnet Production
-- =====================================================================
-- This is a DATA-ONLY migration. It does NOT create, modify, or drop
-- any functions, tables, columns, or RPCs. It only updates the single
-- `samurai_admin_settings` row (id = 'default') to enable the reward
-- claim flow for the new Mainnet deployment.
--
-- Why this is needed:
--   The public.claim_reward() RPC checks samurai_admin_settings.sol_rewards_enabled.
--   If it's false, the RPC raises 'REWARDS_DISABLED' and no claim can proceed.
--   This migration ensures the flag is true so Mainnet claims can execute.
--
-- What this migration does NOT do:
--   - Does NOT touch any existing RPC functions
--   - Does NOT modify the wallets / samurai_points / reward_claims tables
--   - Does NOT change the schema of samurai_admin_settings
--   - Does NOT reset any existing claim data
--   - Does NOT store the program ID (that lives in env vars on the backend)
--
-- All values here can be changed later via the Admin UI or by running
-- another UPDATE. Nothing in this migration is irreversible.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Ensure the default settings row exists
-- ---------------------------------------------------------------------
-- If the row doesn't exist yet (fresh DB), insert it with defaults.
-- If it already exists, do nothing — the UPDATE below will set the values.
insert into public.samurai_admin_settings (id) values ('default')
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. Enable rewards + set conversion rate
-- ---------------------------------------------------------------------
-- These are the only values that MUST be set for Mainnet claims to work:
--   sol_rewards_enabled    = true   → claim_reward() RPC allows claims
--   points_enabled         = true   → new swaps earn Samurai Points
--   reward_asset           = 'SOL'  → payout asset
--   reward_points_per_unit = 1000   → 1000 SP = 1 SOL (adjust to taste)
--
-- The conversion rate (1000) is the same default already enforced by the
-- table constraint in 20260917000000_reward_claims.sql. Change it via the
-- Admin UI if you want a different payout rate.
-- ---------------------------------------------------------------------
update public.samurai_admin_settings
  set
    sol_rewards_enabled = true,
    points_enabled = true,
    reward_asset = 'SOL',
    reward_points_per_unit = 1000,
    updated_at = now(),
    updated_by = 'mainnet-migration'
  where id = 'default';

-- ---------------------------------------------------------------------
-- 3. Verify (for the migration log)
-- ---------------------------------------------------------------------
-- This SELECT is informational only — it runs during migration and prints
-- the resulting row so you can confirm in the Supabase migration output.
-- ---------------------------------------------------------------------
do $$
declare
  s record;
begin
  select * into s from public.samurai_admin_settings where id = 'default';
  raise notice 'Mainnet rewards settings applied: sol_rewards_enabled=%, points_enabled=%, reward_asset=%, reward_points_per_unit=%',
    s.sol_rewards_enabled, s.points_enabled, s.reward_asset, s.reward_points_per_unit;
end;
$$;

-- =====================================================================
-- OPTIONAL: Reset devnet test claims (NOT executed automatically)
-- =====================================================================
-- If you tested claims on Devnet before switching to Mainnet, you may have
-- rows in reward_claims with Devnet transaction signatures. Those rows
-- increment wallets.claimed_points, which reduces claimable_points on
-- Mainnet — even though no Mainnet SOL was ever paid out.
--
-- The on-chain Mainnet program shows total_claims = 0, so NO real Mainnet
-- claims have happened. If you want to wipe the Devnet test data so users
-- start fresh on Mainnet, uncomment and run the block below manually in
-- the Supabase SQL editor:
--
-- -- Step 1: Reset claimed_points for all wallets (no Mainnet claims exist)
-- update public.wallets
--   set claimed_points = 0,
--       updated_at = now()
--   where claimed_points > 0;
--
-- -- Step 2: Mark all existing reward_claims as CANCELLED (devnet test data)
-- update public.reward_claims
--   set status = 'CANCELLED',
--       failure_reason = 'CANCELLED: devnet test data, mainnet migration',
--       updated_at = now()
--   where status in ('ENTITLED', 'PENDING_PAYOUT', 'COMPLETED', 'FAILED');
--
-- -- Step 3 (optional): Verify the reset
-- select
--   (select count(*) from public.reward_claims where status = 'CANCELLED') as cancelled_claims,
--   (select count(*) from public.wallets where claimed_points > 0) as wallets_with_claimed_points;
--
-- DO NOT run this block if you have any real Mainnet claims (check the
-- on-chain program's total_claims field first — if it's > 0, do NOT reset).
-- =====================================================================
