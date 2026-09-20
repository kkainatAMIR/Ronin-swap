import { apiError, json, parseBody } from '../../../api/_lib/roninBackend.mjs'
import { requireAdmin } from '../../../api/_lib/adminAuth.mjs'
import {
  getRewardsProgramState,
  submitFundVaultTx,
  solToLamports,
  isRewardsAdminConfigured,
  getTxExplorerUrl,
} from '../../../api/_lib/solanaRewardsAdmin.mjs'

// POST /api/admin/rewards/fund-vault
// Body: { amountSol: number }
//
// Calls the deployed program's fund_vault(amount: u64) instruction,
// signed by the backend admin keypair. The admin's Solana wallet
// supplies the SOL. The vault PDA receives it.
//
// This performs a REAL on-chain transaction. The admin's keypair
// must have enough SOL to cover the deposit + tx fee.
export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!await requireAdmin(req, res)) return
  if (!isRewardsAdminConfigured()) {
    return apiError(res, 503, 'REWARDS_ADMIN_NOT_CONFIGURED',
      'The Solana rewards admin signer is not configured on the server.')
  }

  const body = parseBody(req) || {}
  const amountSolRaw = body?.amountSol ?? body?.amount_sol
  const amountSol = Number(amountSolRaw)

  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    return apiError(res, 400, 'INVALID_AMOUNT', 'amountSol must be a positive number (in SOL).')
  }

  let amountLamports
  try {
    amountLamports = solToLamports(amountSol)
  } catch (error) {
    return apiError(res, 400, 'INVALID_AMOUNT', `Could not convert SOL to lamports: ${error?.message || error}`)
  }

  try {
    // Read current vault balance (so we can show before vs after)
    let stateBefore
    try {
      stateBefore = await getRewardsProgramState()
    } catch (error) {
      return apiError(res, 502, 'PROGRAM_STATE_UNAVAILABLE',
        `Could not read on-chain program state: ${error?.message || error}`)
    }

    // Submit fund_vault() tx
    let signature
    try {
      signature = await submitFundVaultTx(amountLamports)
    } catch (error) {
      console.error('admin/rewards/fund-vault tx failed:', error?.message || error)
      return apiError(res, 502, 'FUND_VAULT_TX_FAILED',
        `The fund_vault transaction failed: ${error?.message || error}`)
    }

    // Re-read vault balance
    let vaultBalanceLamportsAfter = stateBefore.vaultBalanceLamports + amountLamports
    try {
      const stateAfter = await getRewardsProgramState()
      vaultBalanceLamportsAfter = stateAfter.vaultBalanceLamports
    } catch (error) {
      console.warn('admin/rewards/fund-vault post-tx state read failed:', error?.message)
    }

    return json(res, 200, {
      success: true,
      signature,
      explorer_url: getTxExplorerUrl(signature),
      amount_sol: amountSol,
      amount_lamports: amountLamports,
      vault_balance_before_sol: stateBefore.vaultBalanceSol,
      vault_balance_after_sol: vaultBalanceLamportsAfter / 1e9,
      message: `Deposited ${amountSol} SOL into the reward vault.`,
    })
  } catch (error) {
    console.error('admin/rewards/fund-vault failed:', error?.message || error)
    return apiError(res, 502, 'FUND_VAULT_ERROR', error?.message || 'Unable to fund the reward vault.')
  }
}
