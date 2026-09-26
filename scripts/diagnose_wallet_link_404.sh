#!/usr/bin/env bash
# =====================================================================
# Wallet-Link Local Dev Diagnostic + Fix Script
# =====================================================================
# Run this from the root of your local Ronin-swap clone to:
#   1. Verify you're on the latest main (with the wallet-link fix)
#   2. Verify _routes.mjs has the wallet-link/verify route
#   3. Verify the handler files exist
#   4. Clear Vite's stale SSR cache (the most common cause of 404)
#   5. Test the endpoint with curl
#
# Usage:
#   bash /path/to/scripts/diagnose_wallet_link_404.sh
# =====================================================================
set -e

REPO_DIR="$(pwd)"
echo "==> Repo: $REPO_DIR"

# ---- Step 1: verify branch + latest commit ----
echo ""
echo "==> Step 1: Branch + commit check"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "    Current branch: $CURRENT_BRANCH"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "    ⚠️  NOT on main. Switching: git checkout main"
  git checkout main
fi
echo "    Pulling latest: git pull origin main"
git pull --quiet origin main 2>&1 || true
LATEST_COMMIT=$(git log --oneline -1)
echo "    Latest commit: $LATEST_COMMIT"
echo "    Expected:      ea518d1 fix(wallet-link): getPendingChallenge select clause..."

# ---- Step 2: verify _routes.mjs has the wallet-link routes ----
echo ""
echo "==> Step 2: Route registration check"
if grep -q "wallet-link/verify" api/_routes.mjs; then
  echo "    ✅ _routes.mjs has 'POST /api/wallet-link/verify' registered"
else
  echo "    ❌ _routes.mjs is MISSING the wallet-link/verify route!"
  echo "    Your local _routes.mjs is out of sync with origin/main."
  echo "    Fixing: git checkout origin/main -- api/_routes.mjs"
  git checkout origin/main -- api/_routes.mjs
  if grep -q "wallet-link/verify" api/_routes.mjs; then
    echo "    ✅ Fixed — _routes.mjs now has the route"
  else
    echo "    ❌ Still missing after checkout. Something is very wrong."
    exit 1
  fi
fi

# ---- Step 3: verify handler files exist ----
echo ""
echo "==> Step 3: Handler files check"
for f in api_routes/wallet-link/challenge.mjs \
         api_routes/wallet-link/verify.mjs \
         api_routes/wallet-link/list.mjs \
         api_routes/wallet-link/revoke.mjs \
         api/_lib/walletLinkAuth.mjs; do
  if [ -f "$f" ]; then
    echo "    ✅ $f exists ($(wc -l < "$f") lines)"
  else
    echo "    ❌ $f is MISSING"
    echo "    Fixing: git checkout origin/main -- $f"
    git checkout origin/main -- "$f" 2>&1 || true
    if [ -f "$f" ]; then
      echo "    ✅ Restored"
    else
      echo "    ❌ Still missing. Run: git pull origin main"
    fi
  fi
done

# ---- Step 4: clear Vite's stale SSR cache ----
echo ""
echo "==> Step 4: Clear Vite SSR cache"
if [ -d "node_modules/.vite" ]; then
  echo "    Removing node_modules/.vite (Vite dep cache)"
  rm -rf node_modules/.vite
  echo "    ✅ Vite cache cleared"
else
  echo "    ℹ️  No node_modules/.vite cache to clear"
fi
if [ -d "node_modules/.vite-cache" ]; then
  rm -rf node_modules/.vite-cache
  echo "    ✅ node_modules/.vite-cache cleared"
fi

# ---- Step 5: check for uncommitted local edits ----
echo ""
echo "==> Step 5: Local edits check"
UNCOMMITTED=$(git status --porcelain | wc -l)
if [ "$UNCOMMITTED" -gt 0 ]; then
  echo "    ⚠️  You have $UNCOMMITTED uncommitted file(s):"
  git status --porcelain | head -10
  echo ""
  echo "    If any of them touch api/_routes.mjs or api_routes/wallet-link/*,"
  echo "    they may be overriding the fix. To discard local edits to those"
  echo "    specific files:"
  echo "      git checkout origin/main -- api/_routes.mjs api_routes/wallet-link/"
  echo ""
  echo "    To stash ALL local edits safely:"
  echo "      git stash"
else
  echo "    ✅ No uncommitted local edits"
fi

# ---- Step 6: test the endpoint with curl ----
echo ""
echo "==> Step 6: HTTP test (assumes dev server is running on :5173)"
echo "    Testing: POST http://localhost:5173/api/wallet-link/verify"
echo "    (Expected response: 400 INVALID_CHALLENGE_ID — NOT 404 route not found)"
echo ""
HTTP_CODE=$(curl -s -o /tmp/wallet-link-verify-test.json -w "%{http_code}" \
  -X POST http://localhost:5173/api/wallet-link/verify \
  -H 'Content-Type: application/json' \
  -d '{"challengeId":"wlc-test","evmSignature":"0x0","solanaSignature":"AAAA"}' \
  2>/dev/null || echo "000")
echo "    HTTP status: $HTTP_CODE"
echo "    Response body:"
cat /tmp/wallet-link-verify-test.json 2>/dev/null
echo ""
echo ""

if [ "$HTTP_CODE" = "404" ]; then
  echo "    ❌ Still 404 — the dev server is loading a stale _routes.mjs."
  echo "       Fix: stop the dev server (Ctrl+C in the terminal running"
  echo "       'npm run dev'), then run it again. Vite's SSR module cache"
  echo "       is in-memory and only clears on dev server restart."
elif [ "$HTTP_CODE" = "400" ]; then
  echo "    ✅ 400 (validation error) — the route IS registered. The 404"
  echo "       is gone. Now test the real flow from the browser."
elif [ "$HTTP_CODE" = "503" ]; then
  echo "    ⚠️  503 — the route is registered but Supabase isn't configured"
  echo "       locally. Check your .env / .env.local for SUPABASE_URL and"
  echo "       SUPABASE_SERVICE_ROLE_KEY."
elif [ "$HTTP_CODE" = "000" ]; then
  echo "    ⚠️  No response — is the dev server running? Start it:"
  echo "       npm run dev"
else
  echo "    ℹ️  Unexpected status $HTTP_CODE — check the response body above."
fi

# ---- Done ----
echo ""
echo "==> Next steps if the 404 persists after restarting the dev server:"
echo "    1. Stop the dev server (Ctrl+C)"
echo "    2. rm -rf node_modules/.vite node_modules/.vite-cache"
echo "    3. npm run dev"
echo "    4. Re-run this script: bash scripts/diagnose_wallet_link_404.sh"
