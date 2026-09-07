#!/usr/bin/env node
/**
 * Prepare Jupiter Swap V2 / Ultra referral accounts with the Referral SDK.
 *
 * The live /swap/v2/order endpoint requires the referral account AND its V2
 * referral fee accounts (ATAs owned by the referral account) to be initialized
 * under the Jupiter Swap V2 / Ultra Referral Project:
 *
 *   DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc
 *
 * The legacy Swap/Trigger project
 *
 *   45ruCyfdRkWpRNGEqWzjCiXRHkZs8WXCLQ67Pnpye7Hp
 *
 * is NOT accepted by /swap/v2/order. Existing accounts created from the old
 * dashboard (e.g. 3PwKEvN2UURHW6q4sEL8ZzgzGyzNWeLVs8gqcCdFMV7x) are under that
 * legacy project and therefore cannot collect fees through /swap/v2/order.
 *
 * This script defaults to the Dkiqs project, name "RoninSamurai", and builds
 * transactions for the referral account plus the V2 ATA fee accounts for RONIN,
 * SOL, USDC and USDT (override with --mints).
 *
 * IMPORTANT:
 * - This script NEVER asks for, reads, or sends a private key over chat.
 * - By default it only BUILDS unsigned transactions and prints them. You sign
 *   the transactions yourself.
 * - If you supply a Solana CLI keypair on a machine you own (--keyfile), it
 *   will sign and send the transactions for you.
 * - Provide --create-referral-account to build the account creation tx too.
 *
 * Usage (dry run — prints unsigned transactions):
 *
 *   node scripts/referral-init-ronin.mjs \
 *     --payer YOUR_PAYER_PUBLIC_KEY \
 *     --name RoninSamurai \
 *     --create-referral-account
 *
 * Sign + send yourself (keyfile on your own machine):
 *
 *   node scripts/referral-init-ronin.mjs \
 *     --keyfile ~/.config/solana/id.json \
 *     --name RoninSamurai \
 *     --create-referral-account
 */
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js'
import { ReferralProvider } from '@jup-ag/referral-sdk'
import fs from 'node:fs'
import path from 'node:path'

const REFERRAL_PROGRAM = 'REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3'
const SWAP_V2_PROJECT = 'DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc'
const DEFAULT_MINTS = [
  ['RONIN', '2JVEVXoRsskapZ8T56MjMNJq6Dk3feEUYSRmzkkipump'],
  ['SOL', 'So11111111111111111111111111111111111111112'],
  ['USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  ['USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'],
]
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com'

function arg(name) {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function loadKeypair(filePath) {
  const resolved = path.resolve(filePath)
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8').trim())
  return Keypair.fromSecretKey(new Uint8Array(raw))
}

function selectedMints() {
  const raw = arg('--mints')
  if (!raw) return DEFAULT_MINTS
  return raw.split(',').map((part) => part.trim()).filter(Boolean).map((entry) => {
    const [label, mint] = entry.split('=')
    return [label || 'token', mint]
  })
}

async function main() {
  const projectRaw = arg('--project') || process.env.JUPITER_REFERRAL_PROJECT || SWAP_V2_PROJECT
  const name = arg('--name') || 'RoninSamurai'
  const referralAccountRaw = arg('--referral-account') || process.env.JUPITER_REFERRAL_ACCOUNT
  const payerRaw = arg('--payer') || process.env.PAYER_PUBLIC_KEY
  const rpc = arg('--rpc') || process.env.SOLANA_RPC_URL || DEFAULT_RPC
  const keyfile = arg('--keyfile')
  const createReferral = hasFlag('--create-referral-account')
  const dryRun = hasFlag('--dry-run') || !keyfile

  if (!payerRaw && !keyfile) throw new Error('Missing --payer public key (the wallet that will sign/init the account).')

  const connection = new Connection(rpc, 'confirmed')
  const provider = new ReferralProvider(connection)
  const project = new PublicKey(projectRaw)
  const payerPubKey = keyfile ? loadKeypair(keyfile).publicKey : new PublicKey(payerRaw)
  const mints = selectedMints()

  const derivedReferral = provider.getReferralAccountWithNamePubKey({ projectPubKey: project, name })
  const referralAccount = referralAccountRaw ? new PublicKey(referralAccountRaw) : derivedReferral

  console.log('Project         :', project.toBase58())
  console.log('Name            :', name)
  console.log('Referral account:', referralAccount.toBase58())
  console.log('RPC             :', rpc)
  console.log('Mints           :', mints.map(([l, m]) => `${l}=${m}`).join(', '))

  const referralInfo = await connection.getAccountInfo(referralAccount)
  console.log('\nReferral account status:', referralInfo ? 'INITIALIZED' : 'NOT INITIALIZED (must be created)')

  const unsignedTxns = []
  if (!referralInfo && createReferral) {
    const created = await provider.initializeReferralAccountWithName({
      projectPubKey: project,
      partnerPubKey: payerPubKey,
      payerPubKey,
      name,
    })
    unsignedTxns.push({ label: 'initializeReferralAccountWithName', tx: created.tx })
    console.log('\nBuilt initializeReferralAccountWithName tx for:', created.referralAccountPubKey.toBase58())
  } else if (!referralInfo && !createReferral) {
    console.log('\n⚠ Referral account does not exist. Run with --create-referral-account')
    console.log(`to build its creation tx under project ${project.toBase58()}.`)
  }

  for (const [label, mintRaw] of mints) {
    const mint = new PublicKey(mintRaw)
    const feeAccount = provider.getReferralTokenAccountPubKeyV2({
      referralAccountPubKey: referralAccount,
      tokenProgramId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      mint,
    })
    const accountInfo = await connection.getAccountInfo(feeAccount)
    console.log(`V2 fee account ${label}: ${feeAccount.toBase58()} => ${accountInfo ? 'EXISTS' : 'NOT INITIALIZED'}`)
    if (accountInfo) continue
    const created = await provider.initializeReferralTokenAccountV2({
      payerPubKey,
      referralAccountPubKey: referralAccount,
      mint,
    })
    unsignedTxns.push({ label: `initializeReferralTokenAccountV2 (${label})`, tx: created.tx })
  }

  if (dryRun) {
    console.log('\nDRY RUN — sign and send the following transactions yourself:')
    if (!unsignedTxns.length) {
      console.log('  (nothing to do; accounts already initialized)')
    }
    for (const item of unsignedTxns) {
      const b64 = Buffer.from(item.tx.serialize()).toString('base64')
      console.log(`\n[${item.label}] base64:`)
      console.log(b64)
    }
    console.log('\nNever paste a private key here. The correct Swap V2 referral account')
    console.log(`for name "${name}" under project ${project.toBase58()} is derived automatically.`)
    return
  }

  if (!keyfile) throw new Error('--keyfile is required to sign and send.')

  const signer = loadKeypair(keyfile)
  for (let i = 0; i < unsignedTxns.length; i++) {
    const item = unsignedTxns[i]
    console.log(`\nSending ${item.label}...`)
    const signature = await sendAndConfirmTransaction(connection, item.tx, [signer], { commitment: 'confirmed' })
    console.log(`Signature ${i + 1}/${unsignedTxns.length}:`, signature)
    console.log(`https://solscan.io/tx/${signature}`)
  }
}

main().catch((error) => {
  console.error('Referral setup failed:', error.message || error)
  process.exit(1)
})
