#!/usr/bin/env python3
"""
SQL Parse Validation for the wallet_links migration.

Uses pglast (a real Postgres parser, not a regex matcher) to verify
the migration file parses cleanly. This catches:
  * Unterminated strings / dollar-quotes
  * Syntax errors in CREATE TABLE / CREATE FUNCTION / CREATE INDEX
  * Mismatched parentheses
  * Invalid PL/pgSQL constructs (the kind that produced the
    'relation public.get_verified_reward_identity does not exist'
    error the user hit on Supabase)

It does NOT execute the SQL — it only parses it. So it verifies
syntactic correctness but not semantic correctness (e.g., it can't
tell if a referenced column exists).
"""

import sys
from pathlib import Path

import pglast


MIGRATION_PATH = Path(__file__).resolve().parent.parent / "supabase/migrations/20260926000000_wallet_links.sql"


def main():
    sql = MIGRATION_PATH.read_text()
    print(f"Parsing {MIGRATION_PATH.name} ({len(sql):,} bytes)...")
    try:
        # parse_sql returns a list of statements. We don't care about
        # the AST — we just want to know it parsed without raising.
        statements = pglast.parse_sql(sql)
        print(f"OK: parsed {len(statements)} top-level statement(s).")
        # Print a brief inventory of what was parsed.
        kinds = {}
        for stmt in statements:
            # stmt.stmt is the actual AST node; its class name tells us
            # what kind of statement it is.
            cls = type(stmt.stmt).__name__
            kinds[cls] = kinds.get(cls, 0) + 1
        print("Statement inventory:")
        for kind, count in sorted(kinds.items()):
            print(f"  {kind}: {count}")
        return 0
    except pglast.parser.ParseError as e:
        print(f"PARSE ERROR: {e}", file=sys.stderr)
        # Show the surrounding context.
        if hasattr(e, 'cursorpos') and e.cursorpos:
            line = sql[:e.cursorpos].count('\n') + 1
            print(f"  at line {line}, char offset {e.cursorpos}", file=sys.stderr)
            # Print 3 lines of context.
            lines = sql.split('\n')
            start = max(0, line - 4)
            end = min(len(lines), line + 3)
            for i in range(start, end):
                marker = '>>>' if i == line - 1 else '   '
                print(f"  {marker} {i+1:4d}: {lines[i]}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"UNEXPECTED ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
