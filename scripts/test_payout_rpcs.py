#!/usr/bin/env python3
"""
Tests for the new payout-integration RPCs:
  - mark_reward_claim_pending_payout(claim_id)
  - revert_failed_reward_claim(claim_id, reason)

Strategy:
  1. Start a real Postgres instance (pgserver).
  2. Create Supabase roles + apply all migrations including
     20260918000000_reward_payout_int.sql.
  3. Set up a wallet + qualifying swap + claim (via existing RPCs).
  4. Test the new state-transition RPCs.

Tests covered:
  T1: ENTITLED → PENDING_PAYOUT (happy path)
  T2: PENDING_PAYOUT → PENDING_PAYOUT (idempotent)
  T3: PENDING_PAYOUT → FAILED with claimed_points decremented (rollback)
  T4: FAILED → FAILED (idempotent revert)
  T5: Cannot revert a COMPLETED claim
  T6: mark_pending on a COMPLETED claim returns ALREADY_COMPLETED (idempotent)
  T7: mark_pending on a FAILED claim raises CLAIM_NOT_RESTARTABLE
  T8: claim_id does not exist → CLAIM_NOT_FOUND
  T9: After rollback, the user's claimable_points is restored
"""

import os, sys, json, tempfile, traceback, secrets, threading
from pathlib import Path
import psycopg, pgserver

REPO = Path("/home/z/my-project/Ronin-swap")
MIGRATIONS_DIR = REPO / "supabase" / "migrations"

ROLES_SQL = """
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;
"""

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58_addr(n=44): return "".join(secrets.choice(B58) for _ in range(n))
def b58_sig(n=80): return "".join(secrets.choice(B58) for _ in range(n))


def strip_pgcrypto(sql: str) -> str:
    out = []
    for line in sql.splitlines():
        if "create extension" in line.lower() and "pgcrypto" in line.lower():
            out.append("-- " + line)
        else:
            out.append(line)
    return "\n".join(out)


class TestResult:
    def __init__(self, name):
        self.name = name
        self.passed = False
        self.details = []
    def ok(self, d=""):
        self.passed = True
        if d: self.details.append(d)
    def fail(self, d):
        self.passed = False
        self.details.append(d)


def main():
    print("=" * 70)
    print("Payout Integration RPCs — Tests")
    print("=" * 70)
    pgdata = tempfile.mkdtemp(prefix="pgdata_payout_", dir="/home/z/my-project")
    srv = pgserver.get_server(pgdata, cleanup_mode="delete")
    srv.ensure_pgdata_inited()
    srv.ensure_postgres_running()
    uri = srv.get_uri()
    print(f"\nPostgres URI: {uri}")

    with psycopg.connect(uri, autocommit=True) as c:
        with c.cursor() as cur:
            cur.execute(ROLES_SQL)
            cur.execute("grant all on schema public to service_role;")
            cur.execute("grant all on all tables in schema public to service_role;")
            cur.execute("grant all on all sequences in schema public to service_role;")
            cur.execute("grant usage, select on all sequences in schema public to service_role;")
        for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
            sql = strip_pgcrypto(f.read_text())
            with c.cursor() as cur:
                cur.execute(sql)
        with c.cursor() as cur:
            cur.execute("grant all on all tables in schema public to service_role;")
            cur.execute("grant all on all sequences in schema public to service_role;")

    print("All migrations applied.")

    results = []
    with psycopg.connect(uri, autocommit=False) as conn:
        cur = conn.cursor()
        # Run tests sequentially. Each test is responsible for committing
        # its setup state before exercising error paths (because raise
        # exceptions abort the transaction, we need to roll back only
        # the failed statement, not the test's prior setup).
        for run_fn in [run_T1, run_T2, run_T3, run_T4, run_T5, run_T6, run_T7, run_T8, run_T9]:
            run_fn(cur, results)
            try:
                conn.commit()
            except Exception:
                conn.rollback()

    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    passed = sum(1 for r in results if r.passed)
    failed = sum(1 for r in results if not r.passed)
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        print(f"\n[{status}] {r.name}")
        for d in r.details:
            print(f"        {d}")
    print(f"\n  PASSED: {passed}    FAILED: {failed}")
    srv.cleanup()
    sys.exit(0 if failed == 0 else 1)


# =====================================================================
# Helpers
# =====================================================================

def make_wallet(cur, addr=None, chain_id=101):
    if addr is None: addr = b58_addr()
    cur.execute(
        "insert into public.wallets (wallet_address, wallet_chain_id) "
        "values (%s, %s) on conflict (wallet_address) do update set updated_at = now() "
        "returning id, wallet_address;",
        (addr, chain_id),
    )
    row = cur.fetchone()
    return {"id": row[0], "wallet_address": row[1]}


def make_verified_swap(cur, wallet_id, wallet_addr, signature=None, volume_usd=20.0):
    if signature is None: signature = b58_sig()
    cur.execute(
        """
        insert into public.swap_transactions
          (signature, transaction_hash, chain_id, provider, wallet_id, wallet_address,
           input_mint, output_mint, input_amount_raw, output_amount_raw,
           input_decimals, output_decimals, timestamp, slot,
           confirmation_status, verification_status, status,
           sell_token_id, buy_token_id, volume_usd)
        values
          (%s, %s, 101, 'jupiter', %s, %s,
           'So11111111111111111111111111111111111111112',
           'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
           '1000000', '1000000', 6, 6, now(), 1,
           'finalized', 'verified', 'CONFIRMED',
           '101:So11111111111111111111111111111111111111112',
           '101:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', %s)
        on conflict (signature) do update set updated_at = now()
        returning signature;
        """,
        (signature, signature, wallet_id, wallet_addr, volume_usd),
    )
    return cur.fetchone()[0]


def activate_season(cur, season_id):
    cur.execute("update public.samurai_seasons set status = 'ENDED', updated_at = now() where status = 'ACTIVE';")
    cur.execute(
        "insert into public.samurai_seasons (id, name, description, start_at, end_at, status, points_enabled, "
        "minimum_qualifying_volume, base_points_per_usd, leaderboard_enabled, multiplier_rules) "
        "values (%s, %s, '', now() - interval '30 days', now() + interval '30 days', 'DRAFT', true, 0, 1, true, '[]'::jsonb) "
        "on conflict (id) do update set status = 'DRAFT', points_enabled = true returning id;",
        (season_id, season_id),
    )
    sid = cur.fetchone()[0]
    cur.execute("update public.samurai_seasons set status = 'ACTIVE' where id = %s;", (sid,))
    return sid


def call_rpc(cur, name, params):
    """Call a service_role RPC. Returns the result (jsonb)."""
    cur.execute("set role service_role;")
    try:
        placeholders = []
        args = []
        for k, v in params.items():
            placeholders.append(f"{k} := %s")
            args.append(v)
        sql = f"select public.{name}({', '.join(placeholders)});"
        cur.execute(sql, args)
        return cur.fetchone()[0]
    finally:
        cur.execute("reset role;")


def call_rpc_expect_error(cur, name, params):
    """Call a service_role RPC expecting it to raise. Uses a savepoint
    so the caller's prior setup (wallet creation, points awarding, etc.)
    is preserved across the failure."""
    conn = cur.connection
    cur.execute("savepoint sp_test;")
    cur.execute("set role service_role;")
    try:
        placeholders = []
        args = []
        for k, v in params.items():
            placeholders.append(f"{k} := %s")
            args.append(v)
        sql = f"select public.{name}({', '.join(placeholders)});"
        cur.execute(sql, args)
        result = cur.fetchone()[0]
        cur.execute("reset role;")
        cur.execute("release savepoint sp_test;")
        return ("OK", result)
    except psycopg.errors.RaiseException as e:
        cur.execute("rollback to savepoint sp_test;")
        return ("ERR", str(e).strip().split("\n")[0].replace("ERROR: ", ""))
    except Exception as e:
        cur.execute("rollback to savepoint sp_test;")
        return ("ERR", str(e))


def award_points(cur, signature, points, season_id):
    cur.execute("set role service_role;")
    try:
        cur.execute(
            "select * from public.award_samurai_points(%s::text, %s::numeric, %s::numeric, 1::numeric, %s::numeric, 'v1-test'::text, %s::text, 'qualified'::text, null);",
            (signature, points, points, points, season_id),
        )
        return cur.fetchone()
    finally:
        cur.execute("reset role;")


def create_entitled_claim(cur, wallet, points=25, claim_id=None):
    """Create a fresh claim (status=ENTITLED) by calling claim_reward RPC."""
    if claim_id is None:
        claim_id = "test-claim-" + secrets.token_hex(8)
    season_id = activate_season(cur, "test-payout-season")
    sig = b58_sig()
    make_verified_swap(cur, wallet["id"], wallet["wallet_address"], sig, points)
    award_points(cur, sig, points, season_id)
    cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true, reward_points_per_unit = 1000 where id = 'default';")
    result = call_rpc(cur, "claim_reward", {
        "p_wallet_address": wallet["wallet_address"],
        "p_claim_id": claim_id,
        "p_points_to_claim": points,
        "p_client_nonce": None,
        "p_metadata": None,
    })
    return result


def get_claimed_points(cur, wallet):
    cur.execute("select claimed_points from public.wallets where id = %s;", (wallet["id"],))
    return float(cur.fetchone()[0])


# =====================================================================
# Tests
# =====================================================================

def run_T1(cur, results):
    """T1: ENTITLED → PENDING_PAYOUT (happy path)."""
    t = TestResult("T1: ENTITLED → PENDING_PAYOUT")
    try:
        w = make_wallet(cur)
        claim = create_entitled_claim(cur, w, points=25)
        assert claim["success"] and claim["claim"]["status"] == "ENTITLED"
        result = call_rpc(cur, "mark_reward_claim_pending_payout", {
            "p_claim_id": claim["claim"]["claim_id"],
        })
        assert result["transitioned"] is True, f"expected transitioned=true, got: {result}"
        assert result["claim"]["status"] == "PENDING_PAYOUT", f"expected PENDING_PAYOUT, got: {result['claim']['status']}"
        # claimed_points should NOT change during this transition (only the FAILED revert path decrements it)
        cl = get_claimed_points(cur, w)
        assert cl == 25.0, f"claimed_points changed unexpectedly: {cl}"
        t.ok(f"transitioned={result['transitioned']}, status={result['claim']['status']}, claimed_points still={cl}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_T2(cur, results):
    """T2: PENDING_PAYOUT → PENDING_PAYOUT (idempotent)."""
    t = TestResult("T2: PENDING_PAYOUT (idempotent)")
    try:
        w = make_wallet(cur)
        claim = create_entitled_claim(cur, w, points=25)
        call_rpc(cur, "mark_reward_claim_pending_payout", {"p_claim_id": claim["claim"]["claim_id"]})
        # Call again — should be idempotent
        result = call_rpc(cur, "mark_reward_claim_pending_payout", {"p_claim_id": claim["claim"]["claim_id"]})
        assert result["transitioned"] is False, f"expected transitioned=false, got: {result}"
        assert result["reason"] == "ALREADY_PENDING", f"expected ALREADY_PENDING, got: {result['reason']}"
        assert result["claim"]["status"] == "PENDING_PAYOUT"
        cl = get_claimed_points(cur, w)
        assert cl == 25.0
        t.ok(f"transitioned={result['transitioned']}, reason={result['reason']}, claimed_points still={cl}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_T3(cur, results):
    """T3: PENDING_PAYOUT → FAILED with claimed_points decremented (rollback)."""
    t = TestResult("T3: PENDING_PAYOUT → FAILED (claimed_points reverted)")
    try:
        w = make_wallet(cur)
        claim = create_entitled_claim(cur, w, points=25)
        call_rpc(cur, "mark_reward_claim_pending_payout", {"p_claim_id": claim["claim"]["claim_id"]})
        # Verify claimed_points is 25 before revert
        cl_before = get_claimed_points(cur, w)
        assert cl_before == 25.0, f"expected 25 before revert, got {cl_before}"
        # Revert
        result = call_rpc(cur, "revert_failed_reward_claim", {
            "p_claim_id": claim["claim"]["claim_id"],
            "p_failure_reason": "SOLANA_TX_FAILED: simulated failure",
        })
        assert result["reverted"] is True, f"expected reverted=true, got: {result}"
        assert result["claim"]["status"] == "FAILED", f"expected FAILED, got: {result['claim']['status']}"
        assert result["claim"]["failure_reason"] == "SOLANA_TX_FAILED: simulated failure"
        assert result["claimed_points_delta"] == -25.0
        # Verify claimed_points was decremented back to 0
        cl_after = get_claimed_points(cur, w)
        assert cl_after == 0.0, f"expected 0 after revert, got {cl_after}"
        t.ok(f"reverted={result['reverted']}, status={result['claim']['status']}, claimed_points: {cl_before} → {cl_after}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_T4(cur, results):
    """T4: FAILED → FAILED (idempotent revert)."""
    t = TestResult("T4: FAILED (idempotent revert)")
    try:
        w = make_wallet(cur)
        claim = create_entitled_claim(cur, w, points=25)
        call_rpc(cur, "mark_reward_claim_pending_payout", {"p_claim_id": claim["claim"]["claim_id"]})
        call_rpc(cur, "revert_failed_reward_claim", {
            "p_claim_id": claim["claim"]["claim_id"],
            "p_failure_reason": "first failure",
        })
        cl_before = get_claimed_points(cur, w)
        # Revert again — should be idempotent (no double-decrement)
        result = call_rpc(cur, "revert_failed_reward_claim", {
            "p_claim_id": claim["claim"]["claim_id"],
            "p_failure_reason": "second failure attempt",
        })
        assert result["reverted"] is False, f"expected reverted=false, got: {result}"
        assert result["reason"] == "ALREADY_FAILED", f"expected ALREADY_FAILED, got: {result['reason']}"
        assert result["claimed_points_delta"] == 0
        cl_after = get_claimed_points(cur, w)
        assert cl_before == cl_after == 0.0, f"claimed_points should be unchanged: before={cl_before} after={cl_after}"
        t.ok(f"reverted={result['reverted']}, reason={result['reason']}, claimed_points stays at {cl_after}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_T5(cur, results):
    """T5: Cannot revert a COMPLETED claim."""
    t = TestResult("T5: Cannot revert COMPLETED claim")
    try:
        w = make_wallet(cur)
        claim = create_entitled_claim(cur, w, points=25)
        call_rpc(cur, "mark_reward_claim_pending_payout", {"p_claim_id": claim["claim"]["claim_id"]})
        # Mark completed (simulating a successful Solana tx)
        call_rpc(cur, "update_reward_claim_status", {
            "p_claim_id": claim["claim"]["claim_id"],
            "p_status": "COMPLETED",
            "p_claim_tx_signature": "fake_solana_signature_" + secrets.token_hex(8),
            "p_failure_reason": None,
        })
        # Try to revert — should be rejected
        status, msg = call_rpc_expect_error(cur, "revert_failed_reward_claim", {
            "p_claim_id": claim["claim"]["claim_id"],
            "p_failure_reason": "trying to revert a completed claim",
        })
        cl = get_claimed_points(cur, w)
        assert status == "ERR" and "CANNOT_REVERT_COMPLETED" in msg, f"expected CANNOT_REVERT_COMPLETED, got: status={status} msg={msg}"
        assert cl == 25.0, f"claimed_points should be unchanged after rejected revert: {cl}"
        t.ok(f"correctly rejected: {msg}, claimed_points still={cl}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_T6(cur, results):
    """T6: mark_pending on a COMPLETED claim returns ALREADY_COMPLETED (idempotent)."""
    t = TestResult("T6: mark_pending on COMPLETED (idempotent)")
    try:
        w = make_wallet(cur)
        claim = create_entitled_claim(cur, w, points=25)
        call_rpc(cur, "mark_reward_claim_pending_payout", {"p_claim_id": claim["claim"]["claim_id"]})
        call_rpc(cur, "update_reward_claim_status", {
            "p_claim_id": claim["claim"]["claim_id"],
            "p_status": "COMPLETED",
            "p_claim_tx_signature": "fake_signature",
            "p_failure_reason": None,
        })
        result = call_rpc(cur, "mark_reward_claim_pending_payout", {"p_claim_id": claim["claim"]["claim_id"]})
        assert result["transitioned"] is False, f"expected transitioned=false, got: {result}"
        assert result["reason"] == "ALREADY_COMPLETED", f"expected ALREADY_COMPLETED, got: {result['reason']}"
        assert result["claim"]["status"] == "COMPLETED"
        t.ok(f"transitioned={result['transitioned']}, reason={result['reason']}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_T7(cur, results):
    """T7: mark_pending on a FAILED claim raises CLAIM_NOT_RESTARTABLE."""
    t = TestResult("T7: mark_pending on FAILED claim")
    try:
        w = make_wallet(cur)
        claim = create_entitled_claim(cur, w, points=25)
        call_rpc(cur, "mark_reward_claim_pending_payout", {"p_claim_id": claim["claim"]["claim_id"]})
        call_rpc(cur, "revert_failed_reward_claim", {
            "p_claim_id": claim["claim"]["claim_id"],
            "p_failure_reason": "first failure",
        })
        # Try to mark_pending again — should fail
        status, msg = call_rpc_expect_error(cur, "mark_reward_claim_pending_payout", {
            "p_claim_id": claim["claim"]["claim_id"],
        })
        assert status == "ERR" and "CLAIM_NOT_RESTARTABLE" in msg, f"expected CLAIM_NOT_RESTARTABLE, got: status={status} msg={msg}"
        t.ok(f"correctly rejected: {msg}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_T8(cur, results):
    """T8: claim_id does not exist → CLAIM_NOT_FOUND."""
    t = TestResult("T8: CLAIM_NOT_FOUND")
    try:
        status, msg = call_rpc_expect_error(cur, "mark_reward_claim_pending_payout", {
            "p_claim_id": "does-not-exist-12345",
        })
        assert status == "ERR" and "CLAIM_NOT_FOUND" in msg, f"expected CLAIM_NOT_FOUND, got: status={status} msg={msg}"
        status2, msg2 = call_rpc_expect_error(cur, "revert_failed_reward_claim", {
            "p_claim_id": "does-not-exist-12345",
        })
        assert status2 == "ERR" and "CLAIM_NOT_FOUND" in msg2, f"expected CLAIM_NOT_FOUND, got: status2={status2} msg2={msg2}"
        t.ok(f"both RPCs reject unknown claim_id: {msg}, {msg2}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_T9(cur, results):
    """T9: After rollback, the user's claimable_points is restored."""
    t = TestResult("T9: claimable_points restored after rollback")
    try:
        w = make_wallet(cur)
        claim = create_entitled_claim(cur, w, points=25)
        # After claim: earned=25, claimed=25, claimable=0
        bal1 = call_rpc(cur, "get_wallet_reward_balance", {"p_wallet_address": w["wallet_address"]})
        assert float(bal1["earned_points"]) == 25.0 and float(bal1["claimed_points"]) == 25.0 and float(bal1["claimable_points"]) == 0.0
        # Mark pending, then revert
        call_rpc(cur, "mark_reward_claim_pending_payout", {"p_claim_id": claim["claim"]["claim_id"]})
        call_rpc(cur, "revert_failed_reward_claim", {
            "p_claim_id": claim["claim"]["claim_id"],
            "p_failure_reason": "simulated",
        })
        # After revert: earned=25, claimed=0, claimable=25
        bal2 = call_rpc(cur, "get_wallet_reward_balance", {"p_wallet_address": w["wallet_address"]})
        assert float(bal2["earned_points"]) == 25.0, f"earned changed unexpectedly: {bal2}"
        assert float(bal2["claimed_points"]) == 0.0, f"claimed should be 0, got: {bal2}"
        assert float(bal2["claimable_points"]) == 25.0, f"claimable should be 25, got: {bal2}"
        t.ok(f"after rollback: earned={bal2['earned_points']} claimed={bal2['claimed_points']} claimable={bal2['claimable_points']}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


if __name__ == "__main__":
    main()
