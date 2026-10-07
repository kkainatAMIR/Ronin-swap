import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  recordRewardClaimBroadcastAcknowledgment,
  recordRewardClaimBroadcastAttempt,
  recordRewardClaimBroadcastOutcome,
} from '../../src/services/rewardsService.js'
import { classifySolanaBroadcastRpcError } from '../../src/services/solanaBroadcastOutcome.js'

const migration = await readFile(new URL('../../supabase/migrations/20261014000000_reward_claim_broadcast_state.sql', import.meta.url), 'utf8')
const panel = await readFile(new URL('../../src/components/RewardClaimPanel.jsx', import.meta.url), 'utf8')
const confirmRoute = await readFile(new URL('../../api_routes/rewards/claim-confirm.mjs', import.meta.url), 'utf8')
const rpcProxy = await readFile(new URL('../../api_routes/solana/rpc.mjs', import.meta.url), 'utf8')

const claimId = 'claim-test-broadcast-001'
const signature = '1'.repeat(64)

test('broadcast attempt is durably recorded after signature persistence and before send', () => {
  const signaturePersist = panel.indexOf('await recordRewardClaimSubmission')
  const attempt = panel.indexOf('await recordRewardClaimBroadcastAttempt')
  const send = panel.indexOf('await sendSignedSolanaTransaction')
  assert.ok(signaturePersist >= 0 && attempt > signaturePersist && send > attempt)
  assert.match(migration, /new\.broadcast_status := 'SIGNED'/)
  assert.match(migration, /broadcast_attempted_at timestamptz/)
  assert.match(migration, /when next_status in \('ATTEMPTED', 'ACKNOWLEDGED', 'UNKNOWN', 'REJECTED'\)[\s\S]*then coalesce\(broadcast_attempted_at, now\(\)\)/)
})

test('attempt-recording API failure prevents the broadcast call', () => {
  const attempt = panel.indexOf('await recordRewardClaimBroadcastAttempt')
  const send = panel.indexOf('await sendSignedSolanaTransaction')
  assert.ok(attempt >= 0 && send > attempt)
  assert.match(panel.slice(attempt, send), /broadcastAttemptRecorded = true/)
})

test('attempt action persists the exact claim signature through the existing authenticated route', async (t) => {
  let requestBody
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestBody = JSON.parse(options.body)
    return Response.json({ success: true, broadcast_status: 'ATTEMPTED' })
  })

  const result = await recordRewardClaimBroadcastAttempt(claimId, signature, 'wallet-fixture')
  assert.deepEqual(requestBody, {
    action: 'record-broadcast-attempt',
    claimId,
    signature,
    wallet: 'wallet-fixture',
  })
  assert.equal(result.broadcast_status, 'ATTEMPTED')
})

test('matching RPC signature is compared before durable acknowledgment and confirmation', () => {
  const send = panel.indexOf('await sendSignedSolanaTransaction')
  const compare = panel.indexOf('if (signature !== claimSignature)', send)
  const ack = panel.indexOf('await recordRewardClaimBroadcastAcknowledgment', compare)
  const confirm = panel.indexOf('await confirmRewardClaim', ack)
  assert.ok(send >= 0 && compare > send && ack > compare && confirm > ack)
  assert.match(migration, /broadcast_acknowledged_at = case[\s\S]*then coalesce\(broadcast_acknowledged_at, now\(\)/)
  assert.match(migration, /next_status := 'ACKNOWLEDGED'/)
  assert.doesNotMatch(migration, /set status = 'COMPLETED'/)
})

test('transport failures are recorded as uncertain and never enter cancellation or point restoration', () => {
  assert.match(panel, /recordRewardClaimBroadcastOutcome\(claimId, claimSignature, effectiveWallet, 'unknown'\)/)
  assert.match(panel, /broadcast outcome is uncertain/)
  assert.match(migration, /next_status := 'UNKNOWN'/)
  assert.match(confirmRoute, /The claim remains recoverable; do not cancel or submit another payout/)
})

test('only explicit Solana preflight/signature rejection codes are definitive', () => {
  assert.equal(classifySolanaBroadcastRpcError({ code: -32002 }), 'SOLANA_RPC_REJECTED')
  assert.equal(classifySolanaBroadcastRpcError({ code: -32003 }), 'SOLANA_RPC_REJECTED')
  assert.equal(classifySolanaBroadcastRpcError({ code: -32603 }), 'SOLANA_BROADCAST_OUTCOME_UNKNOWN')
  assert.equal(classifySolanaBroadcastRpcError({
    code: -32002,
    message: 'Transaction simulation failed: already processed',
  }), 'SOLANA_BROADCAST_OUTCOME_UNKNOWN')
  assert.match(panel, /recordRewardClaimBroadcastOutcome\([\s\S]*?effectiveWallet,[\s\S]*?'rejected'/)
  assert.match(migration, /p_broadcast_status = 'REJECTED'[\s\S]*broadcast_status = 'REJECTED'/)
  assert.match(migration, /broadcast_status = 'REJECTED'[\s\S]*public\.revert_reward_claim_internal\(/)
  assert.match(migration, /'SOLANA_RPC_REJECTED_BEFORE_BROADCAST'/)
  assert.match(migration, /claim_row\.status = 'FAILED'[\s\S]*claim_row\.broadcast_status = 'REJECTED'[\s\S]*'ALREADY_FAILED'/)
})

test('JSON-RPC errors after proxy transport failures remain uncertain', () => {
  assert.equal(classifySolanaBroadcastRpcError(
    { code: -32002 },
    ['Helius timed out'],
  ), 'SOLANA_BROADCAST_OUTCOME_UNKNOWN')
  assert.match(rpcProxy, /failures\.length[\s\S]*proxyTransportFailures: failures/)
})

test('a returned signature mismatch is never acknowledged or confirmed', () => {
  const compare = panel.indexOf('if (signature !== claimSignature)')
  const throwMismatch = panel.indexOf('throw new Error', compare)
  const ack = panel.indexOf('await recordRewardClaimBroadcastAcknowledgment', compare)
  assert.ok(compare >= 0 && throwMismatch > compare && ack > throwMismatch)
  assert.match(panel, /if \(signature !== claimSignature\) \{[\s\S]*throw new Error/)
})

test('broadcast acknowledgment and on-chain confirmation remain separate operations', async (t) => {
  let requestBody
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestBody = JSON.parse(options.body)
    return Response.json({ success: true, broadcast_status: 'ACKNOWLEDGED' })
  })
  const result = await recordRewardClaimBroadcastAcknowledgment(claimId, signature, 'wallet-fixture')
  assert.equal(requestBody.action, 'record-broadcast-acknowledgment')
  assert.equal(result.broadcast_status, 'ACKNOWLEDGED')
  assert.match(confirmRoute, /callSupabaseRpc\('update_reward_claim_status', \{[\s\S]*p_status: 'COMPLETED'/)
  assert.doesNotMatch(confirmRoute, /sendSignedSolanaTransaction|buildClaimRewardInstruction/)
})

test('unknown and rejected state writes use only mocked service requests', async (t) => {
  const actions = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    actions.push(JSON.parse(options.body).action)
    return Response.json({ success: true })
  })
  await recordRewardClaimBroadcastOutcome(claimId, signature, 'wallet-fixture', 'unknown')
  await recordRewardClaimBroadcastOutcome(claimId, signature, 'wallet-fixture', 'rejected')
  assert.deepEqual(actions, ['record-broadcast-unknown', 'record-broadcast-rejected'])
})
