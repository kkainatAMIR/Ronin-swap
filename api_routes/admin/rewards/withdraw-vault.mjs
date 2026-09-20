import { apiError, json, parseBody } from '../../../api/_lib/roninBackend.mjs'
import { requireAdmin } from '../../../api/_lib/adminAuth.mjs'
import {
  getRewardsProgramState,
  submitWithdrawVaultTx,
  solToLamports,
  isRewardsAdminConfigured,
  getTxExplorerUrl,
} from '../../../api/_lib/solanaRewardsAdmin.mjs'

// POST /api/admin/rewards/withdraw-vault
// Body: { amountSol: number }
//
// Calls the deployed program's withdraw_vault(amount: u64) instruction.
// The admin's Solana wallet receives the SOL. The vault PDA sends it.
//
// Safety: the program likely enforces a rent-exempt minimum on the vault
// PDA. If the requested withdrawal would breach that minimum, the program
// will reject the tx. We pre-check vault balance here to give a clear
// error message, but the on-chain program is the final authority.
//
// Returns:
//   - signature (Solana tx signature)
//   - explorer_url
//   - vault_balance_before / vault_balance_after
//   - amount_sol / amount_lamports
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
    // Pre-flight: read current vault balance
    let stateBefore
    try {
      stateBefore = await getRewardsProgramState()
    } catch (error) {
      return apiError(res, 502, 'PROGRAM_STATE_UNAVAILABLE',
        `Could not read on-chain program state: ${error?.message || error}`)
    }

    // Pre-check: does the vault have enough?
    // We don't enforce a rent-exempt minimum here — the program does that
    // authoritatively. But we can at least catch the obvious case where
    // the request exceeds the entire vault balance.
    if (amountLamports > stateBefore.vaultBalanceLamports) {
      return apiError(res, 400, 'INSUFFICIENT_VAULT_BALANCE',
        `Requested withdrawal of ${amountSol} SOL exceeds vault balance of ${stateBefore.vaultBalanceSol} SOL.`)
    }

    // Submit withdraw_vault() tx
    let signature
    try {
      signature = await submitWithdrawVaultTx(amountLamports)
    } catch (error) {
      console.error('admin/rewards/withdraw-vault tx failed:', error?.message || error)
      // The most common failure here is the rent-exempt minimum violation.
      return apiError(res, 502, 'WITHDRAW_VAULT_TX_FAILED',
        `The withdraw_vault transaction failed: ${error?.message || error}. ` +
        `This often happens when the withdrawal would breach the vault's rent-exempt minimum.`)
    }

    // Re-read vault balance
    let vaultBalanceLamportsAfter = stateBefore.vaultBalanceLamports - amountLamports
    try {
      const stateAfter = await getRewardsProgramState()
      vaultBalanceLamportsAfter = stateAfter.vaultBalanceLamports
    } catch (error) {
      console.warn('admin/rewards/withdraw-vault post-tx state read failed:', error?.message)
    }

    return json(res, 200, {
      success: true,
      signature,
      explorer_url: getTxExplorerUrl(signature),
      amount_sol: amountSol,
      amount_lamports: amountLamports,
      vault_balance_before_sol: stateBefore.vaultBalanceSol,
      vault_balance_after_sol: vaultBalanceLamportsAfter / 1e9,
      message: `Withdrew ${amountSol} SOL from the reward vault.`,
    })
  } catch (error) {
    console.error('admin/rewards/withdraw-vault failed:', error?.message || error)
    return apiError(res, 502, 'WITHDRAW_VAULT_ERROR', error?.message || 'Unable to withdraw from the reward vault.')
  }
}
