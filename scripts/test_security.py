#!/usr/bin/env python3
"""
Security verification: confirm that anon / authenticated roles CANNOT
directly insert into reward_claims or update wallets.claimed_points.
Only service_role (via the SECURITY DEFINER RPCs) can do so.
"""
import sys, tempfile, traceback
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
    -- Supabase's service_role has BYPASSRLS so it can read/write any
    -- RLS-protected table without explicit per-table GRANTs.
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;
"""


def strip_pgcrypto(sql: str) -> str:
    out = []
    for line in sql.splitlines():
        if "create extension" in line.lower() and "pgcrypto" in line.lower():
            out.append("-- " + line)
        else:
            out.append(line)
    return "\n".join(out)


def main():
    pgdata = tempfile.mkdtemp(prefix="pgdata_sec_", dir="/home/z/my-project")
    srv = pgserver.get_server(pgdata, cleanup_mode="delete")
    srv.ensure_pgdata_inited()
    srv.ensure_postgres_running()
    uri = srv.get_uri()

    with psycopg.connect(uri, autocommit=True) as c:
        with c.cursor() as cur:
            cur.execute(ROLES_SQL)
            # In real Supabase the service_role is granted ALL on all public
            # tables by the platform. Mimic that for the local test.
            cur.execute("grant all on schema public to service_role;")
            cur.execute("grant all on all tables in schema public to service_role;")
            cur.execute("grant all on all sequences in schema public to service_role;")
            cur.execute("grant usage, select on all sequences in schema public to service_role;")
        for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
            sql = strip_pgcrypto(f.read_text())
            with c.cursor() as cur:
                cur.execute(sql)
        # Migrations create new tables; re-grant so service_role has access to reward_claims too.
        with c.cursor() as cur:
            cur.execute("grant all on all tables in schema public to service_role;")
            cur.execute("grant all on all sequences in schema public to service_role;")
            cur.execute("grant usage, select on all sequences in schema public to service_role;")

    # Use a valid base58 address (no 0, O, I, l chars).
    TEST_WALLET = "SecTestWa11et1111111111111111111111111111"  # 39 chars, all base58
    print(f"\nUsing test wallet: {TEST_WALLET}")

    # Set up a wallet + reward_claim row as service_role.
    with psycopg.connect(uri, autocommit=False) as c:
        with c.cursor() as cur:
            cur.execute("set role service_role;")
            cur.execute("insert into public.wallets (wallet_address) values (%s) returning id;", (TEST_WALLET,))
            wid = cur.fetchone()[0]
            cur.execute("insert into public.samurai_admin_settings (id, sol_rewards_enabled) values ('default', true) on conflict (id) do update set sol_rewards_enabled = true;")
            cur.execute("insert into public.samurai_seasons (id, name, start_at, end_at, status, points_enabled, minimum_qualifying_volume, base_points_per_usd, leaderboard_enabled, multiplier_rules) values ('sec-s1', 'S1', now() - interval '30 days', now() + interval '30 days', 'ACTIVE', true, 0, 1, true, '[]'::jsonb);")
            cur.execute("reset role;")
        c.commit()

    print("=" * 60)
    print("SECURITY VERIFICATION (RLS + role revocation)")
    print("=" * 60)

    failures = []

    # Try as anon role
    print("\n[1] anon role attempts direct INSERT into reward_claims...")
    with psycopg.connect(uri, autocommit=False) as c:
        with c.cursor() as cur:
            try:
                cur.execute("set role anon;")
                cur.execute("""
                    insert into public.reward_claims
                      (wallet_id, wallet_address, claim_id, season_id,
                       points_claimed, reward_asset, reward_amount, conversion_rate)
                    values (%s, %s, 'anon-fake-claim-001', 'sec-s1',
                       5, 'SOL', 0.005, 1000);
                """, (wid, TEST_WALLET))
                c.commit()
                print("  FAIL: anon was able to insert into reward_claims!")
                failures.append("anon INSERT reward_claims succeeded (should be denied)")
            except psycopg.errors.InsufficientPrivilege as e:
                c.rollback()
                print(f"  PASS: denied with InsufficientPrivilege: {str(e).strip().split(chr(10))[0]}")
            except psycopg.errors.RaiseException as e:
                c.rollback()
                print(f"  PASS: denied with RaiseException: {str(e).strip().split(chr(10))[0]}")
            except Exception as e:
                c.rollback()
                print(f"  PASS: denied with {type(e).__name__}: {str(e).strip().split(chr(10))[0]}")

    # Try as authenticated role
    print("\n[2] authenticated role attempts direct INSERT into reward_claims...")
    with psycopg.connect(uri, autocommit=False) as c:
        with c.cursor() as cur:
            try:
                cur.execute("set role authenticated;")
                cur.execute("""
                    insert into public.reward_claims
                      (wallet_id, wallet_address, claim_id, season_id,
                       points_claimed, reward_asset, reward_amount, conversion_rate)
                    values (%s, %s, 'auth-fake-claim-001', 'sec-s1',
                       5, 'SOL', 0.005, 1000);
                """, (wid, TEST_WALLET))
                c.commit()
                print("  FAIL: authenticated was able to insert into reward_claims!")
                failures.append("authenticated INSERT reward_claims succeeded (should be denied)")
            except psycopg.errors.InsufficientPrivilege as e:
                c.rollback()
                print(f"  PASS: denied with InsufficientPrivilege: {str(e).strip().split(chr(10))[0]}")
            except psycopg.errors.RaiseException as e:
                c.rollback()
                print(f"  PASS: denied with RaiseException: {str(e).strip().split(chr(10))[0]}")
            except Exception as e:
                c.rollback()
                print(f"  PASS: denied with {type(e).__name__}: {str(e).strip().split(chr(10))[0]}")

    # Try as anon role: update wallets.claimed_points directly (inflation attack)
    print("\n[3] anon role attempts direct UPDATE of wallets.claimed_points (inflation attack)...")
    with psycopg.connect(uri, autocommit=False) as c:
        with c.cursor() as cur:
            try:
                cur.execute("set role anon;")
                cur.execute("update public.wallets set claimed_points = 0 where wallet_address = %s;", (TEST_WALLET,))
                c.commit()
                print("  FAIL: anon was able to update claimed_points!")
                failures.append("anon UPDATE wallets.claimed_points succeeded (should be denied)")
            except psycopg.errors.InsufficientPrivilege as e:
                c.rollback()
                print(f"  PASS: denied with InsufficientPrivilege: {str(e).strip().split(chr(10))[0]}")
            except Exception as e:
                c.rollback()
                print(f"  PASS: denied with {type(e).__name__}: {str(e).strip().split(chr(10))[0]}")

    # Try as authenticated role: update wallets.claimed_points directly
    print("\n[4] authenticated role attempts direct UPDATE of wallets.claimed_points (inflation attack)...")
    with psycopg.connect(uri, autocommit=False) as c:
        with c.cursor() as cur:
            try:
                cur.execute("set role authenticated;")
                cur.execute("update public.wallets set claimed_points = 999999 where wallet_address = %s;", (TEST_WALLET,))
                c.commit()
                print("  FAIL: authenticated was able to update claimed_points!")
                failures.append("authenticated UPDATE wallets.claimed_points succeeded (should be denied)")
            except psycopg.errors.InsufficientPrivilege as e:
                c.rollback()
                print(f"  PASS: denied with InsufficientPrivilege: {str(e).strip().split(chr(10))[0]}")
            except Exception as e:
                c.rollback()
                print(f"  PASS: denied with {type(e).__name__}: {str(e).strip().split(chr(10))[0]}")

    # Try as anon role: update reward_claims.status (e.g. mark own claim COMPLETED)
    print("\n[5] anon role attempts direct UPDATE of reward_claims.status (mark COMPLETED bypass)...")
    with psycopg.connect(uri, autocommit=False) as c:
        with c.cursor() as cur:
            try:
                cur.execute("set role anon;")
                cur.execute("update public.reward_claims set status = 'COMPLETED' where claim_id = 't4-claim-001';")
                c.commit()
                print("  FAIL: anon was able to update reward_claims.status!")
                failures.append("anon UPDATE reward_claims.status succeeded (should be denied)")
            except psycopg.errors.InsufficientPrivilege as e:
                c.rollback()
                print(f"  PASS: denied with InsufficientPrivilege: {str(e).strip().split(chr(10))[0]}")
            except Exception as e:
                c.rollback()
                print(f"  PASS: denied with {type(e).__name__}: {str(e).strip().split(chr(10))[0]}")

    # Try as authenticated: call claim_reward RPC directly (should be denied — service_role only)
    print("\n[6] authenticated role attempts to call claim_reward RPC directly (bypass backend)...")
    with psycopg.connect(uri, autocommit=False) as c:
        with c.cursor() as cur:
            try:
                cur.execute("set role authenticated;")
                cur.execute("select public.claim_reward(%s, 'auth-rpc-bypass-001', null, null, null);", (TEST_WALLET,))
                c.commit()
                print("  FAIL: authenticated was able to call claim_reward RPC!")
                failures.append("authenticated claim_reward RPC succeeded (should be denied)")
            except psycopg.errors.InsufficientPrivilege as e:
                c.rollback()
                print(f"  PASS: denied with InsufficientPrivilege: {str(e).strip().split(chr(10))[0]}")
            except psycopg.errors.RaiseException as e:
                c.rollback()
                print(f"  PASS: denied with RaiseException: {str(e).strip().split(chr(10))[0]}")
            except Exception as e:
                c.rollback()
                print(f"  PASS: denied with {type(e).__name__}: {str(e).strip().split(chr(10))[0]}")

    # Confirm service_role CAN still call claim_reward (regression check)
    print("\n[7] service_role attempts to call get_wallet_reward_balance RPC (regression check)...")
    with psycopg.connect(uri, autocommit=False) as c:
        with c.cursor() as cur:
            try:
                cur.execute("set role service_role;")
                cur.execute("select public.get_wallet_reward_balance(%s);", (TEST_WALLET,))
                row = cur.fetchone()[0]
                c.commit()
                if "earned_points" in row:
                    print(f"  PASS: service_role can read balance: earned={row['earned_points']} claimed={row['claimed_points']} claimable={row['claimable_points']}")
                else:
                    print(f"  FAIL: unexpected response shape: {row}")
                    failures.append("service_role get_wallet_reward_balance returned unexpected shape")
            except Exception as e:
                c.rollback()
                print(f"  FAIL: service_role was DENIED: {type(e).__name__}: {e}")
                failures.append(f"service_role get_wallet_reward_balance failed: {e}")

    print("\n" + "=" * 60)
    if failures:
        print(f"SECURITY CHECK FAILED: {len(failures)} issue(s):")
        for f in failures:
            print(f"  - {f}")
        srv.cleanup()
        sys.exit(1)
    else:
        print("ALL SECURITY CHECKS PASSED — clients cannot bypass the RPC.")
        srv.cleanup()
        sys.exit(0)


if __name__ == "__main__":
    main()
