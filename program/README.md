# Ronin Rewards — Solana Anchor Program

The Ronin Rewards program pays **SOL** to users who claim their earned **Samurai Points** rewards.

- **Program ID:** `FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU`
- **Currently deployed on:** Solana Devnet
- **Target deployment:** Solana Mainnet

This repo contains the Anchor source code + tests + deployment scripts. The companion website lives at [`kkainatAMIR/Ronin-swap`](https://github.com/kkainatAMIR/Ronin-swap).

## Repository contents

```
ronin-rewards-program/
├── Anchor.toml                       ← Anchor config (program ID + cluster)
├── Cargo.toml                        ← Rust workspace manifest
├── package.json                      ← Node deps for the test suite
├── tsconfig.json                     ← TypeScript config
├── .gitignore                        ← EXCLUDES the program keypair (secret!)
├── programs/
│   └── ronin_rewards/
│       ├── Cargo.toml                ← Anchor program manifest
│       └── src/
│           └── lib.rs                ← The actual Solana program
├── tests/
│   └── ronin_rewards.ts              ← Test suite (with manual SHA-256)
└── scripts/
    ├── deploy-mainnet.sh            ← Mainnet deployment script
    ├── extract-keypair.js            ← Browser snippet to extract program keypair
    ├── verify-program.mjs           ← Read-only program verification
    └── initialize-mainnet.sh        ← One-time Mainnet initialize() call
```

## Prerequisites (install on YOUR local machine)

You need 4 tools installed locally. None of them can be installed by me — they require native compilation and root.

### 1. Solana CLI

```bash
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
source ~/.bashrc  # or ~/.zshrc, depending on your shell
solana --version  # verify
```

### 2. Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.bashrc
rustc --version  # verify
```

### 3. Anchor CLI

```bash
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --tag v0.30.1
anchor --version  # verify
```

### 4. Node.js + yarn

Install Node.js from https://nodejs.org/ (version 18 or later), then:

```bash
npm install -g yarn
yarn --version  # verify
```

## Deployment checklist (4 things only YOU can do)

### Thing #1 — Extract the program keypair from Solana Playground

The program ID `FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU` is the public key of a 64-byte secret key that was generated when you first deployed to Devnet via Solana Playground. **That keypair lives in your browser's localStorage — I cannot access it.**

To extract it:

1. Open https://beta.solpg.io in your browser (the same browser/profile you used to deploy to Devnet)
2. Open your `ronin_rewards` workspace
3. Press **F12** → Console tab
4. Paste the entire contents of [`scripts/extract-keypair.js`](scripts/extract-keypair.js) and press Enter
5. The console will print either:
   - `✅ FOUND PROGRAM KEYPAIR` followed by a JSON array like `[123,456,...,42]`
   - `❌ Program keypair not found` (see "If you can't find the keypair" below)
6. Copy the JSON array
7. Save it to a local file:
   ```
   ronin-rewards-program/programs/ronin_rewards/ronin_rewards-keypair.json
   ```

**⚠️ This file is a SECRET.** Anyone with it can deploy upgrades to your program. Never commit it to git (the `.gitignore` already excludes it). Never paste it in chat.

### Thing #2 — Configure Solana CLI for Mainnet + verify wallet

```bash
solana config set --url https://api.mainnet-beta.solana.com
solana config get
solana address   # should print jcJnPd1i1VzaTy4gR4LrKcMyZSgKmC8vy5n5fLo7EHv
solana balance   # need at least 3-5 SOL for program deployment
```

If your wallet's pubkey is not `jcJnPd1i1VzaTy4gR4LrKcMyZSgKmC8vy5n5fLo7EHv`, switch to the right keypair:

```bash
solana config set --keypair ~/.config/solana/id.json
solana address
```

If balance is below 3 SOL, fund the wallet from a Mainnet wallet you control.

### Thing #3 — Clone this repo + install deps

```bash
git clone https://github.com/kkainatAMIR/ronin-rewards-program.git
cd ronin-rewards-program
yarn install
```

### Thing #4 — Run the deploy script

```bash
bash scripts/deploy-mainnet.sh
```

The script will:

1. Verify the toolchain (Solana CLI, Anchor CLI, Rust, yarn, node)
2. Verify the program keypair file exists and its pubkey matches `FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU`
3. Verify you're on Mainnet and your deployer wallet is `jcJnPd1i1VzaTy4gR4LrKcMyZSgKmC8vy5n5fLo7EHv`
4. Verify your SOL balance is sufficient (≥ 3 SOL)
5. Run `yarn install`
6. Run `anchor build`
7. Run `anchor test` against **localnet first** (free, safe — must pass)
8. Ask you to type `DEPLOY` (uppercase) to confirm
9. Run `solana program deploy --program-id <keypair> <so-file> --url mainnet`
10. Verify the deployed program ID matches `FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU`
11. Print the derived RewardConfig + RewardVault PDAs

**The script does NOT call `initialize()` automatically.** That's a separate one-time step — see `INITIALIZE.md` after deployment.

## If you can't find the keypair (Thing #1 fails)

If the extraction snippet prints "Program keypair not found," the most likely reasons are:

1. **You opened a different Solana Playground workspace** — make sure you see your `ronin_rewards` program in the left sidebar
2. **You cleared your browser data** — the keypair is gone, and you CANNOT reuse the program ID `FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU` on Mainnet
3. **You're on a different browser or profile** — log into the same one you used to deploy to Devnet
4. **Solana Playground moved to IndexedDB** — the snippet searches both, but if it still fails, you may need to manually inspect IndexedDB via DevTools → Application → IndexedDB

If the keypair is truly lost, your only option is to deploy a **NEW** program with a **NEW** keypair. The new program will get a new program ID. You'll then update `SOLANA_REWARDS_PROGRAM_ID` in your website's `.env.local` and re-deploy the website.

## Why I can't deploy on your behalf

Mainnet deployment requires three things only you control:

1. **The program keypair file** (a 64-byte private key that lives in your browser)
2. **The deployer wallet's SOL** (real money — rent for the program bytecode)
3. **A local Solana CLI install** (with `cargo`, `rustc`, `anchor`)

No legitimate agent will ever ask you to paste a private key in chat. Anyone who claims to deploy for you is either lying or trying to compromise your security. **Self-custody blockchain means only the keyholder can do this** — that's the whole security model.

## After deployment

Once `scripts/deploy-mainnet.sh` succeeds:

1. Initialize the program on Mainnet (one-time): see `INITIALIZE.md`
2. Fund the reward vault with a small test amount: `bash scripts/fund-vault-mainnet.sh 0.1`
3. Update your website's `.env.local`:
   ```bash
   SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
   SOLANA_REWARDS_NETWORK=mainnet-beta
   # SOLANA_REWARDS_PROGRAM_ID stays FHd1Nvwfvywkvw6Xcdt2QrgiLWPo2qG1KLrUoCwHWKfU
   ```
4. Restart your dev server: `npm run dev:all`
5. The `/admin` page will now show "NETWORK: MAINNET-BETA" and the real on-chain state

## License

Proprietary — RoninSamurai project.
