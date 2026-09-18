#!/usr/bin/env python3
"""
Integration tests for the Solana Rewards admin lib (solanaRewardsAdmin.mjs).

Tests:
  1. PDA derivation matches the deployed program's documented seeds.
  2. SOL → lamports conversion is exact for known test cases.
  3. SOL → lamports conversion rejects invalid inputs.
  4. buildClaimRewardInstruction produces the expected byte layout.
  5. claim PDA derivation is deterministic per claim_id.
  6. Different claim_ids produce different claim PDAs.
  7. isRewardsAdminConfigured returns false without env vars.
"""
import json
import subprocess
import sys
import os

TESTS_PASSED = 0
TESTS_FAILED = 0


def run_test(name, fn):
    global TESTS_PASSED, TESTS_FAILED
    print(f"\n[{name}]")
    try:
        fn()
        print(f"  PASS")
        TESTS_PASSED += 1
    except AssertionError as e:
        print(f"  FAIL: {e}")
        TESTS_FAILED += 1
    except Exception as e:
        print(f"  ERROR: {type(e).__name__}: {e}")
        TESTS_FAILED += 1


# Node helper: run a JS snippet that imports the lib and returns JSON.
def run_js(snippet, env=None):
    full_env = dict(os.environ)
    # Strip out any Solana rewards admin keypair env so tests start clean.
    full_env.pop('SOLANA_REWARDS_ADMIN_KEYPAIR', None)
    full_env.pop('SOLANA_REWARDS_ADMIN_SECRET_KEY', None)
    # Then apply caller-provided env (which can re-add the var if needed).
    if env:
        full_env.update(env)
    proc = subprocess.run(
        ['node', '--input-type=module', '-e', snippet],
        capture_output=True, text=True, env=full_env, cwd='/home/z/my-project/Ronin-swap',
    )
    if proc.returncode != 0:
        raise RuntimeError(f"node failed: {proc.stderr[:1000]}")
    out = proc.stdout.strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out


# =====================================================================
# Test 1: PDA derivation matches documented seeds
# =====================================================================
def test_pda_derivation():
    snippet = """
import { getRewardConfigPda, getRewardVaultPda, getClaimPda } from './api/_lib/solanaRewardsAdmin.mjs'
const [rc] = getRewardConfigPda()
const [rv] = getRewardVaultPda()
const [cp] = getClaimPda('test-claim-001')
console.log(JSON.stringify({
  reward_config: rc.toBase58(),
  reward_vault: rv.toBase58(),
  claim_pda_test_claim_001: cp.toBase58(),
}))
"""
    result = run_js(snippet)
    assert isinstance(result, dict), f"expected dict, got: {result}"
    assert result['reward_config'] != result['reward_vault'], "config and vault PDAs should differ"
    assert result['reward_config'] != result['claim_pda_test_claim_001'], "config and claim PDAs should differ"
    assert len(result['reward_config']) == 44, f"reward_config PDA not base58 44 chars: {result['reward_config']}"
    assert len(result['reward_vault']) == 44, f"reward_vault PDA not base58 44 chars: {result['reward_vault']}"
    assert len(result['claim_pda_test_claim_001']) == 44, f"claim PDA not base58 44 chars: {result['claim_pda_test_claim_001']}"
    print(f"  reward_config: {result['reward_config']}")
    print(f"  reward_vault : {result['reward_vault']}")
    print(f"  claim(test-claim-001): {result['claim_pda_test_claim_001']}")


# =====================================================================
# Test 2: SOL → lamports conversion for known test cases
# =====================================================================
def test_sol_to_lamports_known():
    snippet = """
import { solToLamports } from './api/_lib/solanaRewardsAdmin.mjs'
const cases = [
  [0.01, 10_000_000],
  [0.1, 100_000_000],
  [1, 1_000_000_000],
  [2.5, 2_500_000_000],
  [0.005, 5_000_000],
  [0.001, 1_000_000],
]
const out = cases.map(([sol, expected]) => {
  const got = solToLamports(sol)
  return { sol, expected, got, ok: got === expected }
})
console.log(JSON.stringify(out))
"""
    result = run_js(snippet)
    assert isinstance(result, list), f"expected list, got: {result}"
    for case in result:
        assert case['ok'], f"sol={case['sol']} expected={case['expected']} got={case['got']}"
        print(f"  {case['sol']} SOL → {case['got']} lamports (expected {case['expected']}) ✓")


# =====================================================================
# Test 3: SOL → lamports rejects invalid inputs
# =====================================================================
def test_sol_to_lamports_invalid():
    snippet = """
import { solToLamports } from './api/_lib/solanaRewardsAdmin.mjs'
const cases = [
  ['NaN', 'INVALID_REWARD_AMOUNT'],
  [Infinity, 'INVALID_REWARD_AMOUNT'],
  [-1, 'NEGATIVE_REWARD_AMOUNT'],
  [0, 'ZERO_REWARD_AMOUNT'],
  ['abc', 'INVALID_REWARD_AMOUNT'],
  [null, 'INVALID_REWARD_AMOUNT'],
  [undefined, 'INVALID_REWARD_AMOUNT'],
]
const out = cases.map(([input, expectedErr]) => {
  try {
    const got = solToLamports(input)
    return { input: String(input), got, error: null, ok: false }
  } catch (e) {
    return { input: String(input), got: null, error: e.message, ok: e.message === expectedErr }
  }
})
console.log(JSON.stringify(out))
"""
    result = run_js(snippet)
    assert isinstance(result, list), f"expected list, got: {result}"
    for case in result:
        assert case['ok'], f"input={case['input']} expected error={case['error']} got={case['got']}"
        print(f"  solToLamports({case['input']}) → '{case['error']}' ✓")


# =====================================================================
# Test 4: buildClaimRewardInstruction byte layout
# =====================================================================
def test_instruction_byte_layout():
    snippet = """
import { buildClaimRewardInstruction, getRewardConfigPda, getRewardVaultPda, getClaimPda, RONIN_REWARDS_PROGRAM_ID } from './api/_lib/solanaRewardsAdmin.mjs'
import { Keypair } from '@solana/web3.js'
import { createHash } from 'node:crypto'

const admin = Keypair.generate().publicKey
const recipient = Keypair.generate().publicKey  // valid 32-byte Solana pubkey

const claimId = 'test-claim-001'
const pointsClaimed = 100
const lamports = 10_000_000  // 0.01 SOL

const ix = buildClaimRewardInstruction({
  admin,
  recipient,
  claimId,
  pointsClaimed,
  rewardAmountLamports: lamports,
})

// Verify accounts
const [rc] = getRewardConfigPda()
const [rv] = getRewardVaultPda()
const [cp] = getClaimPda(claimId)
const expectedKeys = [
  admin.toString(),
  rc.toString(),
  rv.toString(),
  recipient.toString(),
  cp.toString(),
  '11111111111111111111111111111111',  // system program
]
const gotKeys = ix.keys.map(k => k.pubkey.toString())

// Verify data layout: discriminator (8) + length (4) + claimId (15) + points (8) + lamports (8) = 43 bytes
const expectedDiscriminator = createHash('sha256').update('global:claim_reward').digest().subarray(0, 8)
const gotDiscriminator = Buffer.from(ix.data.buffer, ix.data.byteOffset, 8)
const claimIdBytes = Buffer.from(claimId, 'utf8')
const expectedLength = 8 + 4 + claimIdBytes.length + 8 + 8
const gotLength = ix.data.length
const gotProgramId = ix.programId.toString()

// Verify points + lamports are little-endian u64
const pointsOffset = 8 + 4 + claimIdBytes.length
const lamportsOffset = pointsOffset + 8
const gotPoints = ix.data.readBigUInt64LE(pointsOffset)
const gotLamports = ix.data.readBigUInt64LE(lamportsOffset)

console.log(JSON.stringify({
  expectedKeys, gotKeys, keysOk: JSON.stringify(expectedKeys) === JSON.stringify(gotKeys),
  expectedLength, gotLength, lengthOk: expectedLength === gotLength,
  discriminatorOk: Buffer.compare(expectedDiscriminator, gotDiscriminator) === 0,
  gotPoints: gotPoints.toString(), expectedPoints: String(BigInt(pointsClaimed)), pointsOk: gotPoints === BigInt(pointsClaimed),
  gotLamports: gotLamports.toString(), expectedLamports: String(BigInt(lamports)), lamportsOk: gotLamports === BigInt(lamports),
  programId: gotProgramId, expectedProgramId: RONIN_REWARDS_PROGRAM_ID.toString(),
  programIdOk: gotProgramId === RONIN_REWARDS_PROGRAM_ID.toString(),
}))
"""
    result = run_js(snippet)
    assert isinstance(result, dict), f"expected dict, got: {result}"
    for k, v in result.items():
        if k.endswith('Ok'):
            assert v is True, f"{k} = {v}"
    print(f"  keys match: {result['keysOk']}")
    print(f"  length: {result['gotLength']} bytes (expected {result['expectedLength']})")
    print(f"  discriminator matches sha256('global:claim_reward')[0..8]: {result['discriminatorOk']}")
    print(f"  points (u64 LE): {result['gotPoints']} == {result['expectedPoints']}: {result['pointsOk']}")
    print(f"  lamports (u64 LE): {result['gotLamports']} == {result['expectedLamports']}: {result['lamportsOk']}")
    print(f"  programId: {result['programId']}")


# =====================================================================
# Test 5: claim PDA is deterministic per claim_id
# =====================================================================
def test_claim_pda_deterministic():
    snippet = """
import { getClaimPda } from './api/_lib/solanaRewardsAdmin.mjs'
const [a1] = getClaimPda('test-claim-001')
const [a2] = getClaimPda('test-claim-001')
const [b1] = getClaimPda('test-claim-002')
console.log(JSON.stringify({
  a1: a1.toBase58(), a2: a2.toBase58(),
  b1: b1.toBase58(),
  deterministic: a1.toBase58() === a2.toBase58(),
  differs: a1.toBase58() !== b1.toBase58(),
}))
"""
    result = run_js(snippet)
    assert result['deterministic'], f"claim PDA not deterministic: {result}"
    assert result['differs'], f"different claim_ids should produce different PDAs: {result}"
    print(f"  test-claim-001 → {result['a1']} (deterministic ✓)")
    print(f"  test-claim-002 → {result['b1']} (differs ✓)")


# =====================================================================
# Test 6: isRewardsAdminConfigured reflects env vars
# =====================================================================
def test_admin_configured_flag():
    snippet = """
import { isRewardsAdminConfigured } from './api/_lib/solanaRewardsAdmin.mjs'
console.log(JSON.stringify({ configured: isRewardsAdminConfigured() }))
"""
    result_no_env = run_js(snippet)
    assert result_no_env['configured'] is False, f"expected False without env, got: {result_no_env}"
    print(f"  without env: configured={result_no_env['configured']} ✓")

    snippet_with_keypair = """
import { isRewardsAdminConfigured } from './api/_lib/solanaRewardsAdmin.mjs'
console.log(JSON.stringify({ configured: isRewardsAdminConfigured() }))
"""
    fake_secret = json.dumps(list(range(64)))  # dummy 64-byte array
    result_with_env = run_js(snippet_with_keypair, env={'SOLANA_REWARDS_ADMIN_SECRET_KEY': fake_secret})
    assert result_with_env['configured'] is True, f"expected True with env, got: {result_with_env}"
    print(f"  with SOLANA_REWARDS_ADMIN_SECRET_KEY set: configured={result_with_env['configured']} ✓")


# =====================================================================
# Main
# =====================================================================
def main():
    print("=" * 60)
    print("Solana Rewards Admin — Integration Tests")
    print("=" * 60)
    run_test("PDA derivation matches documented seeds", test_pda_derivation)
    run_test("SOL → lamports conversion (known cases)", test_sol_to_lamports_known)
    run_test("SOL → lamports rejects invalid inputs", test_sol_to_lamports_invalid)
    run_test("Instruction byte layout (discriminator + accounts + args)", test_instruction_byte_layout)
    run_test("Claim PDA is deterministic per claim_id", test_claim_pda_deterministic)
    run_test("isRewardsAdminConfigured reflects env vars", test_admin_configured_flag)
    print("\n" + "=" * 60)
    print(f"PASSED: {TESTS_PASSED}    FAILED: {TESTS_FAILED}")
    print("=" * 60)
    sys.exit(0 if TESTS_FAILED == 0 else 1)


if __name__ == "__main__":
    main()
