-- =====================================================================
-- Wallet Link 409 — Deep Diagnostic
-- =====================================================================
-- Run this in the Supabase SQL Editor when you see a 409 from
-- /api/wallet-link/verify AND the basic "list all ACTIVE links"
-- query returns 0 rows (so it's NOT EVM_ALREADY_LINKED_ELSEWHERE).
--
-- This script inspects the wallet_link_challenges table to figure
-- out WHY the link_wallets RPC is raising.
--
-- Run ALL the queries below (they're independent — just paste each
-- block and click Run). The output will tell us:
--   1. Are there any PENDING challenges? (CHALLENGE_NOT_PENDING would
--      fire if a previous attempt marked one as USED)
--   2. Are there USED challenges? (means a previous verify succeeded)
--   3. Are there EXPIRED challenges? (means the 5-min window elapsed)
--   4. The 10 most recent challenge rows regardless of status
--   5. The 10 most recent wallet_links rows regardless of status
-- =====================================================================

-- =====================================================================
-- 1. Count challenges by status
-- =====================================================================
-- Tells us the breakdown of PENDING / USED / EXPIRED / REVOKED
-- challenges in the DB right now.

SELECT
  status,
  COUNT(*) AS count,
  MIN(created_at) AS oldest,
  MAX(created_at) AS newest
FROM
  public.wallet_link_challenges
GROUP BY
  status
ORDER BY
  status;

-- =====================================================================
-- 2. The 10 most recent challenge rows (any status)
-- =====================================================================
-- Look at the most recent challenges to see what state they ended up
-- in. The 'used_at' column tells us if a previous verify succeeded.
-- The 'expires_at' vs 'used_at' comparison tells us if the 5-min
-- window was the issue.

SELECT
  challenge_id,
  solana_wallet,
  evm_wallet,
  status,
  expires_at,
  used_at,
  created_at,
  CASE
    WHEN status = 'USED' AND used_at IS NOT NULL
      THEN EXTRACT(EPOCH FROM (used_at - created_at)) || 's to verify'
    WHEN status = 'EXPIRED'
      THEN 'expired (likely >5min between challenge + verify)'
    WHEN status = 'PENDING' AND expires_at < now()
      THEN 'PENDING but lapsed (should be EXPIRED)'
    ELSE '—'
  END AS diagnosis
FROM
  public.wallet_link_challenges
ORDER BY
  created_at DESC
LIMIT 10;

-- =====================================================================
-- 3. The 10 most recent wallet_links rows (any status)
-- =====================================================================
-- This shows whether ANY link has ever been created (even REVOKED).
-- If this returns 0 rows, no link has ever been created — the issue
-- is NOT a stale link blocking the new one.

SELECT
  solana_wallet,
  evm_wallet,
  status,
  verified_at,
  revoked_at,
  created_at,
  updated_at
FROM
  public.wallet_links
ORDER BY
  created_at DESC
LIMIT 10;

-- =====================================================================
-- 4. Show the FULL row for the LAST challenge you created
-- =====================================================================
-- When you click "Link EVM Wallet" in the UI, the backend creates a
-- challenge row with status='PENDING'. If your verify call fails with
-- 409, that challenge row's status tells us which RPC exception fired:
--
--   status='USED'      → CHALLENGE_NOT_PENDING (a previous verify
--                        call succeeded and marked it USED; the
--                        current call is a duplicate)
--   status='EXPIRED'   → CHALLENGE_EXPIRED (the 5-min window elapsed
--                        before the signatures came back)
--   status='PENDING'   → CHALLENGE_NOT_FOUND or some other error
--                        (the RPC couldn't find/lock the row)
--   status='REVOKED'   → unlikely — challenges don't get REVOKED
--                        unless admin manually intervenes
--
-- Run this AFTER you've attempted the link flow. Look at the most
-- recent row's status to see which path fired.

SELECT
  challenge_id,
  solana_wallet,
  evm_wallet,
  status,
  expires_at,
  used_at,
  created_at,
  LENGTH(message_evm) AS evm_msg_len,
  LENGTH(message_solana) AS sol_msg_len
FROM
  public.wallet_link_challenges
ORDER BY
  created_at DESC
LIMIT 5;

-- =====================================================================
-- 5. Cleanup: clear all PENDING + USED + EXPIRED challenges
-- =====================================================================
-- If you've been testing repeatedly, you'll have a pile of old
-- challenge rows. They're harmless (one-time-use, can't be replayed)
-- but make the diagnostic output noisy. This clears everything
-- older than 1 hour. Safe — challenges are NOT part of the
-- authoritative accounting (wallet_point_consumption is).

-- DELETE FROM public.wallet_link_challenges
--   WHERE created_at < now() - interval '1 hour';

-- =====================================================================
-- 6. Cleanup: revoke ALL wallet_links (for fresh testing)
-- =====================================================================
-- If you want to start completely fresh (no links, no history), this
-- marks every ACTIVE link as REVOKED. The wallet_point_consumption
-- ledger is NEVER touched — consumed points stay tied to the
-- wallet_id, so revoking does NOT reset claimable rewards.

-- UPDATE public.wallet_links
--   SET status = 'REVOKED', revoked_at = now(), updated_at = now()
--   WHERE status = 'ACTIVE';
