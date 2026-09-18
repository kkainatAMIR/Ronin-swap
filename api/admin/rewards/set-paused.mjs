import { apiError, json, parseBody } from '../../_lib/roninBackend.mjs'
import { requireAdmin } from '../../_lib/adminAuth.mjs'
import {
  getRewardsProgramState,
  submitSetPausedTx,
  isRewardsAdminConfigured,
  getTxExplorerUrl,
} from '../../_lib/solanaRewardsAdmin.mjs'

// POST /api/admin/rewards/set-paused
// Body: { paused: true | false }
//
// Calls the deployed Solana program's set_paused() instruction, signed
// by the backend admin keypair. The on-chain paused state is the source
// of truth — when paused=true, ALL user claim_reward() transactions
// will be rejected by the program.
//
// Returns:
//   - signature (Solana transaction signature)
//   - explorer_url
//   - paused_before (the previous on-chain paused state)
//   - paused_after (the new on-chain paused state, re-read after the tx)
export default async function handler(req, res) {
  if (req.method !== 'POST') return apiError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.')
  if (!await requireAdmin(req, res)) return
  if (!isRewardsAdminConfigured()) {
    return apiError(res, 503, 'REWARDS_ADMIN_NOT_CONFIGURED',
      'The Solana rewards admin signer is not configured on the server.')
  }

  const body = parseBody(req) || {}
  const paused = body?.paused === true || body?.paused === 'true'

  try {
    // Read current state (so we can show paused_before vs paused_after)
    let stateBefore
    try {
      stateBefore = await getRewardsProgramState()
    } catch (error) {
      return apiError(res, 502, 'PROGRAM_STATE_UNAVAILABLE',
        `Could not read on-chain program state: ${error?.message || error}`)
    }

    if (stateBefore.paused === paused) {
      // No-op — the on-chain state already matches the requested state.
      return json(res, 200, {
        success: true,
        no_op: true,
        signature: null,
        paused_before: paused,
        paused_after: paused,
        vaultBalanceSol: stateBefore.vaultBalanceSol,
        message: `Rewards are already ${paused ? 'PAUSED' : 'ACTIVE'}. No transaction submitted.`,
      })
    }

    // Submit the set_paused() instruction
    let signature
    try {
      signature = await submitSetPausedTx(paused)
    } catch (error) {
      console.error('admin/rewards/set-paused tx failed:', error?.message || error)
      return apiError(res, 502, 'SET_PAUSED_TX_FAILED',
        `The set_paused transaction failed: ${error?.message || error}`)
    }

    // Re-read on-chain state to confirm the change landed
    let pausedAfter = paused
    try {
      const stateAfter = await getRewardsProgramState()
      pausedAfter = stateAfter.paused
    } catch (error) {
      // The tx succeeded but we couldn't verify — that's OK, the signature
      // is proof that the instruction was submitted.
      console.warn('admin/rewards/set-paused post-tx state read failed:', error?.message)
    }

    return json(res, 200, {
      success: true,
      signature,
      explorer_url: getTxExplorerUrl(signature),
      paused_before: stateBefore.paused,
      paused_after: pausedAfter,
      message: `Rewards are now ${pausedAfter ? 'PAUSED' : 'ACTIVE'} on-chain.`,
    })
  } catch (error) {
    console.error('admin/rewards/set-paused failed:', error?.message || error)
    return apiError(res, 502, 'SET_PAUSED_ERROR', error?.message || 'Unable to update paused state.')
  }
}
