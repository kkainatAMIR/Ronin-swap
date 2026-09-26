#!/usr/bin/env bash
# =====================================================================
# cleanup-leaked-files.sh
# =====================================================================
# Removes environment-internal files that were accidentally merged into
# the public Ronin-swap repo via PR #1 (which included an auto-commit
# from the dev container that swept up the `skills/`, `download/`,
# and `worklog.md` directories).
#
# Run this script FROM INSIDE your local clone of Ronin-swap, on the
# `main` branch, BEFORE applying the accounting-fix patch.
#
#   cd ~/your/path/to/Ronin-swap
#   git checkout main
#   git pull origin main
#   bash /path/to/cleanup-leaked-files.sh
#   git am /path/to/0001-fix-accounting-bug.patch
#   git push origin main
#
# What it does:
#   1. Removes 1,000+ leaked environment-internal files
#      (skills/, download/, worklog.md, tool-results/)
#   2. Hardens .gitignore so future auto-commits from the dev
#      container don't reintroduce them
#   3. Creates a single clean commit: "chore: remove leaked
#      environment-internal files + .gitignore hardening"
#
# The script is idempotent — safe to re-run.
# =====================================================================
set -euo pipefail

# Sanity check: make sure we're at the root of a git repo.
if [ ! -d .git ]; then
  echo "ERROR: not at the root of a git repository."
  echo "Run this script from inside your local clone of Ronin-swap."
  exit 1
fi

# Sanity check: make sure we're on main (or warn).
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "WARNING: currently on branch '$BRANCH', not 'main'."
  echo "Press Ctrl+C to abort, or Enter to continue on '$BRANCH'."
  read -r
fi

# Start a clean working tree (no staged changes).
git reset --quiet HEAD || true
git checkout --quiet -- . || true

# Create a feature branch for the cleanup so it's reviewable as a PR.
CLEANUP_BRANCH="chore/cleanup-leaked-files-$(date +%Y%m%d)"
git checkout -b "$CLEANUP_BRANCH" 2>/dev/null || git checkout "$CLEANUP_BRANCH"

echo "==> Removing leaked environment-internal files..."

# Remove the leaked directories + files. Use git rm so the deletions
# are staged for commit. If a path doesn't exist, --ignore-unmatch
# prevents the script from failing.
git rm -r --quiet --ignore-unmatch skills/ || true
git rm -r --quiet --ignore-unmatch download/ || true
git rm --quiet --ignore-unmatch worklog.md || true
git rm -r --quiet --ignore-unmatch tool-results/ || true

# Hard-mode cleanup: also remove the dev-environment scratch files
# that have been on main since the original repo creation. They
# should have been gitignored from the start.
git rm --quiet --ignore-unmatch .tmp-swap-query.mjs || true
git rm --quiet --ignore-unmatch .tmp-swap-rows.mjs || true
git rm --quiet --ignore-unmatch .tmp_eth_e2e_test.mjs || true
git rm --quiet --ignore-unmatch __admin_local_test.mjs || true
git rm --quiet --ignore-unmatch __audit_points_config.mjs || true
git rm --quiet --ignore-unmatch __enable_platform_fee_db.mjs || true
git rm --quiet --ignore-unmatch __final_verify.mjs || true
git rm --quiet --ignore-unmatch __fix_points_minimum_10.mjs || true
for f in __probe_*; do
  [ -e "$f" ] && git rm --quiet --ignore-unmatch "$f" || true
done

echo "==> Updating .gitignore to prevent future leaks..."

# Append hardening rules if they aren't already there.
if ! grep -q "^# Environment-internal files — never commit" .gitignore 2>/dev/null; then
  cat >> .gitignore << 'EOF'

# Environment-internal files — never commit these to the public repo.
# They get auto-committed by the dev container; this section ensures
# they're ignored even if someone manually tries to add them.
skills/
download/
worklog.md
tool-results/
.tmp-*
.tmp_*
__probe_*
__audit_*
__admin_local_test*
__final_verify*
__enable_platform_fee_db*
__fix_points_minimum*
EOF
  git add .gitignore
fi

echo "==> Committing cleanup..."

git commit -m "chore: remove leaked environment-internal files + .gitignore hardening

The merge of PR #1 accidentally pulled in container-internal files
that have no place in the public Ronin-swap repo:

- skills/         (1,000+ skill-documentation files from the dev env)
- download/       (auto-generated artifact directory)
- worklog.md      (local agent work log)
- tool-results/  (dev container scratch directory)

Remove them all and add .gitignore entries so future auto-commits
from the dev environment don't reintroduce them. Also gitignores
the various __probe_* / __admin_* / .tmp_* scratch files that
were already on main but should have been gitignored from the start.

This commit is purely a cleanup — no application logic changes.
The wallet-link accounting fix comes in the next commit."

echo ""
echo "==> Done. Cleanup commit:"
git log --oneline -1
echo ""
echo "Next steps:"
echo "  1. Apply the accounting fix patch:"
echo "     git am /path/to/0001-fix-accounting-bug.patch"
echo "  2. Push both commits to your fork:"
echo "     git push origin $CLEANUP_BRANCH"
echo "  3. Open a PR for review."
