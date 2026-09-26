-- =====================================================================
-- Why did my claim fail? — Diagnostic SQL
-- =====================================================================
-- Run this in the Supabase SQL Editor to find the EXACT failure reason
-- for your FAILED claim. The `failure_reason` column tells you which
-- code path reverted the claim.
-- =====================================================================

-- =====================================================================
-- 1. Find your FAILED claim + its failure reason
-- =====================================================================
SELECT
  claim_id,
  wallet_address,
  points_claimed,
  reward_amount,
  status,
  failure_reason,           -- ← THIS tells you why it failed
  claim_tx_signature,         -- ← paste this into Solscan to see the on-chain tx
  created_at,
  updated_at
FROM
  public.reward_claims
WHERE
  status = 'FAILED'
ORDER BY
  created_at DESC
LIMIT 10;

-- =====================================================================
-- 2. What the failure_reason values mean
-- =====================================================================
--
-- failure_reason from claim-prepare (before the tx was submitted):
-- ----------------------------------------------------------------
-- 'SOL_TO_LAMPORTS_FAILED'        → couldn't convert the reward amount
--                                    to lamports. Shouldn't happen
--                                    unless reward_amount is invalid.
-- 'VAULT_INSUFFICIENT_BALANCE'    → the reward vault doesn't have
--                                    enough SOL to pay the claim.
--                                    Admin needs to fund the vault.
-- 'POINTS_TOO_SMALL_TO_CLAIM_ON_CHAIN' → the points amount rounds
--                                    down to 0 lamports. Claim more
--                                    points at once.
--
-- failure_reason from claim-confirm (after the tx was submitted):
-- ----------------------------------------------------------------
-- 'TX_NOT_FOUND'                  → the transaction signature was not
--                                    found on Solana (wasn't submitted,
--                                    or hasn't propagated yet).
-- 'TX_FAILED_ON_CHAIN: ...'       → the transaction was submitted but
--                                    REVERTED on Solana. The detail
--                                    after the colon is the on-chain
--                                    error. Most common causes:
--                                      • Insufficient gas (user
--                                        wallet needs ~0.000005 SOL)
--                                      • Blockhash expired (user
--                                        took too long to sign)
--                                      • Program is paused
--                                      • Vault has insufficient SOL
--                                        (on-chain check failed)
-- 'CLAIM_INSTRUCTION_NOT_FOUND'  → the tx doesn't call the rewards
--                                    program. Shouldn't happen —
--                                    claim-prepare builds the
--                                    instruction.
-- 'RECIPIENT_NOT_IN_TX'           → the recipient's wallet isn't in
--                                    the tx's account keys.
-- 'BALANCE_NOT_AVAILABLE'         → the pre/post balances are missing
--                                    from the tx info.
-- 'RECIPIENT_BALANCE_DID_NOT_INCREASE' → the recipient's SOL balance
--                                    didn't increase — the payout
--                                    didn't actually happen.
--
-- failure_reason from claim-cancel (user action / frontend error):
-- ----------------------------------------------------------------
-- 'USER_REJECTED_SIGNATURE: ...'  → user cancelled the Phantom popup.
-- 'FRONTEND_ERROR: ...'           → frontend caught an unexpected
--                                    error during the claim flow.
-- 'USER_MANUAL_CANCEL_FROM_UI'    → user clicked "Cancel claim" in
--                                    the UI.
-- =====================================================================

-- =====================================================================
-- 3. Check the transaction on Solscan
-- =====================================================================
-- Copy the `claim_tx_signature` from the query above (if it's not
-- NULL) and paste it into:
--   https://explorer.solana.com/tx/<YOUR_SIGNATURE>
--
-- If the signature IS NULL, the tx was never submitted to Solana —
-- the failure happened before the submit step.
--
-- On Solscan, look for:
--   • "Success" or "Error" status at the top
--   • If Error: the error message tells you the on-chain failure
--   • The "Logs" tab shows the program's instruction logs
--   • The "Account Inputs" tab shows which accounts were involved
-- =====================================================================

-- =====================================================================
-- 4. Check the reward vault balance (if VAULT_INSUFFICIENT_BALANCE)
-- =====================================================================
-- The reward vault is the SPL token account (or system account) that
-- holds the SOL paid out to users. If it's empty, all claims fail.
-- The vault address is derived from the program's PDA seeds.
--
-- To check if the vault has SOL, you can query the Solana RPC:
--   curl -X POST https://api.mainnet-beta.solana.com \
--     -H "Content-Type: application/json" \
--     -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["VAULT_ADDRESS"]}'
--
-- Or check via the admin endpoint:
--   GET /api/admin/rewards/status
--   (requires admin auth — see api/_lib/adminAuth.mjs)
-- =====================================================================
