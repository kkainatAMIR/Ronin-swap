import * as bip39 from "bip39";
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";
import readline from "readline";

const TARGET_PUBLIC_KEY =
  "Askr5PWLAm1ukcoHE8nHQh9MEdxD4RtJ1f1qGQD7U9Wn";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("Paste your Phantom recovery phrase here (LOCAL ONLY): ", (mnemonic) => {
  mnemonic = mnemonic.trim();

  if (!bip39.validateMnemonic(mnemonic)) {
    console.error("\n❌ Invalid recovery phrase.");
    rl.close();
    return;
  }

  console.log("\nDeriving Solana accounts...\n");

  // Phantom commonly uses this Solana derivation path.
  // We check several account indexes because Phantom can have
  // multiple Solana accounts under the same recovery phrase.

  for (let account = 0; account < 10; account++) {
    const path = `m/44'/501'/${account}'/0'`;

    try {
      const seed = bip39.mnemonicToSeedSync(mnemonic);
      const derived = derivePath(path, seed.toString("hex")).key;
      const keypair = Keypair.fromSeed(derived);

      const publicKey = keypair.publicKey.toBase58();

      console.log(`Account ${account}`);
      console.log(`Path: ${path}`);
      console.log(`Public Key: ${publicKey}`);

      if (publicKey === TARGET_PUBLIC_KEY) {
        console.log("\n========================================");
        console.log("✅ TARGET ADMIN WALLET FOUND");
        console.log("========================================");
        console.log(`Public Key: ${publicKey}`);
        console.log(`Derivation Path: ${path}`);
        console.log("\nSOLANA_REWARDS_ADMIN_SECRET_KEY=");
        console.log(JSON.stringify(Array.from(keypair.secretKey)));
        console.log("\n========================================");
        console.log("⚠️ Keep the secret array PRIVATE.");
        console.log("========================================");

        rl.close();
        return;
      }

      console.log("");
    } catch (error) {
      console.error(`Account ${account} failed:`, error.message);
    }
  }

  console.log("❌ Target public key was not found in accounts 0-9.");
  console.log(
    "Check that this recovery phrase belongs to the Phantom wallet containing the target admin account."
  );

  rl.close();
});