import * as anchor from "@coral-xyz/anchor";

describe("ronin_rewards", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.RoninRewards;
  const admin = provider.wallet;

  let rewardConfig: anchor.web3.PublicKey;
  let rewardVault: anchor.web3.PublicKey;

  // ============================================================
  // SHA-256 IMPLEMENTATION
  // ============================================================
  //
  // The Rust contract uses:
  //
  // hash(claim_id.as_bytes())
  //
  // Solana's hash() = SHA-256.
  //
  // Solana Playground does not expose:
  //   - TextEncoder
  //   - Node crypto
  //   - @solana/web3.js hash
  //   - Anchor internal sha256
  //
  // Therefore we implement SHA-256 directly here.
  //
  // This returns the exact 32 bytes required by the PDA:
  //
  // ["claim", reward_config, SHA256(claim_id)]
  //
  // ============================================================

  function sha256(input: string): Uint8Array {
    const K = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);

    let H0 = 0x6a09e667;
    let H1 = 0xbb67ae85;
    let H2 = 0x3c6ef372;
    let H3 = 0xa54ff53a;
    let H4 = 0x510e527f;
    let H5 = 0x9b05688c;
    let H6 = 0x1f83d9ab;
    let H7 = 0x5be0cd19;

    // Convert JS string to UTF-8 bytes without TextEncoder.
    const bytes: number[] = [];

    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i);

      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
        const next = input.charCodeAt(i + 1);

        if (next >= 0xdc00 && next <= 0xdfff) {
          const codePoint = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);

          bytes.push(
            0xf0 | (codePoint >> 18),
            0x80 | ((codePoint >> 12) & 0x3f),
            0x80 | ((codePoint >> 6) & 0x3f),
            0x80 | (codePoint & 0x3f)
          );

          i++;
        } else {
          bytes.push(0xef, 0xbf, 0xbd);
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        bytes.push(0xef, 0xbf, 0xbd);
      } else {
        bytes.push(
          0xe0 | (code >> 12),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      }
    }

    // ----------------------------------------------------------
    // SHA-256 padding
    // ----------------------------------------------------------

    const bitLength = bytes.length * 8;

    bytes.push(0x80);

    while (bytes.length % 64 !== 56) {
      bytes.push(0);
    }

    // Append original length as 64-bit big endian.
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;

    bytes.push(
      (high >>> 24) & 0xff,
      (high >>> 16) & 0xff,
      (high >>> 8) & 0xff,
      high & 0xff,
      (low >>> 24) & 0xff,
      (low >>> 16) & 0xff,
      (low >>> 8) & 0xff,
      low & 0xff
    );

    // ----------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------

    const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

    const ch = (x: number, y: number, z: number) => (x & y) ^ (~x & z);

    const maj = (x: number, y: number, z: number) =>
      (x & y) ^ (x & z) ^ (y & z);

    const sigma0 = (x: number) => rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22);

    const sigma1 = (x: number) => rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25);

    const gamma0 = (x: number) => rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);

    const gamma1 = (x: number) => rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10);

    // ----------------------------------------------------------
    // Process 512-bit blocks
    // ----------------------------------------------------------

    const W = new Uint32Array(64);

    for (let offset = 0; offset < bytes.length; offset += 64) {
      for (let t = 0; t < 16; t++) {
        const i = offset + t * 4;

        W[t] =
          ((bytes[i] << 24) |
            (bytes[i + 1] << 16) |
            (bytes[i + 2] << 8) |
            bytes[i + 3]) >>>
          0;
      }

      for (let t = 16; t < 64; t++) {
        W[t] =
          (gamma1(W[t - 2]) + W[t - 7] + gamma0(W[t - 15]) + W[t - 16]) >>> 0;
      }

      let a = H0;
      let b = H1;
      let c = H2;
      let d = H3;
      let e = H4;
      let f = H5;
      let g = H6;
      let h = H7;

      for (let t = 0; t < 64; t++) {
        const T1 = (h + sigma1(e) + ch(e, f, g) + K[t] + W[t]) >>> 0;

        const T2 = (sigma0(a) + maj(a, b, c)) >>> 0;

        h = g;
        g = f;
        f = e;
        e = (d + T1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (T1 + T2) >>> 0;
      }

      H0 = (H0 + a) >>> 0;
      H1 = (H1 + b) >>> 0;
      H2 = (H2 + c) >>> 0;
      H3 = (H3 + d) >>> 0;
      H4 = (H4 + e) >>> 0;
      H5 = (H5 + f) >>> 0;
      H6 = (H6 + g) >>> 0;
      H7 = (H7 + h) >>> 0;
    }

    const result = new Uint8Array(32);

    const words = [H0, H1, H2, H3, H4, H5, H6, H7];

    for (let i = 0; i < words.length; i++) {
      const value = words[i];

      result[i * 4] = (value >>> 24) & 0xff;

      result[i * 4 + 1] = (value >>> 16) & 0xff;

      result[i * 4 + 2] = (value >>> 8) & 0xff;

      result[i * 4 + 3] = value & 0xff;
    }

    return result;
  }

  // ============================================================
  // SETUP
  // ============================================================

  before(async () => {
    [rewardConfig] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward_config")],
      program.programId
    );

    [rewardVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault")],
      program.programId
    );

    console.log("");
    console.log("=================================");
    console.log("RONIN REWARDS TEST");
    console.log("=================================");
    console.log("Program:", program.programId.toBase58());
    console.log("Admin:", admin.publicKey.toBase58());
    console.log("Reward Config:", rewardConfig.toBase58());
    console.log("Reward Vault:", rewardVault.toBase58());
    console.log("=================================");
    console.log("");
  });

  // ============================================================
  // 1. INITIALIZE
  // ============================================================

  it("initializes the reward system", async () => {
    try {
      await program.methods
        .initialize()
        .accounts({
          admin: admin.publicKey,
          rewardConfig,
          rewardVault,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      console.log("✅ Initialize successful");
    } catch (err) {
      console.log("ℹ️ Initialize was already completed.");
    }

    const config = await program.account.rewardConfig.fetch(rewardConfig);

    console.log("Admin:", config.admin.toBase58());

    console.log("Paused:", config.paused);

    console.log("Total Claims:", config.totalClaims.toString());

    console.log("Total Claimed:", config.totalClaimed.toString());

    if (!config.admin.equals(admin.publicKey)) {
      throw new Error("Reward config admin does not match test wallet");
    }

    if (config.paused !== false) {
      throw new Error("Reward system should be unpaused");
    }

    console.log("✅ Reward config verified");
  });

  // ============================================================
  // 2. FUND VAULT
  // ============================================================

  it("funds the reward vault", async () => {
    const amount = new anchor.BN(100_000_000);

    await program.methods
      .fundVault(amount)
      .accounts({
        admin: admin.publicKey,
        rewardConfig,
        rewardVault,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const balance = await provider.connection.getBalance(rewardVault);

    console.log("");
    console.log("✅ Vault funded");

    console.log(
      "Vault balance:",
      balance / anchor.web3.LAMPORTS_PER_SOL,
      "SOL"
    );

    if (balance <= 0) {
      throw new Error("Reward vault has no SOL");
    }
  });

  // ============================================================
  // 3. CLAIM REWARD
  // ============================================================

  it("claims a reward", async () => {
    const claimId = "TEST-CLAIM-" + Date.now().toString();

    const pointsClaimed = new anchor.BN(100);

    const rewardAmount = new anchor.BN(10_000_000);

    console.log("");
    console.log("=================================");
    console.log("CLAIM TEST");
    console.log("=================================");

    console.log("Claim ID:", claimId);

    console.log("Points:", pointsClaimed.toString());

    console.log(
      "Reward:",
      rewardAmount.toNumber() / anchor.web3.LAMPORTS_PER_SOL,
      "SOL"
    );

    // ----------------------------------------------------------
    // SHA-256
    // ----------------------------------------------------------

    const claimHash = sha256(claimId);

    console.log("Claim hash:", Buffer.from(claimHash).toString("hex"));

    // ----------------------------------------------------------
    // CLAIM PDA
    //
    // MUST EXACTLY MATCH lib.rs:
    //
    // seeds = [
    //   b"claim",
    //   reward_config.key().as_ref(),
    //   hash(claim_id.as_bytes()).as_ref()
    // ]
    // ----------------------------------------------------------

    const [claim] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), rewardConfig.toBuffer(), Buffer.from(claimHash)],
      program.programId
    );

    console.log("Claim PDA:", claim.toBase58());

    // ----------------------------------------------------------
    // CREATE RECIPIENT
    // ----------------------------------------------------------

    const recipient = anchor.web3.Keypair.generate();

    console.log("Recipient:", recipient.publicKey.toBase58());

    // ----------------------------------------------------------
    // FUND RECIPIENT
    // ----------------------------------------------------------

    const fundingTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: admin.publicKey,

        toPubkey: recipient.publicKey,

        lamports: 1_000_000,
      })
    );

    await provider.sendAndConfirm(fundingTx);

    const balanceBefore = await provider.connection.getBalance(
      recipient.publicKey
    );

    console.log(
      "Recipient balance before:",
      balanceBefore / anchor.web3.LAMPORTS_PER_SOL,
      "SOL"
    );

    // ----------------------------------------------------------
    // EXECUTE CLAIM
    // ----------------------------------------------------------

    await program.methods
      .claimReward(claimId, pointsClaimed, rewardAmount)
      .accounts({
        admin: admin.publicKey,
        rewardConfig,
        rewardVault,
        recipient: recipient.publicKey,
        claim,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("✅ claim_reward transaction succeeded");

    // ----------------------------------------------------------
    // CHECK RECIPIENT BALANCE
    // ----------------------------------------------------------

    const balanceAfter = await provider.connection.getBalance(
      recipient.publicKey
    );

    const received = balanceAfter - balanceBefore;

    console.log(
      "Recipient balance after:",
      balanceAfter / anchor.web3.LAMPORTS_PER_SOL,
      "SOL"
    );

    console.log(
      "Reward received:",
      received / anchor.web3.LAMPORTS_PER_SOL,
      "SOL"
    );

    if (received !== rewardAmount.toNumber()) {
      throw new Error(
        `Expected ${rewardAmount.toNumber()} lamports, received ${received}`
      );
    }

    console.log("✅ Correct reward amount received");

    // ----------------------------------------------------------
    // FETCH CLAIM ACCOUNT
    // ----------------------------------------------------------

    const claimAccount = await program.account.claim.fetch(claim);

    console.log("");
    console.log("Stored Claim ID:", claimAccount.claimId);

    console.log("Stored Wallet:", claimAccount.walletAddress.toBase58());

    console.log("Stored Points:", claimAccount.pointsClaimed.toString());

    console.log("Stored Reward:", claimAccount.rewardAmount.toString());

    console.log("Stored Claimed:", claimAccount.claimed);

    // ----------------------------------------------------------
    // VERIFY CLAIM DATA
    // ----------------------------------------------------------

    if (claimAccount.claimId !== claimId) {
      throw new Error("Claim ID mismatch");
    }

    if (!claimAccount.walletAddress.equals(recipient.publicKey)) {
      throw new Error("Recipient wallet mismatch");
    }

    if (!claimAccount.pointsClaimed.eq(pointsClaimed)) {
      throw new Error("Points claimed mismatch");
    }

    if (!claimAccount.rewardAmount.eq(rewardAmount)) {
      throw new Error("Reward amount mismatch");
    }

    if (claimAccount.claimed !== true) {
      throw new Error("Claim should be marked as claimed");
    }

    console.log("");
    console.log("=================================");
    console.log("✅ CLAIM TEST SUCCESSFUL");
    console.log("=================================");

    console.log("Claim PDA:", claim.toBase58());

    console.log("Claim ID:", claimAccount.claimId);

    console.log("Points:", claimAccount.pointsClaimed.toString());

    console.log(
      "Reward:",
      Number(claimAccount.rewardAmount.toString()) /
        anchor.web3.LAMPORTS_PER_SOL,
      "SOL"
    );

    console.log("Claimed:", claimAccount.claimed);

    console.log("=================================");
  });

  // ============================================================
  // 4. PAUSE / UNPAUSE
  // ============================================================

  it("pauses and unpauses rewards", async () => {
    await program.methods
      .setPaused(true)
      .accounts({
        admin: admin.publicKey,
        rewardConfig,
      })
      .rpc();

    let config = await program.account.rewardConfig.fetch(rewardConfig);

    console.log("Paused:", config.paused);

    if (config.paused !== true) {
      throw new Error("Rewards should be paused");
    }

    await program.methods
      .setPaused(false)
      .accounts({
        admin: admin.publicKey,
        rewardConfig,
      })
      .rpc();

    config = await program.account.rewardConfig.fetch(rewardConfig);

    console.log("Unpaused:", config.paused);

    if (config.paused !== false) {
      throw new Error("Rewards should be unpaused");
    }

    console.log("✅ Pause/unpause successful");
  });

  // ============================================================
  // 5. UNAUTHORIZED ADMIN
  // ============================================================

  it("rejects unauthorized admin action", async () => {
    const fakeAdmin = anchor.web3.Keypair.generate();

    let failed = false;

    try {
      await program.methods
        .setPaused(true)
        .accounts({
          admin: fakeAdmin.publicKey,
          rewardConfig,
        })
        .signers([fakeAdmin])
        .rpc();
    } catch (err) {
      failed = true;

      console.log("✅ Unauthorized action rejected");
    }

    if (!failed) {
      throw new Error("Unauthorized admin action unexpectedly succeeded");
    }

    const config = await program.account.rewardConfig.fetch(rewardConfig);

    if (config.paused !== false) {
      throw new Error("Unauthorized action changed pause state");
    }

    console.log("✅ Reward system remains unpaused");
  });
});
