import { Keypair } from "@solana/web3.js";

const secret = Uint8Array.from([
  247,244,131,73,80,63,253,33,170,224,190,228,113,230,251,230,191,153,144,148,99,142,94,20,177,169,180,248,235,168,224,97,10,234,80,181,252,81,218,219,85,109,76,63,234,8,58,61,43,200,219,34,233,161,170,52,52,22,74,200,219,130,163,217

]);

const keypair = Keypair.fromSecretKey(secret);

console.log("PUBLIC ADDRESS:");
console.log(keypair.publicKey.toBase58());