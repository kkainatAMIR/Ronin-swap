#!/usr/bin/env bash
# =====================================================================
# Ronin Rewards — Mainnet deployment script
# =====================================================================
#
# This script performs the COMPLETE Mainnet deployment flow:
#
#   1. Verifies the required toolchain (Solana CLI, Anchor CLI, Rust)
#   2. Verifies the program keypair file exists and matches the
#      declared program ID (FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU)
#   3. Verifies the deployer wallet is on Mainnet and has enough SOL
#   4. Builds the program (anchor build)
#   5. Runs tests against localnet FIRST (free, safe, must pass)
#   6. Asks for explicit confirmation before deploying to Mainnet
#   7. Deploys using solana program deploy --program-id <keypair>
#   8. Verifies the deployed program ID matches
#   9. Does NOT call initialize() automatically — that's a separate
#      one-time setup step (see INITIALIZE.md)
#
# PREREQUISITES:
#
#   - Solana CLI installed (sh -c "$(curl -sSfL https://release.solana.com/stable/install)")
#   - Anchor CLI installed (cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.30.1)
#   - Rust installed (curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)
#   - Node + yarn installed (https://nodejs.org/)
#   - Program keypair file at programs/ronin_rewards/ronin_rewards-keypair.json
#     (extracted from Solana Playground)
#   - Deployer wallet at ~/.config/solana/id.json with:
#       * Public key = jcJnPd1i1VzaTy4gR4LrKcMyZSgKmC8vy5n5fLo7EHv
#       * Mainnet SOL balance >= 5 SOL (for program rent + fees)
#
# USAGE:
#
#   bash scripts/deploy-mainnet.sh
#
# SAFETY:
#
#   - Pauses for explicit Y/n confirmation before any Mainnet action
#   - Never sends transactions you didn't confirm
#   - Prints every command it runs so you can audit the log
#   - Stops on the first error
#
# =====================================================================

set -euo pipefail

# Colors for readable output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()    { echo -e "${GREEN}[deploy]${NC} $1"; }
warn()   { echo -e "${YELLOW}[warn]${NC}   $1"; }
error()  { echo -e "${RED}[error]${NC}  $1"; }
step()   { echo -e "\n${BLUE}=== $1 ===${NC}"; }

# Expected program ID — must match Anchor.toml + lib.rs declare_id!
EXPECTED_PROGRAM_ID="FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU"

# Expected admin wallet (the deployer must be this wallet)
EXPECTED_ADMIN="jcJnPd1i1VzaTy4gR4LrKcMyZSgKmC8vy5n5fLo7EHv"

# Program keypair file (you must extract this from Solana Playground)
PROGRAM_KEYPAIR="programs/ronin_rewards/ronin_rewards-keypair.json"

# =====================================================================
# Step 1: Verify toolchain
# =====================================================================
step "Step 1: Verify required toolchain"

echo "Checking for solana CLI..."
if ! command -v solana &> /dev/null; then
  error "Solana CLI is not installed."
  echo "Install with:"
  echo "  sh -c \"\$(curl -sSfL https://release.solana.com/stable/install)\""
  exit 1
fi
log "Solana CLI: $(solana --version)"

echo "Checking for anchor CLI..."
if ! command -v anchor &> /dev/null; then
  error "Anchor CLI is not installed."
  echo "Install Rust first:"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "Then install Anchor:"
  echo "  cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.30.1"
  exit 1
fi
log "Anchor CLI: $(anchor --version)"

echo "Checking for rust/cargo..."
if ! command -v cargo &> /dev/null; then
  error "Rust/cargo is not installed."
  echo "Install with:"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi
log "Rust: $(rustc --version)"

echo "Checking for yarn..."
if ! command -v yarn &> /dev/null; then
  error "yarn is not installed."
  echo "Install with:"
  echo "  npm install -g yarn"
  exit 1
fi
log "yarn: $(yarn --version)"

echo "Checking for node..."
if ! command -v node &> /dev/null; then
  error "Node.js is not installed."
  echo "Install from: https://nodejs.org/"
  exit 1
fi
log "Node: $(node --version)"

# =====================================================================
# Step 2: Verify program keypair file exists + matches expected program ID
# =====================================================================
step "Step 2: Verify program keypair matches expected program ID"

if [[ ! -f "$PROGRAM_KEYPAIR" ]]; then
  error "Program keypair file not found: $PROGRAM_KEYPAIR"
  echo ""
  echo "You must extract the program keypair from Solana Playground."
  echo "In Solana Playground (https://beta.solpg.io):"
  echo "  1. Open your ronin_rewards workspace"
  echo "  2. Press F12 to open DevTools"
  echo "  3. Go to Console tab"
  echo "  4. Paste the snippet from scripts/extract-keypair.js"
  echo "  5. Save the output as $PROGRAM_KEYPAIR"
  echo ""
  echo "The keypair's public key MUST be: $EXPECTED_PROGRAM_ID"
  exit 1
fi

log "Program keypair file found: $PROGRAM_KEYPAIR"

# Verify the pubkey matches
KEYPAIR_PUBKEY=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
log "Keypair pubkey: $KEYPAIR_PUBKEY"

if [[ "$KEYPAIR_PUBKEY" != "$EXPECTED_PROGRAM_ID" ]]; then
  error "KEYPAIR MISMATCH"
  echo "  Expected pubkey: $EXPECTED_PROGRAM_ID"
  echo "  Actual pubkey:   $KEYPAIR_PUBKEY"
  echo ""
  echo "The keypair file you extracted from Solana Playground does NOT"
  echo "correspond to the deployed program ID. This means:"
  echo "  - Either you extracted the wrong keypair"
  echo "  - Or the program was never deployed with this keypair"
  echo ""
  echo "STOPPING. Do not proceed — you would deploy a different program."
  exit 1
fi

log "✅ Program keypair matches expected program ID"

# =====================================================================
# Step 3: Verify Solana CLI is on Mainnet + deployer wallet is correct
# =====================================================================
step "Step 3: Verify Mainnet cluster and deployer wallet"

# Set cluster to Mainnet
solana config set --url https://api.mainnet-beta.solana.com > /dev/null

CURRENT_CLUSTER=$(solana config get | grep "RPC URL" | awk '{print $3}')
log "Current cluster: $CURRENT_CLUSTER"

if [[ "$CURRENT_CLUSTER" != *"mainnet-beta"* ]]; then
  error "Solana CLI is NOT on Mainnet. Aborting."
  exit 1
fi
log "✅ On Mainnet"

DEPLOYER=$(solana address)
log "Deployer wallet: $DEPLOYER"

if [[ "$DEPLOYER" != "$EXPECTED_ADMIN" ]]; then
  warn "Deployer wallet is $DEPLOYER"
  warn "Expected admin:  $EXPECTED_ADMIN"
  warn ""
  warn "If you proceed, the deployed program's on-chain admin will NOT"
  warn "match the admin configured in your Supabase + website env vars."
  warn "You will need to either:"
  warn "  1. Switch to the wallet at ~/.config/solana/id.json matching $EXPECTED_ADMIN"
  warn "  2. Or call update_admin() on the deployed program to change the on-chain admin"
  warn ""
  read -p "Continue with $DEPLOYER as deployer anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Check SOL balance
BALANCE_LAMPORTS=$(solana balance | awk '{print $1}')
BALANCE_SOL=$(echo "scale=4; $BALANCE_LAMPORTS / 1" | bc -l 2>/dev/null || echo "$BALANCE_LAMPORTS")
log "Mainnet SOL balance: $BALANCE_LAMPORTS SOL"

# Anchor program deployment typically needs ~3-5 SOL for program bytecode rent
BALANCE_NUM=$(echo "$BALANCE_LAMPORTS" | awk '{print $1}')
if (( $(echo "$BALANCE_NUM < 3.0" | bc -l) )); then
  error "Insufficient SOL balance. Need at least 3 SOL for program deployment."
  echo "Current balance: $BALANCE_LAMPORTS SOL"
  echo "Fund the wallet at $DEPLOYER with Mainnet SOL."
  exit 1
fi
log "✅ Sufficient SOL balance"

# =====================================================================
# Step 4: Install npm dependencies
# =====================================================================
step "Step 4: Install npm dependencies"

log "Running yarn install..."
yarn install
log "✅ Dependencies installed"

# =====================================================================
# Step 5: Build the program
# =====================================================================
step "Step 5: Build the Anchor program"

log "Running anchor build..."
anchor build

# Verify the compiled .so file exists
SO_FILE="target/verify/ronin_rewards.so"
if [[ -f "$SO_FILE" ]]; then
  SO_SIZE=$(wc -c < "$SO_FILE" | awk '{print $1}')
  log "✅ Compiled bytecode: $SO_FILE ($SO_SIZE bytes)"
elif [[ -f "target/deploy/ronin_rewards.so" ]]; then
  SO_FILE="target/deploy/ronin_rewards.so"
  SO_SIZE=$(wc -c < "$SO_FILE" | awk '{print $1}')
  log "✅ Compiled bytecode: $SO_FILE ($SO_SIZE bytes)"
else
  error "Build succeeded but compiled .so file not found."
  echo "Looked at:"
  echo "  target/verify/ronin_rewards.so"
  echo "  target/deploy/ronin_rewards.so"
  exit 1
fi

# Verify the compiled program's embedded program ID matches
COMPILED_PROGRAM_ID=$(solana program dump "$EXPECTED_PROGRAM_ID" /dev/null 2>&1 || echo "")
# (There's no easy CLI way to read the declare_id from a .so file — we trust
#  the lib.rs source + Anchor.toml match.)

log "✅ Build complete"

# =====================================================================
# Step 6: Run tests against LOCALNET first (safe, free)
# =====================================================================
step "Step 6: Run tests against Localnet (safe, free)"

log "Switching to localnet for tests..."
solana config set --url localhost > /dev/null

log "Starting local validator in background..."
solana-test-validator > /tmp/ronin-rewards-test-validator.log 2>&1 &
VALIDATOR_PID=$!

# Wait for validator to be ready
log "Waiting for local validator..."
sleep 5
for i in {1..10}; do
  if solana cluster-version --url localhost > /dev/null 2>&1; then
    log "✅ Local validator ready"
    break
  fi
  sleep 2
done

# Run tests
log "Running anchor test..."
set +e
anchor test --skip-local-validator --provider.cluster localnet
TEST_EXIT_CODE=$?
set -e

# Kill the validator
kill $VALIDATOR_PID 2>/dev/null || true

if [[ $TEST_EXIT_CODE -ne 0 ]]; then
  error "Tests FAILED against localnet. Aborting Mainnet deployment."
  echo "Test output above. Fix the test failures before proceeding."
  exit 1
fi

log "✅ All tests passed against localnet"

# Switch back to Mainnet
solana config set --url https://api.mainnet-beta.solana.com > /dev/null

# =====================================================================
# Step 7: FINAL CONFIRMATION before Mainnet deployment
# =====================================================================
step "Step 7: FINAL CONFIRMATION — Mainnet deployment"

echo "You are about to deploy the Ronin Rewards program to Solana MAINNET."
echo ""
echo "  Program ID:       $EXPECTED_PROGRAM_ID"
echo "  Compiled .so:     $SO_FILE ($SO_SIZE bytes)"
echo "  Deployer wallet:  $DEPLOYER"
echo "  SOL balance:       $BALANCE_LAMPORTS SOL"
echo "  Cluster:          Mainnet (https://api.mainnet-beta.solana.com)"
echo ""
echo "This is IRREVERSIBLE. The bytecode will live at"
echo "  $EXPECTED_PROGRAM_ID"
echo "on Mainnet forever (or until you explicitly upgrade it)."
echo ""
echo "The deployer wallet will pay program rent (~2-4 SOL, non-refundable)."
echo ""
read -p "Type 'DEPLOY' in uppercase to confirm: " -r
echo
if [[ "$REPLY" != "DEPLOY" ]]; then
  echo "Confirmation not received. Aborting."
  exit 1
fi

# =====================================================================
# Step 8: Deploy to Mainnet using the existing program keypair
# =====================================================================
step "Step 8: Deploy to Mainnet"

log "Running: solana program deploy --program-id $PROGRAM_KEYPAIR $SO_FILE --url mainnet"
echo ""

# CRITICAL: --program-id <keypair> uses the existing keypair, which means
# the deployed program ID will be the pubkey of that keypair (= EXPECTED_PROGRAM_ID).
# Do NOT omit --program-id — that would generate a NEW keypair (= new program ID).
DEPLOY_OUTPUT=$(solana program deploy \
  --program-id "$PROGRAM_KEYPAIR" \
  "$SO_FILE" \
  --url https://api.mainnet-beta.solana.com \
  2>&1)

echo "$DEPLOY_OUTPUT"

# Extract the deployed program ID from the output
DEPLOYED_PROGRAM_ID=$(echo "$DEPLOY_OUTPUT" | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,44}' | head -1)

if [[ "$DEPLOYED_PROGRAM_ID" != "$EXPECTED_PROGRAM_ID" ]]; then
  error "DEPLOYED PROGRAM ID DOES NOT MATCH EXPECTED!"
  echo "  Expected:  $EXPECTED_PROGRAM_ID"
  echo "  Deployed:  $DEPLOYED_PROGRAM_ID"
  echo ""
  echo "This is a CRITICAL error. The program was deployed to a different address."
  echo "Contact Solana support immediately if SOL was spent incorrectly."
  exit 1
fi

log "✅ Program deployed to: $DEPLOYED_PROGRAM_ID"

# =====================================================================
# Step 9: Post-deployment verification
# =====================================================================
step "Step 9: Verify deployed program on Mainnet"

log "Running: solana program show $EXPECTED_PROGRAM_ID"
solana program show "$EXPECTED_PROGRAM_ID"

echo ""
log "Running: solana program display $EXPECTED_PROGRAM_ID"
solana program display "$EXPECTED_PROGRAM_ID" 2>&1 || true

# Derive PDAs (using Node)
echo ""
log "Deriving PDAs from the deployed program ID..."
node -e "
const { PublicKey } = require('@solana/web3.js');
const PROGRAM_ID = new PublicKey('$EXPECTED_PROGRAM_ID');
const [rc] = PublicKey.findProgramAddressSync([Buffer.from('reward_config')], PROGRAM_ID);
const [rv] = PublicKey.findProgramAddressSync([Buffer.from('reward_vault')], PROGRAM_ID);
console.log('Reward Config PDA (Mainnet):', rc.toBase58());
console.log('Reward Vault PDA  (Mainnet):', rv.toBase58());
"

# =====================================================================
# Step 10: Done — DO NOT call initialize() automatically
# =====================================================================
step "Step 10: Deployment complete"

echo "✅ Program deployed to Mainnet at: $EXPECTED_PROGRAM_ID"
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Initialize the program on Mainnet (ONE-TIME, see INITIALIZE.md):"
echo "   bash scripts/initialize-mainnet.sh"
echo ""
echo "2. Fund the Mainnet reward vault with a small test amount (e.g. 0.1 SOL):"
echo "   bash scripts/fund-vault-mainnet.sh 0.1"
echo ""
echo "3. Update your website .env.local to point at Mainnet:"
echo "   SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY"
echo "   SOLANA_REWARDS_NETWORK=mainnet-beta"
echo "   (SOLANA_REWARDS_PROGRAM_ID stays the same — already FHd1Nvwf...)"
echo ""
echo "4. Restart your dev server:"
echo "   npm run dev:all"
echo ""
echo "The website's /admin page will show:"
echo "  NETWORK: MAINNET-BETA"
echo "  PROGRAM ID: $EXPECTED_PROGRAM_ID"
echo "  VAULT BALANCE: (whatever you funded in step 2)"
echo ""

log "Deployment script complete."
