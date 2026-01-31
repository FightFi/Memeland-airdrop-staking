import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const KEYPAIRS_DIR = path.join(__dirname, "..", "keypairs");

function generateAndSave(name: string): Keypair {
  const keypair = Keypair.generate();
  const filePath = path.join(KEYPAIRS_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)));
  console.log(`Generated ${name}:`);
  console.log(`  Public key: ${keypair.publicKey.toBase58()}`);
  console.log(`  Saved to:   ${filePath}`);
  return keypair;
}

function main() {
  if (!fs.existsSync(KEYPAIRS_DIR)) {
    fs.mkdirSync(KEYPAIRS_DIR, { recursive: true });
  }

  console.log("=== Generating Testnet Keypairs ===\n");

  const admin = generateAndSave("admin");
  console.log("");
  const tokenMint = generateAndSave("token-mint");
  console.log("");

  console.log("=== Fund these wallets on devnet ===");
  console.log(`\nAdmin wallet (needs SOL for deployment + tx fees):`);
  console.log(`  solana airdrop 5 ${admin.publicKey.toBase58()} --url devnet`);
  console.log(`\nToken mint authority is the admin wallet.`);
  console.log(`\nTo deploy:`);
  console.log(
    `  anchor deploy --provider.cluster devnet --provider.wallet ./keypairs/admin.json`
  );
}

main();
