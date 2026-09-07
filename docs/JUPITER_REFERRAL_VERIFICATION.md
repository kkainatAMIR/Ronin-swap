# Jupiter Swap V2 Referral Fee — Verification Checklist

For RoninSamurai.com. Swap V2 flow: `GET /swap/v2/order` → sign transaction → `POST /swap/v2/execute`.

## Configured values

| Setting | Value |
| --- | --- |
| Referral account | `Cx98B695q8Dvum68sUdyopp8Gxh4fhZv1QhmE1mgpu47` |
| Referral fee | `50` bps (0.5%) |
| Required project | `DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc` |
| Legacy account (not usable) | `3PwKEvN2UURHW6q4sEL8ZzgzGyzNWeLVs8gqcCdFMV7x` |

## Step 1 — Create the Swap V2 referral account + V2 fee ATAs

The account `Cx98B695…` **does not exist on-chain yet** (Solscan shows “Account not exist
onchain”). Jupiter `/swap/v2/order` currently rejects any referral account that is not
initialized under `DkiqsTrw…`.

Run the Referral SDK setup script on your own machine (it uses `initializeReferralAccountWithName`
and `initializeReferralTokenAccountV2`). It never asks us for a private key.

Dry run (prints unsigned transactions):

```bash
npm run referral:init-ronin -- \
  --payer YOUR_PAYER_PUBLIC_KEY \
  --name RoninSamurai \
  --create-referral-account
```

Sign + send yourself (keyfile on your own machine):

```bash
npm run referral:init-ronin -- \
  --keyfile ~/.config/solana/id.json \
  --name RoninSamurai \
  --create-referral-account
```

This creates:

| Item | Address |
| --- | --- |
| Swap V2 referral account | `Cx98B695q8Dvum68sUdyopp8Gxh4fhZv1QhmE1mgpu47` |
| SOL V2 fee account (ATA) | `91ouzTGLfFUnQVzD64QPHe6MJf6bSGrcimHJk5AuqLXh` |
| USDC V2 fee account (ATA) | `A3dnQZk52dXsJjmpqKpmsLaNbwuVfDpnzYuzGNMfZpVV` |
| USDT V2 fee account (ATA) | `4XkY4izexFFuiGEFJjCHdxXPJpE7x9tngUM2HwX8ARpm` |
| RONIN V2 fee account (ATA) | `4jRAjepVA5GvFxPaz3CA3C1zH6Fis9G6Cr8wjPM9z6q7` |

> After this step, `GET /swap/v2/order` must stop returning the
> “referralAccount is initialized … for project DkiqsTrw…” error.

## Step 2 — Run a small BUY and SELL in the browser

Use a **deployed** version (the Arena sandbox cannot reach `api.jup.ag` or sign transactions).
For each swap, the Review/Result screens must show **REFERRAL FEE APPLIED** and the fields:

- `referralAccount` = `Cx98B695q8Dvum68sUdyopp8Gxh4fhZv1QhmE1mgpu47`
- `feeBps` = `50`
- `platformFee.feeBps` = `0`
- `feeMint` = one of SOL / USDC / USDT / RONIN (Jupiter chooses based on priority, usually SOL)

After each swap, the success screen should show **Fee collected: <amount> <mint>** (derived from
`/execute` input/output accounting).

## Step 3 — Send back the two signatures

Paste back both signatures and the fee mint(s):

- BUY signature
- SELL signature
- Fee token(s) collected

I will then confirm on Solscan:

- transaction status = Success,
- the fee transfer to the correct V2 fee account for the reported `feeMint`,
- the fee amount matches 0.5% of the swap value.

Only when both `/order` returns the referral account and the fees are visible on-chain do we
consider the integration verified.
