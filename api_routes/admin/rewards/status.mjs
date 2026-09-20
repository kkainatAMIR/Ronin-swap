import { apiError, json } from '../../../api/_lib/roninBackend.mjs'
import { requireAdmin } from '../../../api/_lib/adminAuth.mjs'
import { isSupabaseConfigured, getAdminSettings } from '../../../api/_lib/supabaseBackend.mjs'
import {
  getRewardsProgramState,
  isRewardsAdminConfigured,
  getRewardsNetwork,
  RONIN_REWARDS_PROGRAM_ID,
  getRewardConfigPda,
  getRewardVaultPda,
} from '../../../api/_lib/solanaRewardsAdmin.mjs'

// GET /api/admin/rewards/status
//
// Returns the REAL on-chain state of the deployed Solana rewards program:
//   - network (devnet / mainnet-beta)
//   - programId
//   - rewardConfigPda
//   - rewardVaultPda
//   - admin (on-chain admin pubkey; must match the configured admin keypair)
//   - paused (true/false)
//   - vaultBalanceLamports + vaultBalanceSol
//   - totalClaimedLamports + totalClaimedSol (cumulative paid out)
//   - totalClaims (count)
//   - adminSignerConfigured (whether the backend has the admin keypair env var)
//   - dbSettings (Supabase admin_settings: rewards_enabled, reward_asset,
//     reward_points_per_unit, active season)
//
// All values come from REAL on-chain state + Supabase — no hardcoding.
export default async function handler(req, res) {
  if (req.method !== 'GET') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!await requireAdmin(req, res)) return
  if (!isSupabaseConfigured()) return apiError(res, 503, 'DATABASE_NOT_CONFIGURED', 'Admin is not configured.')

  try {
    const [configPda] = getRewardConfigPda()
    const [vaultPda] = getRewardVaultPda()
    const network = getRewardsNetwork()
    const adminSignerConfigured = isRewardsAdminConfigured()

    // Read Supabase settings
    const dbSettings = await getAdminSettings().catch(() => null)

    // Read on-chain state (may fail if RPC is unreachable or program not initialized)
    let onChainState = null
    let onChainError = null
    try {
      onChainState = await getRewardsProgramState()
    } catch (error) {
      onChainError = error?.message || String(error)
    }

    return json(res, 200, {
      network,
      programId: RONIN_REWARDS_PROGRAM_ID.toBase58(),
      rewardConfigPda: configPda.toBase58(),
      rewardVaultPda: vaultPda.toBase58(),
      adminSignerConfigured,
      onChain: onChainState ? {
        admin: onChainState.admin.toBase58(),
        paused: onChainState.paused,
        vaultBalanceLamports: onChainState.vaultBalanceLamports,
        vaultBalanceSol: onChainState.vaultBalanceSol,
        totalClaimedLamports: Number(onChainState.totalClaimed),
        totalClaimedSol: Number(onChainState.totalClaimed) / 1e9,
        totalClaims: Number(onChainState.totalClaims),
        bump: onChainState.bump,
        vaultBump: onChainState.vaultBump,
      } : null,
      onChainError,
      dbSettings: dbSettings ? {
        sol_rewards_enabled: Boolean(dbSettings.sol_rewards_enabled),
        reward_asset: dbSettings.reward_asset || 'SOL',
        reward_points_per_unit: Number(dbSettings.reward_points_per_unit || 1000),
        points_enabled: Boolean(dbSettings.points_enabled),
        swap_enabled: Boolean(dbSettings.swap_enabled),
      } : null,
      // Confirm the backend admin keypair pubkey matches the on-chain admin.
      // If they don't match, every claim_reward / fund_vault / withdraw_vault
      // / set_paused tx will be rejected by the program.
      adminMatch: onChainState && adminSignerConfigured ? 'CANNOT_VERIFY_WITHOUT_SIGNING' : 'N/A',
    })
  } catch (error) {
    console.error('admin/rewards/status failed:', error?.message || error)
    return apiError(res, 502, 'REWARDS_STATUS_ERROR', error?.message || 'Unable to read rewards program state.')
  }
}
