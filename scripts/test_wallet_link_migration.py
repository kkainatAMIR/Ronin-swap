#!/usr/bin/env python3
"""
Wallet Link SQL migration static checks (Python complement to the
Node test suite). Mirrors the same security invariants but uses
a different assertion framework (Python's unittest) so a bug in
either test harness doesn't mask a real failure.

Run:
    python3 /home/z/my-project/scripts/test_wallet_link_migration.py
"""

import re
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATION_PATH = REPO_ROOT / "supabase/migrations/20260926000000_wallet_links.sql"
VERIFY_HANDLER_PATH = REPO_ROOT / "api_routes/wallet-link/verify.mjs"
CHALLENGE_HANDLER_PATH = REPO_ROOT / "api_routes/wallet-link/challenge.mjs"
BALANCE_HANDLER_PATH = REPO_ROOT / "api_routes/rewards/balance.mjs"
ROUTES_PATH = REPO_ROOT / "api/_routes.mjs"


class TestWalletLinkMigration(unittest.TestCase):
    """Static checks on the SQL migration file."""

    def setUp(self):
        self.sql = MIGRATION_PATH.read_text()

    def test_wallet_links_table_exists_with_status_check(self):
        self.assertIn("create table if not exists public.wallet_links", self.sql)
        self.assertRegex(
            self.sql,
            r"status text not null default 'ACTIVE'\s+check \(status in \('ACTIVE', 'REVOKED'\)\)",
        )

    def test_evm_active_unique_partial_index(self):
        """An EVM wallet can only be ACTIVE-linked to one Solana wallet."""
        self.assertRegex(
            self.sql,
            r"create unique index if not exists wallet_links_evm_active_uidx\s+on public\.wallet_links\(evm_wallet\)\s+where status = 'ACTIVE'",
        )

    def test_pair_active_unique_partial_index(self):
        """The same (solana_wallet, evm_wallet) pair cannot have two ACTIVE rows."""
        self.assertRegex(
            self.sql,
            r"create unique index if not exists wallet_links_pair_active_uidx",
        )

    def test_challenges_table_has_one_time_use_lifecycle(self):
        self.assertIn("create table if not exists public.wallet_link_challenges", self.sql)
        self.assertRegex(
            self.sql,
            r"status text not null default 'PENDING'\s+check \(status in \('PENDING', 'USED', 'EXPIRED', 'REVOKED'\)\)",
        )
        self.assertRegex(self.sql, r"expires_at timestamptz not null")
        self.assertRegex(self.sql, r"used_at timestamptz")

    def test_link_wallets_rpc_atomic_mark_used(self):
        self.assertRegex(self.sql, r"if challenge_row\.status <> 'PENDING' then\s+raise exception 'CHALLENGE_NOT_PENDING'")
        self.assertRegex(self.sql, r"if challenge_row\.expires_at < now\(\) then")
        self.assertRegex(
            self.sql,
            r"update public\.wallet_link_challenges\s+set status = 'USED',\s+used_at = now\(\)\s+where challenge_id = p_challenge_id",
        )
        self.assertRegex(self.sql, r"for update")

    def test_link_wallets_rpc_signer_mismatch_detection(self):
        self.assertRegex(self.sql, r"raise exception 'EVM_SIGNER_MISMATCH'")
        self.assertRegex(self.sql, r"raise exception 'SOLANA_SIGNER_MISMATCH'")

    def test_link_wallets_rpc_hijack_detection(self):
        """An EVM already ACTIVE-linked to a different Solana wallet must be rejected."""
        self.assertRegex(
            self.sql,
            r"select \* into conflicting_link from public\.wallet_links\s+where evm_wallet = lower\(challenge_row\.evm_wallet\)\s+and status = 'ACTIVE'\s+and solana_wallet <> challenge_row\.solana_wallet",
        )
        self.assertRegex(self.sql, r"raise exception 'EVM_ALREADY_LINKED_ELSEWHERE'")

    def test_claim_reward_rejects_evm_payout_wallet(self):
        """An EVM address supplied as the payout wallet must be rejected."""
        self.assertRegex(self.sql, r"raise exception 'EVM_CLAIM_NOT_ALLOWED'")

    def test_claim_reward_aggregates_across_verified_identity(self):
        self.assertRegex(self.sql, r"select \* into v_identity from public\.get_verified_reward_identity\(p_wallet_address\)")
        self.assertRegex(self.sql, r"v_wallet_addresses := array_append\(coalesce\(v_identity\.linked_evm_wallets, ARRAY\[\]::text\[\]\), v_solana_wallet\)")

    def test_claim_reward_locks_canonical_solana_wallet(self):
        self.assertRegex(
            self.sql,
            r"select \* into wallet_row from public\.wallets\s+where wallet_address = v_solana_wallet\s+for update",
        )

    def test_get_balance_aggregates_across_verified_identity(self):
        self.assertRegex(self.sql, r"create or replace function public\.get_wallet_reward_balance\(\s+p_wallet_address text\s+\)")
        self.assertRegex(self.sql, r"v_wallet_addresses := array_append\(coalesce\(v_identity\.linked_evm_wallets, ARRAY\[\]::text\[\]\), v_solana_wallet\)")

    def test_get_verified_reward_identity_does_not_leak_secrets(self):
        """The identity RPC must not return nonce/signature data."""
        fn_start = self.sql.find("create or replace function public.get_verified_reward_identity(")
        fn_end = self.sql.find("revoke execute on function public.get_verified_reward_identity(text)")
        self.assertGreater(fn_start, 0)
        self.assertGreater(fn_end, fn_start)
        fn_body = self.sql[fn_start:fn_end]
        self.assertNotIn("message_evm", fn_body)
        self.assertNotIn("message_solana", fn_body)
        self.assertNotIn("nonce", fn_body)
        self.assertNotIn("signature", fn_body)

    def test_rls_enabled_and_service_role_only_grants(self):
        self.assertRegex(self.sql, r"alter table public\.wallet_links enable row level security")
        self.assertRegex(self.sql, r"revoke all on table public\.wallet_links from public, anon, authenticated")
        self.assertRegex(self.sql, r"grant select, insert, update on table public\.wallet_links to service_role")
        self.assertRegex(self.sql, r"alter table public\.wallet_link_challenges enable row level security")
        self.assertRegex(self.sql, r"revoke all on table public\.wallet_link_challenges from public, anon, authenticated")


class TestWalletLinkVerifyHandler(unittest.TestCase):
    """Static checks on the /api/wallet-link/verify handler."""

    def setUp(self):
        self.src = VERIFY_HANDLER_PATH.read_text()

    def test_does_not_read_signing_messages_from_request_body(self):
        """The frontend must not be able to substitute the signed message."""
        # No reference to body.messageEvm, body.messageSolana, etc.
        self.assertNotRegex(self.src, r"body\.(messageEvm|message_solana|messageSolana|message_evm)")

    def test_fetches_challenge_from_db(self):
        self.assertRegex(self.src, r"getPendingChallenge\(challengeId\)")

    def test_verifies_both_signatures(self):
        self.assertRegex(self.src, r"verifyEvmSignature\(")
        self.assertRegex(self.src, r"verifySolanaSignature\(")
        self.assertRegex(self.src, r"EVM_SIGNATURE_INVALID")
        self.assertRegex(self.src, r"SOLANA_SIGNATURE_INVALID")

    def test_challenge_id_format_strict(self):
        # Must be wlc- + hex chars only
        self.assertRegex(self.src, r"\^wlc-\[a-f0-9\]\{16,64\}\$")

    def test_rate_limited(self):
        self.assertRegex(self.src, r"rateLimitPersistent\(req, 'wallet_link_verify'")

    def test_does_not_log_signatures(self):
        # No console.* that includes signature/nonce bytes
        self.assertNotRegex(self.src, r"console\.\w+\([^)]*(evmSignature|solanaSignature|nonce)")


class TestWalletLinkChallengeHandler(unittest.TestCase):
    def setUp(self):
        self.src = CHALLENGE_HANDLER_PATH.read_text()

    def test_creates_challenge_with_server_generated_nonce(self):
        # The handler must call createLinkChallenge, which uses
        # node:crypto.randomBytes internally.
        self.assertRegex(self.src, r"createLinkChallenge\(")

    def test_rate_limited(self):
        self.assertRegex(self.src, r"rateLimitPersistent\(req, 'wallet_link_challenge'")

    def test_validates_wallet_formats(self):
        self.assertRegex(self.src, r"isValidSolanaAddress\(solanaWallet\)")
        self.assertRegex(self.src, r"isValidEvmAddress\(evmWallet\)")


class TestBalanceHandlerSecurity(unittest.TestCase):
    def setUp(self):
        self.src = BALANCE_HANDLER_PATH.read_text()

    def test_accepts_single_wallet_only(self):
        # Must NOT parse ?wallet=A,B,C as a list
        self.assertRegex(self.src, r"const wallet = String\(req\.query\?\.wallet \|\| ''\)\.trim\(\)")

    def test_does_not_accept_wallet_list_param(self):
        self.assertNotIn("req.query?.wallets", self.src)


class TestRoutesRegistered(unittest.TestCase):
    def setUp(self):
        self.src = ROUTES_PATH.read_text()

    def test_wallet_link_routes_registered(self):
        for route in [
            "POST /api/wallet-link/challenge",
            "POST /api/wallet-link/verify",
            "GET /api/wallet-link/list",
            "GET /api/wallet-link/revoke-challenge",
            "POST /api/wallet-link/revoke",
        ]:
            self.assertIn(route, self.src, f"Missing route: {route}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
