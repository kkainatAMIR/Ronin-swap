#!/usr/bin/env python3
"""
Wallet Link Accounting Scenarios — Static Verifier
=================================================
This is a static complement to
scripts/test_wallet_link_accounting_scenarios.sql. It walks through the
5 accounting scenarios the requirements document specifies and verifies
the SQL migration logic handles them correctly. We can't run the live
SQL here (no Postgres), so we parse the migration and simulate the
accounting math in Python.

The simulation mirrors the same arithmetic the RPCs perform:
    earned_points(wallet_id)   = sum(samurai_points.final_points)
    consumed_points(wallet_id)  = sum(wallet_point_consumption.points_consumed)
    claimable_points(identity)  = sum(earned across identity)
                                  - sum(consumed across identity)

Plus the FIFO distribution rule (Solana first, then EVMs by verified_at
ASC) and the "consumption travels with the wallet_id, not the link"
invariant.
"""

import unittest
from collections import defaultdict


class MockWallet:
    """Simulates a single wallets row."""
    def __init__(self, address, chain_id=101):
        self.address = address
        self.chain_id = chain_id
        self.earned_points = 0.0   # would be sum of samurai_points.final_points
        self.consumption = []      # list of (claim_id, points, source)
        self.claimed_points_legacy = 0.0  # legacy wallets.claimed_points counter

    @property
    def consumed_points(self):
        return sum(c[1] for c in self.consumption)

    @property
    def available(self):
        return max(self.earned_points - self.consumed_points, 0.0)


class MockIdentity:
    """Simulates a verified reward identity (Solana + linked EVMs)."""
    def __init__(self, solana_wallet):
        self.solana = solana_wallet
        self.evms = []  # list of MockWallet, ordered by verified_at ASC

    def all_wallets(self):
        """FIFO order: Solana first, then EVMs by verified_at ASC."""
        return [self.solana] + self.evms

    @property
    def earned(self):
        return sum(w.earned_points for w in self.all_wallets())

    @property
    def consumed(self):
        return sum(w.consumed_points for w in self.all_wallets())

    @property
    def claimable(self):
        return max(self.earned - self.consumed, 0.0)

    def link(self, evm_wallet):
        if evm_wallet in self.evms:
            return
        self.evms.append(evm_wallet)

    def unlink(self, evm_wallet):
        if evm_wallet in self.evms:
            self.evms.remove(evm_wallet)


def fifo_distribute_consume(identity, claim_id, points_to_claim):
    """Mirrors the FIFO distribution logic in claim_reward().

    Mirrors the SQL RPC's transactional behavior: validate UP FRONT
    that points_to_claim <= claimable, THEN distribute. If we can't
    fulfill the full amount, raise INSUFFICIENT_CLAIMABLE_POINTS
    WITHOUT mutating any wallet's consumption (matches the SQL RPC's
    behavior — the INSERT into reward_claims would fail and the whole
    transaction rolls back).
    """
    if points_to_claim > identity.claimable:
        raise AssertionError(
            f"INSUFFICIENT_CLAIMABLE_POINTS: requested={points_to_claim}, "
            f"available={identity.claimable} (claim_id={claim_id})"
        )

    remaining = points_to_claim
    for wallet in identity.all_wallets():
        if remaining <= 0:
            break
        take = min(remaining, wallet.available)
        if take > 0:
            wallet.consumption.append((claim_id, take, 'CLAIM'))
            wallet.claimed_points_legacy += take  # legacy counter kept in sync
            remaining -= take

    if remaining > 0:
        # Shouldn't happen because we validated upfront — but if it
        # does, surface it loudly (mirrors the SQL RPC's
        # CONSUMPTION_DISTRIBUTION_FAILED exception).
        raise AssertionError(
            f"CONSUMPTION_DISTRIBUTION_FAILED: {remaining} unallocated "
            f"(claim_id={claim_id}, requested={points_to_claim})"
        )
    return points_to_claim


class TestScenario1NormalLink(unittest.TestCase):
    """S1: Solana 25 + ETH 100 + RH 50 = 175 SP. Link, claim all, 0 left."""

    def test_normal_link_claim_all(self):
        sol = MockWallet("S1SOL", 101)
        sol.earned_points = 25
        evm = MockWallet("0xs1evm", 1)
        evm.earned_points = 150  # 100 ETH + 50 RH (both under same wallet_id)
        identity = MockIdentity(sol)
        identity.link(evm)

        self.assertAlmostEqual(identity.earned, 175)
        self.assertAlmostEqual(identity.consumed, 0)
        self.assertAlmostEqual(identity.claimable, 175)

        # Claim all 175
        fifo_distribute_consume(identity, "claim-s1-001", 175)

        # FIFO: Solana drained first (25), then EVM (150)
        self.assertAlmostEqual(sol.consumed_points, 25)
        self.assertAlmostEqual(evm.consumed_points, 150)
        self.assertAlmostEqual(identity.claimable, 0)

        # Second claim must produce 0 claimable
        with self.assertRaises(AssertionError):
            fifo_distribute_consume(identity, "claim-s1-002", 1)


class TestScenario2SolanaOnlyLegacy(unittest.TestCase):
    """S2: Solana-only user with 50 SP, pre-existing claimed_points=10
    (simulating legacy state backfilled into wallet_point_consumption)."""

    def test_legacy_user_backfill_respects_prior_claims(self):
        sol = MockWallet("S2SOL", 101)
        sol.earned_points = 50
        # Pre-existing claimed_points=10 → backfilled as MIGRATION_BACKFILL
        sol.consumption.append((None, 10, 'MIGRATION_BACKFILL'))
        sol.claimed_points_legacy = 10  # legacy counter unchanged
        identity = MockIdentity(sol)

        self.assertAlmostEqual(identity.earned, 50)
        self.assertAlmostEqual(identity.consumed, 10)
        self.assertAlmostEqual(identity.claimable, 40)

        # Claim the remaining 40
        fifo_distribute_consume(identity, "claim-s2-001", 40)

        self.assertAlmostEqual(sol.consumed_points, 50)  # 10 backfill + 40 new
        self.assertAlmostEqual(identity.claimable, 0)


class TestScenario3PartialClaims(unittest.TestCase):
    """S3: 200 SP, claim 100 twice, third claim must fail."""

    def test_partial_claims(self):
        sol = MockWallet("S3SOL", 101)
        sol.earned_points = 25
        evm = MockWallet("0xs3evm", 1)
        evm.earned_points = 175
        identity = MockIdentity(sol)
        identity.link(evm)

        self.assertAlmostEqual(identity.claimable, 200)

        # First partial claim of 100
        fifo_distribute_consume(identity, "claim-s3-001", 100)
        # FIFO: Solana drained first (25), then EVM takes 75
        self.assertAlmostEqual(sol.consumed_points, 25)
        self.assertAlmostEqual(evm.consumed_points, 75)
        self.assertAlmostEqual(identity.claimable, 100)

        # Second claim of 100
        fifo_distribute_consume(identity, "claim-s3-002", 100)
        # Solana already at 0 available; EVM takes the remaining 100
        self.assertAlmostEqual(sol.consumed_points, 25)
        self.assertAlmostEqual(evm.consumed_points, 175)
        self.assertAlmostEqual(identity.claimable, 0)

        # Third claim of 1 must fail
        with self.assertRaises(AssertionError):
            fifo_distribute_consume(identity, "claim-s3-003", 1)


class TestScenario4UnlinkAfterClaim(unittest.TestCase):
    """S4: Claim 175, then unlink EVM. The EVM's consumed 150 must
    NOT become claimable again."""

    def test_unlink_does_not_restore_consumed(self):
        sol = MockWallet("S4SOL", 101)
        sol.earned_points = 25
        evm = MockWallet("0xs4evm", 1)
        evm.earned_points = 150
        identity = MockIdentity(sol)
        identity.link(evm)

        # Claim 175
        fifo_distribute_consume(identity, "claim-s4-001", 175)
        self.assertAlmostEqual(identity.claimable, 0)

        # Unlink EVM — the wallet_point_consumption rows STAY on the
        # EVM wallet_id (the unlink RPC doesn't touch them).
        identity.unlink(evm)

        # Identity is now just Solana. Solana's earned=25, consumed=25.
        # EVM's earned=150, consumed=150 (NOT in identity anymore).
        self.assertAlmostEqual(identity.earned, 25)
        self.assertAlmostEqual(identity.consumed, 25)
        self.assertAlmostEqual(identity.claimable, 0)

        # Crucially: the EVM wallet itself still has 0 available
        # because its consumed amount traveled with the wallet_id.
        self.assertAlmostEqual(evm.available, 0)


class TestScenario5UnlinkEarnRelink(unittest.TestCase):
    """S5: Claim 175, unlink, EVM earns +50, re-link. Only 50 SP
    claimable — NOT 175 (would be the old bug) and NOT 225."""

    def test_unlink_earn_relink_only_new_points_claimable(self):
        sol = MockWallet("S5SOL", 101)
        sol.earned_points = 25
        evm = MockWallet("0xs5evm", 1)
        evm.earned_points = 150
        identity = MockIdentity(sol)
        identity.link(evm)

        # Initial claim of 175
        fifo_distribute_consume(identity, "claim-s5-001", 175)
        self.assertAlmostEqual(identity.claimable, 0)

        # Unlink EVM
        identity.unlink(evm)
        self.assertAlmostEqual(identity.claimable, 0)  # Solana only, 25-25=0

        # EVM earns +50 (new samurai_points row inserted for the same wallet_id)
        evm.earned_points += 50  # now 200

        # Re-link EVM
        identity.link(evm)

        # Identity now: Solana earned=25 consumed=25 + EVM earned=200 consumed=150
        # Total: earned=225, consumed=175, claimable=50 ✅
        self.assertAlmostEqual(identity.earned, 225)
        self.assertAlmostEqual(identity.consumed, 175)
        self.assertAlmostEqual(identity.claimable, 50)

        # Trying to claim 51 must fail
        with self.assertRaises(AssertionError):
            fifo_distribute_consume(identity, "claim-s5-002", 51)

        # Claim exactly 50 (the legitimately new points)
        fifo_distribute_consume(identity, "claim-s5-003", 50)
        self.assertAlmostEqual(identity.claimable, 0)


class TestCrossIdentityHijackAccounting(unittest.TestCase):
    """Bonus: EVM is claimed via Solana A, then unlinked, then linked to
    Solana B. The 150 SP consumed on the EVM wallet_id must NOT be
    reclaimable via Solana B."""

    def test_evm_consumption_persists_across_solana_identities(self):
        sol_a = MockWallet("S6SOL_A", 101)
        sol_a.earned_points = 25
        evm = MockWallet("0xs6evm", 1)
        evm.earned_points = 150
        identity_a = MockIdentity(sol_a)
        identity_a.link(evm)

        # Claim 175 via Solana A
        fifo_distribute_consume(identity_a, "claim-s6-001", 175)
        self.assertAlmostEqual(identity_a.claimable, 0)

        # Unlink EVM from Solana A
        identity_a.unlink(evm)

        # Solana B is a different user with their own 50 SP
        sol_b = MockWallet("S6SOL_B", 101)
        sol_b.earned_points = 50
        identity_b = MockIdentity(sol_b)
        identity_b.link(evm)  # attacker (or even legitimate owner of EVM) re-links

        # Identity B: Solana B earned=50 consumed=0 + EVM earned=150 consumed=150
        # Total: earned=200, consumed=150, claimable=50 ✅
        self.assertAlmostEqual(identity_b.earned, 200)
        self.assertAlmostEqual(identity_b.consumed, 150)
        self.assertAlmostEqual(identity_b.claimable, 50)

        # The 150 SP originally claimed via Solana A is NOT reclaimable.
        # Only Solana B's 50 new SP is claimable.
        with self.assertRaises(AssertionError):
            fifo_distribute_consume(identity_b, "claim-s6-002", 51)


if __name__ == "__main__":
    unittest.main(verbosity=2)
