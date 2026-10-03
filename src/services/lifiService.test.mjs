import test from 'node:test'
import assert from 'node:assert/strict'

import { getLifiApprovalRequest } from './lifiService.js'

const tokenAddress = '0x1111111111111111111111111111111111111111'
const spenderAddress = '0x2222222222222222222222222222222222222222'
const approvalData = '0x095ea7b3' + '0'.repeat(120)
const swapData = '0x12345678' + 'a'.repeat(64)

test('uses explicit approval calldata instead of swap transaction calldata', () => {
  const result = getLifiApprovalRequest({
    action: { approval: { to: spenderAddress, data: approvalData } },
    transactionRequest: { to: spenderAddress, data: swapData, gas: '0x5208' },
  })

  assert.deepEqual(result, {
    to: spenderAddress,
    data: approvalData,
    value: '0x0',
    gas: undefined,
  })
})

test('uses transaction data as approval only when it is an ERC-20 approve call', () => {
  const result = getLifiApprovalRequest({
    transactionRequest: {
      approvalTo: spenderAddress,
      data: approvalData,
      approvalGasLimit: '0x7530',
    },
  })

  assert.deepEqual(result, {
    to: spenderAddress,
    data: approvalData,
    value: '0x0',
    gas: '0x7530',
  })
})

test('does not mistake swap calldata for an approval', () => {
  assert.equal(getLifiApprovalRequest({
    transactionRequest: { approveTo: tokenAddress, data: swapData },
  }), null)
})
