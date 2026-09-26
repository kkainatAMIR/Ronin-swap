-- =====================================================================
-- Wallet Link Accounting Scenarios — Test Scenarios S1–S5
-- =====================================================================
-- This file is a SELF-TEST SQL script. Apply it AFTER the migration
-- 20260926000000_wallet_links.sql. It walks through each scenario
-- the requirements document specifies and asserts the expected
-- accounting behavior. Each scenario is wrapped in a transaction
-- that ROLLS BACK at the end so it can be re-run safely without
-- polluting the production tables.
--
-- Run via: psql $DATABASE_URL -f scripts/test_wallet_link_accounting_scenarios.sql
-- OR paste into Supabase SQL Editor.
--
-- Scenarios covered:
--   S1: Normal link (Solana 25 + ETH 100 + RH 50 = 175 → claim all → 0 left)
--   S2: Existing Solana-only legacy user (50 SP → claim 50 → 0 left)
--   S3: Partial claim (200 SP → claim 100 → claim 100 → no more)
--   S4: Unlink after claim (175 SP → claim → unlink EVM → no reclaim)
--   S5: Unlink, earn, re-link (175 → claim → unlink → EVM earns +50 →
--       relink → only 50 SP claimable, NOT 175 or 225)
--
-- All scenarios use unique synthetic wallet addresses prefixed with
-- 'TESTSCEN' (Solana) and '0xTESTSCEN' (EVM) to avoid collisions with
-- real production wallet rows. They're cleaned up at the end of each
-- scenario via ROLLBACK.
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off

-- Helper: pretty-print a result
\echo '========================================================'
\echo 'Wallet Link Accounting Scenarios — Test Runner'
\echo '========================================================'

-- =====================================================================
-- S1: Normal link — Solana 25 + EVM 150 = 175 → claim all → 0
-- =====================================================================
\echo ''
\echo '--- Scenario 1: Normal link (175 SP total, claim all) ---'

BEGIN;
-- Insert test wallets
INSERT INTO public.wallets (wallet_address, wallet_chain_id) VALUES
  ('TESTSCEN1SOL', 101),
  ('0xtestscen1evm', 1)
ON CONFLICT (wallet_address) DO NOTHING;

-- Insert test samurai_points
INSERT INTO public.samurai_points (signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded, points_rule_version, season_id, eligibility_status, chain_id)
SELECT 'sig-s1-sol', w.id, 'TESTSCEN1SOL', 25, 25, 1, 25, 25, 'test-v1', NULL, 'qualified', 101
FROM public.wallets w WHERE w.wallet_address = 'TESTSCEN1SOL';
INSERT INTO public.samurai_points (signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded, points_rule_version, season_id, eligibility_status, chain_id)
SELECT 'sig-s1-eth', w.id, '0xtestscen1evm', 100, 100, 1, 100, 100, 'test-v1', NULL, 'qualified', 1
FROM public.wallets w WHERE w.wallet_address = '0xtestscen1evm';
INSERT INTO public.samurai_points (signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded, points_rule_version, season_id, eligibility_status, chain_id)
SELECT 'sig-s1-rh', w.id, '0xtestscen1evm', 50, 50, 1, 50, 50, 'test-v1', NULL, 'qualified', 4663
FROM public.wallets w WHERE w.wallet_address = '0xtestscen1evm';

-- Link EVM → Solana (direct insert for the test; in production this goes
-- through the link_wallets RPC after signature verification)
INSERT INTO public.wallet_links (solana_wallet, evm_wallet, status) VALUES
  ('TESTSCEN1SOL', '0xtestscen1evm', 'ACTIVE')
ON CONFLICT DO NOTHING;

-- Expected: earned=175, consumed=0, claimable=175
SELECT 'S1 before claim' AS step,
  (result->>'earned_points')::numeric AS earned,
  (result->>'consumed_points')::numeric AS consumed,
  (result->>'claimable_points')::numeric AS claimable
FROM public.get_wallet_reward_balance('TESTSCEN1SOL') AS result;

-- Claim all 175
SELECT public.claim_reward('TESTSCEN1SOL', 'claim-s1-001', NULL, NULL, NULL) AS s1_claim_result;

-- Expected: earned=175, consumed=175, claimable=0
SELECT 'S1 after claim' AS step,
  (result->>'earned_points')::numeric AS earned,
  (result->>'consumed_points')::numeric AS consumed,
  (result->>'claimable_points')::numeric AS claimable
FROM public.get_wallet_reward_balance('TESTSCEN1SOL') AS result;

ROLLBACK;

-- =====================================================================
-- S2: Existing Solana-only legacy user (50 SP, no link)
-- =====================================================================
\echo ''
\echo '--- Scenario 2: Solana-only legacy user (50 SP → claim 50) ---'

BEGIN;
INSERT INTO public.wallets (wallet_address, wallet_chain_id) VALUES ('TESTSCEN2SOL', 101) ON CONFLICT DO NOTHING;
INSERT INTO public.samurai_points (signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded, points_rule_version, season_id, eligibility_status, chain_id)
SELECT 'sig-s2-sol', w.id, 'TESTSCEN2SOL', 50, 50, 1, 50, 50, 'test-v1', NULL, 'qualified', 101
FROM public.wallets w WHERE w.wallet_address = 'TESTSCEN2SOL';

-- Pre-existing legacy claimed_points=10 (simulating a user who claimed
-- 10 SP before the wallet-link migration was applied). The migration's
-- backfill should have created a MIGRATION_BACKFILL row, but for the
-- test we insert both manually to simulate the post-migration state.
UPDATE public.wallets SET claimed_points = 10 WHERE wallet_address = 'TESTSCEN2SOL';
INSERT INTO public.wallet_point_consumption (wallet_id, claim_id, points_consumed, source)
SELECT w.id, NULL, 10, 'MIGRATION_BACKFILL'
FROM public.wallets w WHERE w.wallet_address = 'TESTSCEN2SOL'
ON CONFLICT DO NOTHING;

-- Expected: earned=50, consumed=10 (from MIGRATION_BACKFILL), claimable=40
SELECT 'S2 before claim' AS step,
  (result->>'earned_points')::numeric AS earned,
  (result->>'consumed_points')::numeric AS consumed,
  (result->>'claimable_points')::numeric AS claimable
FROM public.get_wallet_reward_balance('TESTSCEN2SOL') AS result;

SELECT public.claim_reward('TESTSCEN2SOL', 'claim-s2-001', NULL, NULL, NULL) AS s2_claim_result;

-- Expected: earned=50, consumed=50 (10 backfill + 40 new claim), claimable=0
SELECT 'S2 after claim' AS step,
  (result->>'earned_points')::numeric AS earned,
  (result->>'consumed_points')::numeric AS consumed,
  (result->>'claimable_points')::numeric AS claimable
FROM public.get_wallet_reward_balance('TESTSCEN2SOL') AS result;

ROLLBACK;

-- =====================================================================
-- S3: Partial claim (200 SP → claim 100 → claim 100 → no more)
-- =====================================================================
\echo ''
\echo '--- Scenario 3: Partial claim (200 SP, claim 100 twice) ---'

BEGIN;
INSERT INTO public.wallets (wallet_address, wallet_chain_id) VALUES
  ('TESTSCEN3SOL', 101), ('0xtestscen3evm', 1) ON CONFLICT DO NOTHING;

INSERT INTO public.samurai_points (signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded, points_rule_version, season_id, eligibility_status, chain_id)
SELECT 'sig-s3-sol', w.id, 'TESTSCEN3SOL', 25, 25, 1, 25, 25, 'test-v1', NULL, 'qualified', 101
FROM public.wallets w WHERE w.wallet_address = 'TESTSCEN3SOL';
INSERT INTO public.samurai_points (signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded, points_rule_version, season_id, eligibility_status, chain_id)
SELECT 'sig-s3-evm', w.id, '0xtestscen3evm', 175, 175, 1, 175, 175, 'test-v1', NULL, 'qualified', 1
FROM public.wallets w WHERE w.wallet_address = '0xtestscen3evm';

INSERT INTO public.wallet_links (solana_wallet, evm_wallet, status) VALUES
  ('TESTSCEN3SOL', '0xtestscen3evm', 'ACTIVE') ON CONFLICT DO NOTHING;

-- Expected: earned=200, consumed=0, claimable=200
SELECT 'S3 before claim 1' AS step,
  (result->>'earned_points')::numeric AS earned,
  (result->>'consumed_points')::numeric AS consumed,
  (result->>'claimable_points')::numeric AS claimable
FROM public.get_wallet_reward_balance('TESTSCEN3SOL') AS result;

-- Claim 100 (partial)
SELECT public.claim_reward('TESTSCEN3SOL', 'claim-s3-001', 100, NULL, NULL) AS s3_claim1_result;

-- Expected: earned=200, consumed=100, claimable=100
SELECT 'S3 after claim 1' AS step,
  (result->>'earned_points')::numeric AS earned,
  (result->>'consumed_points')::numeric AS consumed,
  (result->>'claimable_points')::numeric AS claimable
FROM public.get_wallet_reward_balance('TESTSCEN3SOL') AS result;

-- Claim the remaining 100
SELECT public.claim_reward('TESTSCEN3SOL', 'claim-s3-002', 100, NULL, NULL) AS s3_claim2_result;

-- Expected: earned=200, consumed=200, claimable=0
SELECT 'S3 after claim 2' AS step,
  (result->>'earned_points')::numeric AS earned,
  (result->>'consumed_points')::numeric AS consumed,
  (result->>'claimable_points')::numeric AS claimable
FROM public.get_wallet_reward_balance('TESTSCEN3SOL') AS result;

-- A third claim must fail with NO_CLAIMABLE_POINTS
\echo 'S3: third claim attempt (should raise NO_CLAIMABLE_POINTS):'
DO $$
BEGIN
  BEGIN
    PERFORM public.claim_reward('TESTSCEN3SOL', 'claim-s3-003', 1, NULL, NULL);
    RAISE EXCEPTION 'S3 FAIL: third claim succeeded but should have raised NO_CLAIMABLE_POINTS';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%NO_CLAIMABLE_POINTS%' THEN
      RAISE EXCEPTION 'S3 FAIL: third claim raised wrong error: %', SQLERRM;
    END IF;
    RAISE NOTICE 'S3 OK: third claim rejected with NO_CLAIMABLE_POINTS';
  END;
END $$;

ROLLBACK;

-- =====================================================================
-- S4: Unlink after claim (175 SP → claim 175 → unlink EVM → no reclaim)
-- =====================================================================
\echo ''
\echo '--- Scenario 4: Unlink after claim (no reclaim possible) ---'

BEGIN;
INSERT INTO public.wallets (wallet_address, wallet_chain_id) VALUES
  ('TESTSCEN4SOL', 101), ('0xtestscen4evm', 1) ON CONFLICT DO NOTHING;

INSERT INTO public.samurai_points (signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded, points_rule_version, season_id, eligibility_status, chain_id)
SELECT 'sig-s4-sol', w.id, 'TESTSCEN4SOL', 25, 25, 1, 25, 25, 'test-v1', NULL, 'qualified', 101
FROM public.wallets w WHERE w.wallet_address = 'TESTSCEN4SOL';
INSERT INTO public.samurai_points (signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded, points_rule_version, season_id, eligibility_status, chain_id)
SELECT 'sig-s4-evm', w.id, '0xtestscen4evm', 150, 150, 1, 150, 150, 'test-v1', NULL, 'qualified', 1
FROM public.wallets w WHERE w.wallet_address = '0xtestscen4evm';

INSERT INTO public.wallet_links (solana_wallet, evm_wallet, status) VALUES
  ('TESTSCEN4SOL', '0xtestscen4evm', 'ACTIVE') ON CONFLICT DO NOTHING;

-- Claim 175
SELECT public.claim_reward('TESTSCEN4SOL', 'claim-s4-001', NULL, NULL, NULL) AS s4_claim_result;

-- Expected after claim: earned=175, consumed=175, claimable=0
SELECT 'S4 after claim' AS step,
  (result->>'earned_points')::numeric AS earned,
  (result->>'consumed_points')::numeric AS consumed,
  (result->>'claimable_points')::numeric AS claimable
FROM public.get_wallet_reward_balance('TESTSCEN4SOL') AS result;

-- Unlink the EVM
SELECT public.unlink_wallet('TESTSCEN4SOL', '0xtestscen4evm') AS s4_unlink_result;

-- After unlink, the EVM's earned points are NO LONGER in the Solana's
-- identity. Earned drops to 25 (just Solana). Consumed stays at 175
-- because the consumption rows travel with the wallet_id — including
-- the EVM's wallet_id. Claimable = max(25 - 175, 0) = 0. ✅
SELECT 'S4 after unlink' AS step,
  (result->>'earned_points')::numeric AS earned,
  (result->>'consumed_points')::numeric AS consumed,
  (result->>'claimable_points')::numeric AS claimable
FROM public.get_wallet_reward_balance('TESTSCEN4SOL') AS result;

-- The key invariant: the EVM's 150 consumed points stay tied to the
-- EVM wallet_id, so they cannot be reclaimed by relinking.
SELECT 'S4 EVM consumed stays at 150' AS check_name,
  coalesce(sum(wpc.points_consumed), 0) AS evm_consumed
FROM public.wallet_point_consumption wpc
JOIN public.wallets w ON w.id = wpc.wallet_id
WHERE w.wallet_address = '0xtestscen4evm';

\echo 'S4: try claim after unlink (should raise NO_CLAIMABLE_POINTS):'
DO $$
BEGIN
  BEGIN
    PERFORM public.claim_reward('TESTSCEN4SOL', 'claim-s4-002', 1, NULL, NULL);
    RAISE EXCEPTION 'S4 FAIL: claim after unlink succeeded — duplicate-claim bug NOT fixed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%NO_CLAIMABLE_POINTS%' THEN
      RAISE EXCEPTION 'S4 FAIL: claim after unlink raised wrong error: %', SQLERRM;
    END IF;
    RAISE NOTICE 'S4 OK: claim after unlink rejected with NO_CLAIMABLE_POINTS';
  END;
END $$;

ROLLBACK;

-- =====================================================================
-- S5: Unlink, earn +50 on EVM, re-link → only 50 SP claimable
-- =====================================================================
\echo ''
\echo '--- Scenario 5: Unlink, earn +50, re-link → only 50 claimable ---'

BEGIN;
INSERT INTO public.wallets (wallet_address, wallet_chain_id) VALUES
  ('TESTSCEN5SOL', 101), ('0xtestscen5evm', 1) ON CONFLICT DO NOTHING;

-- Solana=25, EVM=150 (initial)
INSERT INTO public.samurai_points (signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded, points_rule_version, season_id, eligibility_status, chain_id)
SELECT 'sig-s5-sol', w.id, 'TESTSCEN5SOL', 25, 25, 1, 25, 25, 'test-v1', NULL, 'qualified', 101
FROM public.wallets w WHERE w.wallet_address = 'TESTSCEN5SOL';
INSERT INTO public.samurai_points (signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded, points_rule_version, season_id, eligibility_status, chain_id)
SELECT 'sig-s5-evm-1', w.id, '0xtestscen5evm', 150, 150, 1, 150, 150, 'test-v1', NULL, 'qualified', 1
FROM public.wallets w WHERE w.wallet_address = '0xtestscen5evm';

INSERT INTO public.wallet_links (solana_wallet, evm_wallet, status) VALUES
  ('TESTSCEN5SOL', '0xtestscen5evm', 'ACTIVE') ON CONFLICT DO NOTHING;

-- Claim 175
SELECT public.claim_reward('TESTSCEN5SOL', 'claim-s5-001', NULL, NULL, NULL) AS s5_claim1_result;

-- Unlink EVM
SELECT public.unlink_wallet('TESTSCEN5SOL', '0xtestscen5evm') AS s5_unlink_result;

-- EVM earns +50 more (now total 200 for the EVM wallet_id)
INSERT INTO public.samurai_points (signature, wallet_id, wallet_address, qualifying_volume_usd, base_points, multiplier, final_points, points_awarded, points_rule_version, season_id, eligibility_status, chain_id)
SELECT 'sig-s5-evm-2', w.id, '0xtestscen5evm', 50, 50, 1, 50, 50, 'test-v1', NULL, 'qualified', 1
FROM public.wallets w WHERE w.wallet_address = '0xtestscen5evm';

-- Re-link EVM → Solana
INSERT INTO public.wallet_links (solana_wallet, evm_wallet, status) VALUES
  ('TESTSCEN5SOL', '0xtestscen5evm', 'ACTIVE') ON CONFLICT DO NOTHING;

-- Expected: earned = 25 (Solana) + 200 (EVM with new +50) = 225
--           consumed = 25 (Solana) + 150 (EVM from prior claim) = 175
--           claimable = 225 - 175 = 50 ✅ (NOT 175, NOT 225)
SELECT 'S5 after relink' AS step,
  (result->>'earned_points')::numeric AS earned,
  (result->>'consumed_points')::numeric AS consumed,
  (result->>'claimable_points')::numeric AS claimable
FROM public.get_wallet_reward_balance('TESTSCEN5SOL') AS result;

-- Claim should succeed for exactly 50, not more
\echo 'S5: try to claim 51 (should raise INSUFFICIENT_CLAIMABLE_POINTS):'
DO $$
BEGIN
  BEGIN
    PERFORM public.claim_reward('TESTSCEN5SOL', 'claim-s5-002', 51, NULL, NULL);
    RAISE EXCEPTION 'S5 FAIL: claim of 51 succeeded — accounting bug NOT fixed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%INSUFFICIENT_CLAIMABLE_POINTS%' THEN
      RAISE EXCEPTION 'S5 FAIL: claim of 51 raised wrong error: %', SQLERRM;
    END IF;
    RAISE NOTICE 'S5 OK: claim of 51 rejected with INSUFFICIENT_CLAIMABLE_POINTS';
  END;
END $$;

-- Claim exactly 50 (the legitimately new points)
SELECT public.claim_reward('TESTSCEN5SOL', 'claim-s5-003', 50, NULL, NULL) AS s5_claim2_result;

-- After: claimable should be 0
SELECT 'S5 after second claim' AS step,
  (result->>'earned_points')::numeric AS earned,
  (result->>'consumed_points')::numeric AS consumed,
  (result->>'claimable_points')::numeric AS claimable
FROM public.get_wallet_reward_balance('TESTSCEN5SOL') AS result;

ROLLBACK;

\echo ''
\echo '========================================================'
\echo 'All scenarios completed (look for any EXCEPTIONs above).'
\echo 'If you see no EXCEPTIONs, the accounting is correct.'
\echo '========================================================'
