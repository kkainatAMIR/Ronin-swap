import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { recordRewardClaimSubmission } from '../../src/services/rewardsService.js'

const migration = await readFile(new URL('../../supabase/migrations/20261013000000_reward_claim_submission_safety.sql', import.meta.url), 'utf8')
const panel = await readFile(new URL('../../src/components/RewardClaimPanel.jsx', import.meta.url), 'utf8')
const confirmRoute = await readFile(new URL('../../api_routes/rewards/claim-confirm.mjs', import.meta.url), 'utf8')
const cancelRoute = await readFile(new URL('../../api_routes/rewards/claim-cancel.mjs', import.meta.url), 'utf8')
const balanceMigration = await readFile(new URL('../../supabase/migrations/20260926000000_wallet_links.sql', import.meta.url), 'utf8')

const testSignature = '1'.repeat(64)
const claimFixture = {
  claim_id: 'claim-test-lifecycle-001',
  status: 'PENDING_PAYOUT',
  claim_tx_signature: testSignature,
  points_claimed: 125,
}

function sqlFunction(source, name) {
  const start = source.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} should exist`)
  const end = source.indexOf('\n$$;', start)
  assert.notEqual(end, -1, `${name} should have a complete SQL body`)
  return source.slice(start, end + 4)
}

test('signature is persisted before the signed transaction is broadcast', () => {
  const signature = panel.indexOf('const feePayerSignature')
  const persist = panel.indexOf('await recordRewardClaimSubmission', signature)
  const broadcast = panel.indexOf('await sendSignedSolanaTransaction', persist)
  assert.ok(signature >= 0 && persist > signature && broadcast > persist)
  assert.match(panel.slice(signature, broadcast), /if \(!feePayerSignature\)/)
})

test('submission persistence client sends the exact claim and signature using a mocked fetch', async (t) => {
  let requestBody
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestBody = JSON.parse(options.body)
    return Response.json({ success: true, idempotent: false })
  })

  const result = await recordRewardClaimSubmission(claimFixture.claim_id, testSignature, 'wallet-fixture')
  assert.deepEqual(requestBody, {
    action: 'record-submission',
    claimId: claimFixture.claim_id,
    signature: testSignature,
    wallet: 'wallet-fixture',
  })
  assert.equal(result.success, true)
})

test('conflicting signature persistence returns a deterministic conflict to the client', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: 'This claim is already bound to a different transaction signature.',
    code: 'CLAIM_SIGNATURE_CONFLICT',
  }, { status: 409 }))

  await assert.rejects(
    recordRewardClaimSubmission(claimFixture.claim_id, '2'.repeat(64), 'wallet-fixture'),
    (error) => error.code === 'CLAIM_SIGNATURE_CONFLICT',
  )
  assert.match(confirmRoute, /return apiError\(res, 409, 'CLAIM_SIGNATURE_CONFLICT'/)
})

test('same signature is idempotent while a different signature is rejected under the claim lock', () => {
  const fn = sqlFunction(migration, 'record_reward_claim_submission')
  assert.match(fn, /for update/i)
  assert.match(fn, /claim_row\.claim_tx_signature <> p_claim_tx_signature/)
  assert.match(fn, /raise exception 'CLAIM_SIGNATURE_CONFLICT'/)
  assert.match(fn, /was_idempotent := claim_row\.claim_tx_signature = p_claim_tx_signature/)
})

test('a reload can recover the saved signature from recent claims', () => {
  assert.match(balanceMigration, /claim_tx_signature, season_id/)
  assert.match(panel, /handleRetryConfirm\(claim\.claim_id, claim\.claim_tx_signature\)/)
  assert.match(panel, /\['ENTITLED', 'PENDING_PAYOUT'\]\.includes\(claim\.status\)/)
})

test('confirmation completes the same claim without constructing or submitting another payout', () => {
  assert.match(confirmRoute, /callSupabaseRpc\('record_reward_claim_submission'/)
  assert.match(confirmRoute, /callSupabaseRpc\('update_reward_claim_status', \{[\s\S]*p_claim_id: claimId,[\s\S]*p_status: 'COMPLETED',[\s\S]*p_claim_tx_signature: signature/)
  assert.match(sqlFunction(migration, 'update_reward_claim_status'), /claim_row\.status = 'COMPLETED' and p_status = 'COMPLETED'[\s\S]*return to_jsonb\(claim_row\)/)
  assert.doesNotMatch(confirmRoute, /sendSignedSolanaTransaction|buildClaimRewardInstruction/)
  assert.match(panel, /confirmRewardClaim\(claimId, signature, effectiveWallet\)/)
})

test('a confirm failure after persistence remains pending and does not trigger cancellation', () => {
  const catchBlock = panel.slice(panel.indexOf("console.error('[RewardClaimPanel] claim flow FAILED"))
  assert.match(catchBlock, /if \(claimSignature\)/)
  assert.match(catchBlock, /status: 'PENDING_PAYOUT'/)
  assert.ok(catchBlock.indexOf('if (claimSignature)') < catchBlock.indexOf('cancelRewardClaim'))
  assert.match(sqlFunction(migration, 'record_reward_claim_submission'), /status = 'PENDING_PAYOUT'/)
})

test('cancellation without a signature remains possible before submission', () => {
  const revert = sqlFunction(migration, 'revert_reward_claim_internal')
  const cancel = sqlFunction(migration, 'cancel_unsubmitted_reward_claim')
  assert.match(revert, /claim_row\.claim_tx_signature is not null[\s\S]*is distinct from p_expected_signature/)
  assert.match(cancel, /claim_row\.claim_tx_signature is not null[\s\S]*or claim_row\.status <> 'ENTITLED'/)
  assert.match(cancelRoute, /callSupabaseRpc\('cancel_unsubmitted_reward_claim'/)
  assert.match(panel, /claim\.status === 'ENTITLED' && !claim\.claim_tx_signature/)
})

test('cancellation with a saved signature is rejected by the database and API', () => {
  const revert = sqlFunction(migration, 'revert_reward_claim_internal')
  const cancel = sqlFunction(migration, 'cancel_unsubmitted_reward_claim')
  assert.match(revert, /raise exception 'CLAIM_OUTCOME_UNCERTAIN'/)
  assert.match(cancel, /raise exception 'CLAIM_OUTCOME_UNCERTAIN'/)
  assert.match(cancelRoute, /code\.includes\('CLAIM_OUTCOME_UNCERTAIN'\)/)
  assert.match(cancelRoute, /return apiError\(res, 409, 'CLAIM_OUTCOME_UNCERTAIN'/)
})

test('only a definitive on-chain failure can enter the verified-failure reversion path', () => {
  assert.match(confirmRoute, /verification\.safe \|\| verification\.reason !== 'TX_FAILED_ON_CHAIN'/)
  assert.match(confirmRoute, /async function safeRevertFailedClaim[\s\S]*revert_verified_failed_reward_claim[\s\S]*p_claim_tx_signature: signature/)
  assert.match(confirmRoute, /await safeRevertFailedClaim\(\s*claimId,[\s\S]*?signature\s*\)/)
  const revert = sqlFunction(migration, 'revert_reward_claim_internal')
  assert.match(revert, /claim_row\.claim_tx_signature is distinct from p_expected_signature/)
})

test('points are not restored for uncertain signed outcomes', () => {
  const revert = sqlFunction(migration, 'revert_reward_claim_internal')
  const uncertaintyGuard = revert.indexOf("raise exception 'CLAIM_OUTCOME_UNCERTAIN'")
  const pointDelete = revert.indexOf('delete from public.wallet_point_consumption')
  const pointUpdate = revert.indexOf('set claimed_points = new_claimed_points')
  assert.ok(uncertaintyGuard >= 0 && uncertaintyGuard < pointDelete && uncertaintyGuard < pointUpdate)
  assert.match(confirmRoute, /The claim has been left for admin reconciliation — your points were NOT restored/)
})

test('a submitted signature is immutable across status updates', () => {
  const fn = sqlFunction(migration, 'update_reward_claim_status')
  assert.match(fn, /claim_row\.claim_tx_signature <> p_claim_tx_signature/)
  assert.match(fn, /raise exception 'CLAIM_SIGNATURE_CONFLICT'/)
  assert.match(fn, /p_status in \('FAILED', 'CANCELLED'\)/)
})
