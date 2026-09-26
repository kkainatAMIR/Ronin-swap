---
Task ID: 1
Agent: main (Super Z)
Task: Implement secure multi-chain Samurai Points → Solana SOL rewards flow with cryptographic wallet-linking for the existing Ronin-swap repository.

Work Log:
- Cloned https://github.com/kkainatAMIR/Ronin-swap.git into /home/z/my-project
- Inspected existing architecture: WalletContext.jsx, Profile.jsx, RewardClaimPanel.jsx, rewardsService.js, balance.mjs, claim-prepare/confirm, samurai_points schema, reward_claims schema, admin_auth_challenges (nonce pattern), adminAuth.mjs (Solana ed25519 verification pattern)
- Confirmed NO existing wallet-link/identity table, NO EVM signature verification lib — installed ethers@6.17.0
- Designed minimal wallet-link schema with backward-compatible aggregation
- Created supabase migration: 20260926000000_wallet_links.sql
  * wallet_links + wallet_link_challenges tables (RLS, service_role-only)
  * link_wallets / unlink_wallet / get_linked_evm_wallets / get_verified_reward_identity RPCs
  * Modified get_wallet_reward_balance + claim_reward to aggregate across verified identity (backward-compatible — no links = original behavior)
  * EVM_CLAIM_NOT_ALLOWED exception in claim_reward enforces EVM addresses cannot be Solana payout recipients
  * Unique partial indexes prevent cross-user hijack (1 EVM → 1 Solana active link)
- Created api/_lib/walletLinkAuth.mjs (challenge creation, EIP-191 + ed25519 verification, address normalization, RPC clients)
- Created api_routes/wallet-link/{challenge,verify,list,revoke}.mjs
- Registered 5 new routes in api/_routes.mjs: POST /api/wallet-link/challenge, POST /verify, GET /list, GET /revoke-challenge, POST /revoke
- Created src/services/walletLinkService.js (frontend client + MetaMask/Phantom signing helpers)
- Created src/components/WalletLinkPanel.jsx (full link flow UI: connect MetaMask → sign EVM → sign Solana → verify)
- Updated src/components/RewardClaimPanel.jsx: uses solanaPayoutWallet (backend-resolved) for claims, shows 3 verified-identity UX states (EVM-only → connect Solana, Solana-only → link EVM, Solana+linked → unified banner), rejects EVM as payout wallet
- Updated src/context/WalletContext.jsx: added verifiedEvmWallets + solanaPayoutWallet state loaded from /api/wallet-link/list (NEVER localStorage), refreshLinkedWallets() method, exposed in context value
- Updated src/pages/Profile.jsx: passes solanaPayoutWallet to RewardClaimPanel, new "Verified Reward Wallets" section separating connected (localStorage) from verified (DB) wallets
- Updated api_routes/rewards/balance.mjs to return verified-identity fields (input_wallet, solana_payout_wallet, linked_evm_wallets, is_verified_identity)
- Created scripts/test_wallet_link_security.mjs (47 tests: address validation, EVM/Solana sig verification, SQL migration static checks, handler static checks, replay/hijack scenarios)
- Created scripts/test_wallet_link_migration.py (25 unittest cases — independent verification)
- Added src/wallet-link.css for the new components, imported in main.jsx
- Existing Rust/Anchor rewards program 6Uyjo8oDGQJeb8zS1yFqwLCguc4gfUB1V4xWheAD7RYC unchanged
- Existing reward_claims rows, wallets.claimed_points, samurai_points awards all preserved (migration is additive)
- npm run build succeeds; dev server starts and /api/wallet-link/list returns correct responses

Stage Summary:
- Files changed (new): 9 (migration, 1 lib, 4 API handlers, 1 frontend service, 1 component, 1 css)
- Files changed (existing): 5 (api/_routes.mjs, api_routes/rewards/balance.mjs, src/components/RewardClaimPanel.jsx, src/context/WalletContext.jsx, src/pages/Profile.jsx, src/main.jsx, package.json+package-lock.json for ethers)
- Tests added: 47 Node tests (all pass) + 25 Python tests (all pass)
- Rust contract: UNCHANGED
- Existing claims/history: PRESERVED (migration is purely additive — get_wallet_reward_balance and claim_reward retain original behavior when no verified links exist)
- Security boundary enforced: cryptographic EIP-191 + ed25519 dual-sig verification, server-generated nonces, one-time-use challenges, replay protection (PENDING→USED status + FOR UPDATE lock + expiry check), cross-user hijack protection (unique partial index on evm_wallet WHERE status='ACTIVE'), EVM-as-payout-wallet rejection (EVM_CLAIM_NOT_ALLOWED), backend-only linked-wallet resolution (frontend NEVER supplies a wallet list — only a single wallet, server resolves links from DB)
