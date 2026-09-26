-- =====================================================================
-- Wallet Link 409 Diagnostic + Cleanup
-- =====================================================================
-- Run this in the Supabase SQL Editor when you see a 409
-- 'EVM_ALREADY_LINKED_ELSEWHERE' error from /api/wallet-link/verify.
--
-- The 409 happens because your EVM wallet was previously linked to a
-- DIFFERENT Solana wallet (probably during earlier testing), and the
-- unique partial index wallet_links_evm_active_uidx prevents the same
-- EVM from being ACTIVE-linked to two different Solana wallets at once.
--
-- This script:
--   1. Shows ALL existing links for your EVM wallet (so you can see
--      which Solana wallet it's currently linked to)
--   2. Shows ALL existing links for your Solana wallet (so you can see
--      what EVMs are linked to it)
--   3. Provides a one-line UPDATE to revoke ALL links for a given
--      EVM wallet (safe — only marks them as REVOKED, never deletes)
--   4. Provides a one-line UPDATE to revoke ALL links for a given
--      Solana wallet
--
-- IMPORTANT: This script is SAFE — it only marks rows as REVOKED, it
-- never DELETEs anything. The wallet_point_consumption ledger is
-- never touched (consumed points stay tied to the wallet_id, so
-- unlinking does NOT reset claimable rewards — by design).
-- =====================================================================

-- =====================================================================
-- STEP 1: Find ALL existing links for your EVM wallet
-- =====================================================================
-- Replace '0xYOUR_EVM_ADDRESS' with your MetaMask address (lowercase).
-- This shows both ACTIVE and REVOKED links so you can see the history.

-- SELECT
--   id, solana_wallet, evm_wallet, status, verified_at, revoked_at, created_at
-- FROM
--   public.wallet_links
-- WHERE
--   evm_wallet = lower('0xYOUR_EVM_ADDRESS')
-- ORDER BY
--   created_at DESC;

-- =====================================================================
-- STEP 2: Find ALL existing links for your Solana wallet
-- =====================================================================
-- Replace 'YOUR_SOLANA_ADDRESS' with your Phantom address (base58).

-- SELECT
--   id, solana_wallet, evm_wallet, status, verified_at, revoked_at, created_at
-- FROM
--   public.wallet_links
-- WHERE
--   solana_wallet = 'YOUR_SOLANA_ADDRESS'
-- ORDER BY
--   created_at DESC;

-- =====================================================================
-- STEP 3: List ALL ACTIVE links in the system (admin overview)
-- =====================================================================
-- Useful if you've been testing with multiple wallets and want to see
-- everything that's currently linked.

SELECT
  id,
  solana_wallet,
  evm_wallet,
  status,
  verified_at,
  revoked_at,
  created_at
FROM
  public.wallet_links
WHERE
  status = 'ACTIVE'
ORDER BY
  created_at DESC;

-- =====================================================================
-- STEP 4: Revoke ALL ACTIVE links for a specific EVM wallet
-- =====================================================================
-- Replace '0xYOUR_EVM_ADDRESS' with your MetaMask address (lowercase).
-- This marks ALL existing ACTIVE links for that EVM as REVOKED, so
-- you can then link it to a fresh Solana wallet via the UI.
--
-- This is SAFE:
--   - It only UPDATEs the status column. No rows are deleted.
--   - The wallet_point_consumption ledger is never touched. Consumed
--     points stay tied to the wallet_id, so unlinking does NOT reset
--     your claimable rewards (by design).
--   - The migration's unique partial index allows a fresh link after
--     the old one is marked REVOKED.

-- UPDATE public.wallet_links
--   SET status = 'REVOKED', revoked_at = now(), updated_at = now()
--   WHERE evm_wallet = lower('0xYOUR_EVM_ADDRESS')
--     AND status = 'ACTIVE';

-- =====================================================================
-- STEP 5: Revoke ALL ACTIVE links for a specific Solana wallet
-- =====================================================================
-- Replace 'YOUR_SOLANA_ADDRESS' with your Phantom address (base58).
-- This marks ALL EVM links attached to that Solana wallet as REVOKED.

-- UPDATE public.wallet_links
--   SET status = 'REVOKED', revoked_at = now(), updated_at = now()
--   WHERE solana_wallet = 'YOUR_SOLANA_ADDRESS'
--     AND status = 'ACTIVE';

-- =====================================================================
-- STEP 6: Verify the cleanup worked
-- =====================================================================
-- After running STEP 4 or STEP 5, run this to confirm there are no
-- ACTIVE links left for the wallet you cleaned up.

-- SELECT
--   solana_wallet, evm_wallet, status, revoked_at
-- FROM
--   public.wallet_links
-- WHERE
--   evm_wallet = lower('0xYOUR_EVM_ADDRESS')
--   AND status = 'ACTIVE';
-- -- Expected: 0 rows returned.

-- =====================================================================
-- After running STEP 4 (or 5), go back to the RoninSwap UI and click
-- "Link EVM Wallet" again. The new link should succeed (status 200)
-- because the unique partial index no longer blocks it.
-- =====================================================================

-- =====================================================================
-- BONUS: Clean up old USED/EXPIRED wallet_link_challenges rows
-- =====================================================================
-- Old challenges accumulate over time. They're harmless (one-time-use,
-- can never be replayed) but take up space. Run this periodically to
-- keep the table small. Safe — DELETE is OK here because challenges
-- are NOT part of the authoritative accounting (wallet_point_consumption
-- is). Once a challenge is USED or EXPIRED, it has no further use.

-- DELETE FROM public.wallet_link_challenges
--   WHERE status IN ('USED', 'EXPIRED', 'REVOKED')
--     AND created_at < now() - interval '7 days';
