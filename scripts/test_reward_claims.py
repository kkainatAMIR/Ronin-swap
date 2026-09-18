#!/usr/bin/env python3
"""
Test harness for the reward_claims migration.

Strategy:
  1. Start a real Postgres instance (pgserver embedded).
  2. Create the Supabase roles (anon, authenticated, service_role).
  3. Apply all existing migrations in order, then apply the new
     reward_claims migration.
  4. Run the 12 tests specified in the task brief.
  5. Report PASS/FAIL for each test.
"""

import os
import sys
import json
import tempfile
import traceback
import threading
import time
import secrets
from pathlib import Path

import psycopg
import pgserver

REPO = Path("/home/z/my-project/Ronin-swap")
MIGRATIONS_DIR = REPO / "supabase" / "migrations"
NEW_MIGRATION = "20260917000000_reward_claims.sql"

# ----------------------------------------------------------------------
# Supabase role bootstrap. The migrations issue `revoke ... from anon,
# authenticated` and `grant ... to service_role`. Plain Postgres doesn't
# have these roles by default, so we create them as NOLOGIN roles.
# ----------------------------------------------------------------------
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
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;
"""

# Base58 alphabet (Solana wallet address characters). Excludes 0, O, I, l.
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58_addr(n=44):
    """Return a random valid Solana-style base58 wallet address."""
    return "".join(secrets.choice(B58) for _ in range(n))


def b58_sig(n=80):
    """Return a random valid Solana-style base58 swap signature."""
    return "".join(secrets.choice(B58) for _ in range(n))


def eth_addr():
    """Return a random valid 0x-prefixed Ethereum address."""
    return "0x" + "".join(secrets.choice("0123456789abcdef") for _ in range(40))


def eth_hash():
    """Return a random valid 0x-prefixed Ethereum transaction hash."""
    return "0x" + "".join(secrets.choice("0123456789abcdef") for _ in range(64))


def strip_pgcrypto(sql: str) -> str:
    """The existing migration 20260911000000_verified_swaps.sql starts
    with `create extension if not exists pgcrypto;` but the embedded
    pgserver build doesn't ship pgcrypto. Postgres 16 has gen_random_uuid
    in core, so we can safely comment out the extension line."""
    lines = []
    for line in sql.splitlines():
        if "create extension" in line.lower() and "pgcrypto" in line.lower():
            lines.append("-- " + line + "  [disabled for local test: pgcrypto not bundled]")
        else:
            lines.append(line)
    return "\n".join(lines)


def apply_migrations(conn):
    """Apply every SQL file in the migrations dir, in alphabetical order."""
    files = sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))
    print(f"\nApplying {len(files)} migration files...")
    for fname in files:
        sql = (MIGRATIONS_DIR / fname).read_text()
        sql = strip_pgcrypto(sql)
        with conn.cursor() as cur:
            try:
                cur.execute(sql)
            except Exception as e:
                print(f"  FAIL applying {fname}: {e}")
                raise
        print(f"  OK  {fname}")
    conn.commit()


# ----------------------------------------------------------------------
# Test fixtures
# ----------------------------------------------------------------------

def make_wallet(cur, addr=None, chain_id=101):
    if addr is None:
        addr = b58_addr()
    cur.execute(
        "insert into public.wallets (wallet_address, wallet_chain_id) "
        "values (%s, %s) on conflict (wallet_address) do update set updated_at = now() "
        "returning id, wallet_address;",
        (addr, chain_id),
    )
    row = cur.fetchone()
    return {"id": row[0], "wallet_address": row[1]}


def make_verified_swap(cur, wallet_id, wallet_addr, signature=None, chain_id=101, provider="jupiter",
                       volume_usd=20.0, timestamp=None):
    if signature is None:
        # Solana: base58 32-88 chars. EVM: 0x + 64 hex.
        if chain_id in (1, 4663):
            signature = eth_hash()
        else:
            signature = b58_sig()
    if timestamp is None:
        timestamp_sql = "now()"
    else:
        timestamp_sql = "%s"  # use the param

    input_mint = "So11111111111111111111111111111111111111112"
    output_mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    if chain_id == 1:
        input_mint = "native"
        output_mint = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    elif chain_id == 4663:
        input_mint = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
        output_mint = "0xdac17f958d2ee523a2206206994597c13d831ec7"

    if timestamp is None:
        cur.execute(
            """
            insert into public.swap_transactions
              (signature, transaction_hash, chain_id, provider, wallet_id, wallet_address,
               input_mint, output_mint, input_amount_raw, output_amount_raw,
               input_decimals, output_decimals, timestamp, slot,
               confirmation_status, verification_status, status,
               sell_token_id, buy_token_id, volume_usd)
            values
              (%s, %s, %s, %s, %s, %s,
               %s, %s, '1000000', '1000000', 6, 6, now(), 1,
               'finalized', 'verified', 'CONFIRMED',
               %s || ':' || %s, %s || ':' || %s, %s)
            on conflict (signature) do update set updated_at = now()
            returning signature;
            """,
            (signature, signature, chain_id, provider, wallet_id, wallet_addr,
             input_mint, output_mint, str(chain_id), input_mint,
             str(chain_id), output_mint, volume_usd),
        )
    else:
        cur.execute(
            """
            insert into public.swap_transactions
              (signature, transaction_hash, chain_id, provider, wallet_id, wallet_address,
               input_mint, output_mint, input_amount_raw, output_amount_raw,
               input_decimals, output_decimals, timestamp, slot,
               confirmation_status, verification_status, status,
               sell_token_id, buy_token_id, volume_usd)
            values
              (%s, %s, %s, %s, %s, %s,
               %s, %s, '1000000', '1000000', 6, 6, %s, 1,
               'finalized', 'verified', 'CONFIRMED',
               %s || ':' || %s, %s || ':' || %s, %s)
            on conflict (signature) do update set updated_at = now()
            returning signature;
            """,
            (signature, signature, chain_id, provider, wallet_id, wallet_addr,
             input_mint, output_mint, timestamp, str(chain_id), input_mint,
             str(chain_id), output_mint, volume_usd),
        )
    return cur.fetchone()[0]


def call_award_points(cur, signature, final_points, qualifying_volume, season_id=None,
                     rule_version="v1-test", eligibility="qualified"):
    """Call public.award_samurai_points with explicit numeric casts so
    psycopg3 doesn't infer smallint."""
    cur.execute(
        """
        select * from public.award_samurai_points(
          %s::text,
          %s::numeric,
          %s::numeric,
          %s::numeric,
          %s::numeric,
          %s::text,
          %s::text,
          %s::text,
          %s::text
        );
        """,
        (signature, qualifying_volume, final_points, 1.0, final_points,
         rule_version, season_id, eligibility, None),
    )
    return cur.fetchone()


def call_claim_reward(cur, wallet_addr, claim_id, points_to_claim=None):
    cur.execute("set role service_role;")
    try:
        cur.execute(
            "select public.claim_reward(%s, %s, %s::numeric, %s, %s);",
            (wallet_addr, claim_id, points_to_claim, None, None),
        )
        result = cur.fetchone()[0]
        return result
    except Exception:
        # The transaction may be aborted after a raise_exception inside the
        # SECURITY DEFINER function. Roll back so the cursor is usable again.
        raise
    finally:
        # Try to reset the role, but if the transaction is aborted we
        # must rollback first; otherwise the RESET ROLE will fail too.
        try:
            cur.execute("reset role;")
        except psycopg.errors.InFailedSqlTransaction:
            cur.execute("rollback;")
            cur.execute("reset role;")


def call_claim_reward_expect_error(cur, wallet_addr, claim_id, points_to_claim=None):
    try:
        result = call_claim_reward(cur, wallet_addr, claim_id, points_to_claim)
        return ("OK", result)
    except psycopg.errors.RaiseException as e:
        # The RPC raised via PL/pgSQL `raise exception`. The transaction
        # is now aborted; rollback so subsequent queries work.
        try:
            cur.execute("rollback;")
        except Exception:
            pass
        return ("ERR", str(e).strip().split("\n")[0].replace("ERROR: ", ""))
    except psycopg.errors.OperationalError as e:
        try:
            cur.execute("rollback;")
        except Exception:
            pass
        return ("ERR", str(e).strip().split("\n")[0])
    except Exception as e:
        try:
            cur.execute("rollback;")
        except Exception:
            pass
        return ("ERR", str(e))


def get_wallet_balance(cur, wallet_addr):
    cur.execute("set role service_role;")
    try:
        cur.execute("select public.get_wallet_reward_balance(%s);", (wallet_addr,))
        return cur.fetchone()[0]
    finally:
        cur.execute("reset role;")


def activate_season(cur, season_id, name=None, start_offset_days=-30, end_offset_days=30):
    """Mimic the admin 'activate' action: end any existing active season
    first, then set the new one to ACTIVE. The DB has a partial unique
    index on (status) where status = 'ACTIVE' that prevents two active
    seasons concurrently."""
    if name is None:
        name = season_id
    # End any currently-active season first
    cur.execute("update public.samurai_seasons set status = 'ENDED', updated_at = now() where status = 'ACTIVE';")
    cur.execute(
        "insert into public.samurai_seasons (id, name, description, start_at, end_at, status, points_enabled, "
        "minimum_qualifying_volume, base_points_per_usd, leaderboard_enabled, multiplier_rules) "
        "values (%s, %s, '', now() - interval '%s days', now() + interval '%s days', 'DRAFT', true, 0, 1, true, '[]'::jsonb) "
        "on conflict (id) do update set status = 'DRAFT', start_at = now() - interval '%s days', "
        "end_at = now() + interval '%s days', points_enabled = true "
        "returning id;",
        (season_id, name, start_offset_days, end_offset_days, start_offset_days, end_offset_days),
    )
    sid = cur.fetchone()[0]
    cur.execute("update public.samurai_seasons set status = 'ACTIVE' where id = %s;", (sid,))
    return sid


def end_active_season(cur):
    cur.execute("update public.samurai_seasons set status = 'ENDED', updated_at = now() where status = 'ACTIVE';")


# ----------------------------------------------------------------------
# Test definitions
# ----------------------------------------------------------------------

class TestResult:
    def __init__(self, name):
        self.name = name
        self.passed = False
        self.details = []

    def ok(self, detail=""):
        self.passed = True
        if detail:
            self.details.append(detail)

    def fail(self, detail):
        self.passed = False
        self.details.append(detail)


def run_test_1(cur, results):
    """TEST 1: Existing verified swap still awards Samurai Points exactly as before."""
    t = TestResult("TEST 1: verified swap awards Samurai Points")
    try:
        w = make_wallet(cur)
        season_id = activate_season(cur, "test-t1")
        sig = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig, volume_usd=25.0)
        row = call_award_points(cur, sig, final_points=25, qualifying_volume=25, season_id=season_id)
        inserted = row[0]
        awarded = float(row[7])
        lifetime = float(row[9])
        if inserted and awarded == 25.0 and lifetime == 25.0:
            t.ok(f"inserted={inserted} awarded={awarded} lifetime={lifetime}")
        else:
            t.fail(f"unexpected row: inserted={inserted} awarded={awarded} lifetime={lifetime}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_test_2(cur, results):
    """TEST 2: Same swap signature cannot award points twice."""
    t = TestResult("TEST 2: same signature cannot award points twice")
    try:
        w = make_wallet(cur)
        season_id = activate_season(cur, "test-t2")
        sig = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig, volume_usd=20.0)
        row1 = call_award_points(cur, sig, final_points=20, qualifying_volume=20, season_id=season_id)
        row2 = call_award_points(cur, sig, final_points=20, qualifying_volume=20, season_id=season_id)
        inserted1 = row1[0]
        inserted2 = row2[0]
        lifetime = float(row2[9])
        if inserted1 and not inserted2 and lifetime == 20.0:
            t.ok(f"first inserted={inserted1}, second inserted={inserted2}, lifetime={lifetime}")
        else:
            t.fail(f"first={inserted1} second={inserted2} lifetime={lifetime}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_test_3(cur, results):
    """TEST 3: User has 25 earned points, 0 claimed → claimable = 25."""
    t = TestResult("TEST 3: 25 earned, 0 claimed, claimable = 25")
    try:
        w = make_wallet(cur)
        season_id = activate_season(cur, "test-t3")
        sig = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig, volume_usd=25.0)
        call_award_points(cur, sig, final_points=25, qualifying_volume=25, season_id=season_id)
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true where id = 'default';")
        bal = get_wallet_balance(cur, w["wallet_address"])
        if (float(bal["earned_points"]) == 25.0 and
                float(bal["claimed_points"]) == 0.0 and
                float(bal["claimable_points"]) == 25.0):
            t.ok(f"earned={bal['earned_points']} claimed={bal['claimed_points']} claimable={bal['claimable_points']}")
        else:
            t.fail(f"unexpected balance: {bal}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_test_4(cur, results):
    """TEST 4: User claims 25 → earned=25, claimed=25, claimable=0."""
    t = TestResult("TEST 4: claim 25 → claimed=25, claimable=0")
    try:
        w = make_wallet(cur)
        season_id = activate_season(cur, "test-t4")
        sig = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig, volume_usd=25.0)
        call_award_points(cur, sig, final_points=25, qualifying_volume=25, season_id=season_id)
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true, reward_points_per_unit = 1000 where id = 'default';")
        result = call_claim_reward(cur, w["wallet_address"], "t4-claim-001", points_to_claim=25)
        if result["success"] and not result["idempotent"]:
            bal = get_wallet_balance(cur, w["wallet_address"])
            if (float(bal["earned_points"]) == 25.0 and
                    float(bal["claimed_points"]) == 25.0 and
                    float(bal["claimable_points"]) == 0.0):
                t.ok(f"earned={bal['earned_points']} claimed={bal['claimed_points']} claimable={bal['claimable_points']}")
            else:
                t.fail(f"balance wrong after claim: {bal}")
        else:
            t.fail(f"claim_reward returned: {result}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_test_5(cur, results):
    """TEST 5: User earns 15 more → earned=40, claimed=25, claimable=15."""
    t = TestResult("TEST 5: earn 15 more → earned=40, claimed=25, claimable=15")
    try:
        w = make_wallet(cur)
        season_id = activate_season(cur, "test-t5")
        sig1 = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig1, volume_usd=25.0)
        call_award_points(cur, sig1, final_points=25, qualifying_volume=25, season_id=season_id)
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true, reward_points_per_unit = 1000 where id = 'default';")
        call_claim_reward(cur, w["wallet_address"], "t5-claim-001", points_to_claim=25)
        sig2 = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig2, volume_usd=15.0)
        call_award_points(cur, sig2, final_points=15, qualifying_volume=15, season_id=season_id)
        bal = get_wallet_balance(cur, w["wallet_address"])
        if (float(bal["earned_points"]) == 40.0 and
                float(bal["claimed_points"]) == 25.0 and
                float(bal["claimable_points"]) == 15.0):
            t.ok(f"earned={bal['earned_points']} claimed={bal['claimed_points']} claimable={bal['claimable_points']}")
        else:
            t.fail(f"balance wrong: {bal}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_test_6(cur, results):
    """TEST 6: User claims 15 → earned=40, claimed=40, claimable=0."""
    t = TestResult("TEST 6: claim 15 → claimed=40, claimable=0")
    try:
        w = make_wallet(cur)
        season_id = activate_season(cur, "test-t6")
        sig1 = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig1, volume_usd=25.0)
        call_award_points(cur, sig1, final_points=25, qualifying_volume=25, season_id=season_id)
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true, reward_points_per_unit = 1000 where id = 'default';")
        call_claim_reward(cur, w["wallet_address"], "t6-claim-001", points_to_claim=25)
        sig2 = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig2, volume_usd=15.0)
        call_award_points(cur, sig2, final_points=15, qualifying_volume=15, season_id=season_id)
        result = call_claim_reward(cur, w["wallet_address"], "t6-claim-002", points_to_claim=15)
        bal = get_wallet_balance(cur, w["wallet_address"])
        if (result["success"] and
                float(bal["earned_points"]) == 40.0 and
                float(bal["claimed_points"]) == 40.0 and
                float(bal["claimable_points"]) == 0.0):
            t.ok(f"earned={bal['earned_points']} claimed={bal['claimed_points']} claimable={bal['claimable_points']}")
        else:
            t.fail(f"unexpected: result={result} balance={bal}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_test_7(cur, results):
    """TEST 7: Attempt to claim more than claimable → rejected, no state change."""
    t = TestResult("TEST 7: claim > claimable → rejected")
    try:
        w = make_wallet(cur)
        season_id = activate_season(cur, "test-t7")
        sig = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig, volume_usd=10.0)
        call_award_points(cur, sig, final_points=10, qualifying_volume=10, season_id=season_id)
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true, reward_points_per_unit = 1000 where id = 'default';")
        status, msg = call_claim_reward_expect_error(cur, w["wallet_address"], "t7-claim-001", points_to_claim=50)
        bal = get_wallet_balance(cur, w["wallet_address"])
        cur.execute("select count(*) from public.reward_claims where wallet_id = %s;", (w["id"],))
        claim_count = cur.fetchone()[0]
        if status == "ERR" and "INSUFFICIENT_CLAIMABLE_POINTS" in msg:
            if float(bal["claimed_points"]) == 0.0 and claim_count == 0:
                t.ok(f"correctly rejected: {msg}; claimed_points={bal['claimed_points']}; claim_rows={claim_count}")
            else:
                t.fail(f"rejected but state changed: claimed={bal['claimed_points']} rows={claim_count}")
        else:
            t.fail(f"should have been rejected: status={status} msg={msg}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_test_8(cur, results):
    """TEST 8: Submit same claim_id twice → claimed_points increments only once."""
    t = TestResult("TEST 8: duplicate claim_id → idempotent")
    try:
        w = make_wallet(cur)
        season_id = activate_season(cur, "test-t8")
        sig = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig, volume_usd=25.0)
        call_award_points(cur, sig, final_points=25, qualifying_volume=25, season_id=season_id)
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true, reward_points_per_unit = 1000 where id = 'default';")
        result1 = call_claim_reward(cur, w["wallet_address"], "t8-duplicate-claim", points_to_claim=25)
        result2 = call_claim_reward(cur, w["wallet_address"], "t8-duplicate-claim", points_to_claim=25)
        bal = get_wallet_balance(cur, w["wallet_address"])
        cur.execute("select count(*) from public.reward_claims where claim_id = 't8-duplicate-claim';")
        dup_count = cur.fetchone()[0]
        if (result1["success"] and not result1["idempotent"]
                and result2["success"] and result2["idempotent"]
                and float(bal["claimed_points"]) == 25.0
                and dup_count == 1):
            t.ok(f"first new, second idempotent; claimed={bal['claimed_points']}; dup_rows={dup_count}")
        else:
            t.fail(f"result1={result1}\nresult2={result2}\nbal={bal}\ndup_count={dup_count}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_test_9(cur, results, conn, db_uri):
    """TEST 9: Two concurrent claims cannot spend the same claimable balance."""
    t = TestResult("TEST 9: concurrent claims cannot double-spend")
    try:
        w = make_wallet(cur)
        season_id = activate_season(cur, "test-t9")
        sig = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig, volume_usd=25.0)
        call_award_points(cur, sig, final_points=25, qualifying_volume=25, season_id=season_id)
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true, reward_points_per_unit = 1000 where id = 'default';")
        conn.commit()

        results_box = {}
        barrier = threading.Barrier(2)
        errors = []

        def worker_with_uri(label, claim_id):
            try:
                with psycopg.connect(db_uri, autocommit=False) as wconn:
                    barrier.wait()  # ensure both threads hit the RPC at the same time
                    with wconn.cursor() as wcur:
                        wcur.execute("set role service_role;")
                        try:
                            wcur.execute(
                                "select public.claim_reward(%s, %s, 25::numeric, %s, %s);",
                                (w["wallet_address"], claim_id, None, None),
                            )
                            row = wcur.fetchone()[0]
                            results_box[label] = ("OK", row)
                            wconn.commit()
                        except psycopg.errors.RaiseException as e:
                            wconn.rollback()
                            results_box[label] = ("ERR", str(e).strip().split("\n")[0].replace("ERROR: ", ""))
                        except Exception as e:
                            wconn.rollback()
                            results_box[label] = ("ERR", str(e))
            except Exception as e:
                errors.append((label, str(e)))
                results_box[label] = ("ERR", str(e))

        threads = [
            threading.Thread(target=worker_with_uri, args=("A", "t9-claim-a")),
            threading.Thread(target=worker_with_uri, args=("B", "t9-claim-b")),
        ]
        for th in threads:
            th.start()
        for th in threads:
            th.join()

        bal = get_wallet_balance(cur, w["wallet_address"])
        cur.execute("select count(*) from public.reward_claims where wallet_id = %s;", (w["id"],))
        claim_count = cur.fetchone()[0]

        ok_count = sum(1 for v in results_box.values() if v[0] == "OK")
        err_count = sum(1 for v in results_box.values() if v[0] == "ERR")
        if ok_count == 1 and err_count == 1 and float(bal["claimed_points"]) == 25.0 and claim_count == 1:
            t.ok(f"OK={ok_count} ERR={err_count} claimed={bal['claimed_points']} rows={claim_count}; details={results_box}")
        else:
            t.fail(f"OK={ok_count} ERR={err_count} claimed={bal['claimed_points']} rows={claim_count}; details={results_box}; errors={errors}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_test_10(cur, results, conn):
    """TEST 10: Rewards OFF → existing points/claims/claimable remain."""
    t = TestResult("TEST 10: Rewards OFF preserves historical data")
    try:
        w = make_wallet(cur)
        season_id = activate_season(cur, "test-t10")
        sig = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig, volume_usd=30.0)
        call_award_points(cur, sig, final_points=30, qualifying_volume=30, season_id=season_id)
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true, reward_points_per_unit = 1000 where id = 'default';")
        call_claim_reward(cur, w["wallet_address"], "t10-claim-001", points_to_claim=10)
        bal_before = get_wallet_balance(cur, w["wallet_address"])
        cur.execute("select count(*) from public.reward_claims where wallet_id = %s;", (w["id"],))
        claim_rows_before = cur.fetchone()[0]
        cur.execute("select lifetime_points, claimed_points from public.wallets where id = %s;", (w["id"],))
        lt_before, cl_before = cur.fetchone()

        # Turn Rewards OFF (sol_rewards_enabled = false AND end the active season)
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = false where id = 'default';")
        end_active_season(cur)
        conn.commit()

        # Attempt a new claim — should be rejected
        status, msg = call_claim_reward_expect_error(cur, w["wallet_address"], "t10-claim-002", points_to_claim=20)
        bal_after = get_wallet_balance(cur, w["wallet_address"])
        cur.execute("select count(*) from public.reward_claims where wallet_id = %s;", (w["id"],))
        claim_rows_after = cur.fetchone()[0]
        cur.execute("select lifetime_points, claimed_points from public.wallets where id = %s;", (w["id"],))
        lt_after, cl_after = cur.fetchone()

        checks = [
            ("rewards disabled rejects new claim", status == "ERR" and ("REWARDS_DISABLED" in msg or "NO_ACTIVE_SEASON" in msg)),
            ("lifetime_points preserved", float(lt_before) == float(lt_after)),
            ("claimed_points preserved", float(cl_before) == float(cl_after)),
            ("claim_rows preserved", claim_rows_before == claim_rows_after),
            ("earned_points preserved", float(bal_before["earned_points"]) == float(bal_after["earned_points"])),
            ("claimable preserved", float(bal_before["claimable_points"]) == float(bal_after["claimable_points"])),
            ("recent_claims preserved", len(bal_after["recent_claims"]) == claim_rows_after),
        ]
        failures = [c[0] for c in checks if not c[1]]
        if not failures:
            t.ok(f"status={status} msg={msg} claims_before={claim_rows_before} claims_after={claim_rows_after} lifetime={lt_after} claimed={cl_after}")
        else:
            t.fail(f"failed checks: {failures}; bal_before={bal_before} bal_after={bal_after} status={status} msg={msg}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_test_11(cur, results, conn):
    """TEST 11: Rewards ON again preserves accounting, new earning follows existing season rules."""
    t = TestResult("TEST 11: Rewards ON again preserves accounting")
    try:
        w = make_wallet(cur)
        season1 = activate_season(cur, "test-t11-s1")
        sig1 = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig1, volume_usd=25.0)
        call_award_points(cur, sig1, final_points=25, qualifying_volume=25, season_id=season1)
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true, reward_points_per_unit = 1000 where id = 'default';")
        call_claim_reward(cur, w["wallet_address"], "t11-claim-001", points_to_claim=10)

        # Turn Rewards OFF
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = false where id = 'default';")
        end_active_season(cur)
        conn.commit()
        bal_off = get_wallet_balance(cur, w["wallet_address"])

        # Turn Rewards ON again — activate a NEW season via existing mechanism
        activate_season(cur, "test-t11-s2")
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true where id = 'default';")
        conn.commit()
        bal_on = get_wallet_balance(cur, w["wallet_address"])

        # New earning
        sig2 = b58_sig()
        make_verified_swap(cur, w["id"], w["wallet_address"], sig2, volume_usd=15.0)
        call_award_points(cur, sig2, final_points=15, qualifying_volume=15, season_id="test-t11-s2")
        bal_final = get_wallet_balance(cur, w["wallet_address"])

        checks = [
            ("earned preserved across OFF/ON", float(bal_off["earned_points"]) == 25.0 and float(bal_on["earned_points"]) == 25.0),
            ("claimed preserved across OFF/ON", float(bal_off["claimed_points"]) == 10.0 and float(bal_on["claimed_points"]) == 10.0),
            ("new points accrue after Rewards ON", float(bal_final["earned_points"]) == 40.0),
            ("claimed unchanged after earning", float(bal_final["claimed_points"]) == 10.0),
            ("claimable updated correctly", float(bal_final["claimable_points"]) == 30.0),
            ("has_active_season true after ON", bal_final["has_active_season"] is True),
            ("rewards_enabled true after ON", bal_final["rewards_enabled"] is True),
        ]
        failures = [c[0] for c in checks if not c[1]]
        if not failures:
            t.ok(f"bal_off={bal_off} bal_final={bal_final}")
        else:
            t.fail(f"failed checks: {failures}; bal_off={bal_off} bal_final={bal_final}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


def run_test_12(cur, results):
    """TEST 12: Points from Solana, Ethereum, and Robinhood remain unified."""
    t = TestResult("TEST 12: cross-chain points unified")
    try:
        addr_sol = b58_addr()
        addr_eth = eth_addr()
        addr_rbh = b58_addr()  # Robinhood uses Arbitrum/L2 EOA under the hood

        season_id = activate_season(cur, "test-t12")
        cur.execute("update public.samurai_admin_settings set sol_rewards_enabled = true, reward_points_per_unit = 1000 where id = 'default';")

        # Solana swap → 10 points (chain_id=101)
        w_sol = make_wallet(cur, addr_sol, chain_id=101)
        sig_sol = b58_sig()
        make_verified_swap(cur, w_sol["id"], addr_sol, sig_sol, chain_id=101, provider="jupiter", volume_usd=10.0)
        call_award_points(cur, sig_sol, final_points=10, qualifying_volume=10, season_id=season_id)

        # Ethereum swap → 8 points (chain_id=1)
        w_eth = make_wallet(cur, addr_eth, chain_id=1)
        sig_eth = eth_hash()
        make_verified_swap(cur, w_eth["id"], addr_eth, sig_eth, chain_id=1, provider="0x", volume_usd=8.0)
        call_award_points(cur, sig_eth, final_points=8, qualifying_volume=8, season_id=season_id)

        # Robinhood/LI.FI swap → 7 points (chain_id=4663)
        w_rbh = make_wallet(cur, addr_rbh, chain_id=4663)
        sig_rbh = eth_hash()
        make_verified_swap(cur, w_rbh["id"], addr_rbh, sig_rbh, chain_id=4663, provider="lifi", volume_usd=7.0)
        call_award_points(cur, sig_rbh, final_points=7, qualifying_volume=7, season_id=season_id)

        bal_sol = get_wallet_balance(cur, addr_sol)
        bal_eth = get_wallet_balance(cur, addr_eth)
        bal_rbh = get_wallet_balance(cur, addr_rbh)

        checks = [
            ("Solana wallet earned=10", float(bal_sol["earned_points"]) == 10.0),
            ("Ethereum wallet earned=8", float(bal_eth["earned_points"]) == 8.0),
            ("Robinhood wallet earned=7", float(bal_rbh["earned_points"]) == 7.0),
            ("Solana claimable=10 (no claims yet)", float(bal_sol["claimable_points"]) == 10.0),
            ("Ethereum claimable=8", float(bal_eth["claimable_points"]) == 8.0),
            ("Robinhood claimable=7", float(bal_rbh["claimable_points"]) == 7.0),
            ("Solana has single claimed_points field (not per-chain)", "claimed_points" in bal_sol and "chain_claimed_points" not in bal_sol),
        ]
        # Now claim on Solana wallet, verify Ethereum/Robinhood unaffected
        call_claim_reward(cur, addr_sol, "t12-sol-claim-001", points_to_claim=4)
        bal_sol2 = get_wallet_balance(cur, addr_sol)
        bal_eth2 = get_wallet_balance(cur, addr_eth)
        bal_rbh2 = get_wallet_balance(cur, addr_rbh)
        checks.extend([
            ("Solana claimed=4 after claim", float(bal_sol2["claimed_points"]) == 4.0),
            ("Solana claimable=6 after claim", float(bal_sol2["claimable_points"]) == 6.0),
            ("Ethereum unaffected by Solana claim", float(bal_eth2["claimed_points"]) == 0.0 and float(bal_eth2["claimable_points"]) == 8.0),
            ("Robinhood unaffected by Solana claim", float(bal_rbh2["claimed_points"]) == 0.0 and float(bal_rbh2["claimable_points"]) == 7.0),
        ])
        failures = [c[0] for c in checks if not c[1]]
        if not failures:
            t.ok(f"sol={bal_sol2} eth={bal_eth2} rbh={bal_rbh2}")
        else:
            t.fail(f"failed checks: {failures}; sol={bal_sol2} eth={bal_eth2} rbh={bal_rbh2}")
    except Exception as e:
        t.fail(f"EXCEPTION: {e}\n{traceback.format_exc()}")
    results.append(t)


# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------

def main():
    print("=" * 70)
    print("Reward Claims Migration — Local Postgres Test Harness")
    print("=" * 70)

    pgdata = tempfile.mkdtemp(prefix="pgdata_reward_", dir="/home/z/my-project")
    print(f"\n[1/4] Starting embedded Postgres at {pgdata}")
    srv = pgserver.get_server(pgdata, cleanup_mode="delete")
    srv.ensure_pgdata_inited()
    srv.ensure_postgres_running()
    uri = srv.get_uri()
    print(f"      URI: {uri}")

    print("\n[2/4] Creating Supabase roles (anon, authenticated, service_role)")
    with psycopg.connect(uri, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(ROLES_SQL)
        print("      Roles ready.")

    print("\n[3/4] Applying all migrations in order")
    with psycopg.connect(uri, autocommit=False) as conn:
        apply_migrations(conn)
    print("      All migrations applied successfully.")

    print("\n[4/4] Running tests 1..12")
    results = []
    with psycopg.connect(uri, autocommit=False) as conn:
        cur = conn.cursor()
        run_test_1(cur, results); conn.commit()
        run_test_2(cur, results); conn.commit()
        run_test_3(cur, results); conn.commit()
        run_test_4(cur, results); conn.commit()
        run_test_5(cur, results); conn.commit()
        run_test_6(cur, results); conn.commit()
        run_test_7(cur, results); conn.commit()
        run_test_8(cur, results); conn.commit()
        run_test_9(cur, results, conn, uri); conn.commit()
        run_test_10(cur, results, conn); conn.commit()
        run_test_11(cur, results, conn); conn.commit()
        run_test_12(cur, results); conn.commit()

    print("\n" + "=" * 70)
    print("TEST SUMMARY")
    print("=" * 70)
    pass_count = 0
    fail_count = 0
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        print(f"\n[{status}] {r.name}")
        for d in r.details:
            print(f"        {d}")
        if r.passed:
            pass_count += 1
        else:
            fail_count += 1
    print("\n" + "=" * 70)
    print(f"  PASSED: {pass_count}    FAILED: {fail_count}")
    print("=" * 70)

    srv.cleanup()

    sys.exit(0 if fail_count == 0 else 1)


if __name__ == "__main__":
    main()
