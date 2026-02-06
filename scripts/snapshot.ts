/**
 * snapshot.ts
 *
 * Calls the on-chain snapshot() instruction.
 * The program handles all validation (day, paused, etc).
 *
 * Usage:
 *   yarn snapshot:devnet          # Take snapshot (with client-side checks)
 *   yarn snapshot:devnet --force  # Send tx regardless, let the program decide
 *
 * Required env vars:
 *   ANCHOR_PROVIDER_URL  — RPC endpoint
 *   ANCHOR_WALLET        — path to admin keypair JSON
 *   PROGRAM_ID           — deployed program ID
 *   TOKEN_MINT           — $FIGHT token mint address
 */

import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider } from "@coral-xyz/anchor";

const TOTAL_DAYS = 20;
const SECONDS_PER_DAY = 86400;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

function getCurrentDay(startTime: number, now: number): number {
  if (now < startTime) return 0;
  return Math.floor((now - startTime) / SECONDS_PER_DAY);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");

  const rpcUrl = requireEnv("ANCHOR_PROVIDER_URL");
  const walletPath = requireEnv("ANCHOR_WALLET");
  const programIdStr = requireEnv("PROGRAM_ID");
  const tokenMintStr = requireEnv("TOKEN_MINT");

  const resolvedWalletPath = walletPath.startsWith("~")
    ? walletPath.replace("~", process.env.HOME || "")
    : path.resolve(walletPath);

  // Load admin keypair
  const adminSecret = JSON.parse(fs.readFileSync(resolvedWalletPath, "utf-8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(adminSecret));

  const connection = new Connection(rpcUrl, "confirmed");
  const programId = new PublicKey(programIdStr);
  const tokenMint = new PublicKey(tokenMintStr);

  // Load IDL
  const idlPath = path.resolve(__dirname, "..", "target", "idl", "memeland_airdrop.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const wallet = new anchor.Wallet(admin);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl, provider);

  // Derive pool state PDA
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state"), tokenMint.toBuffer()],
    programId
  );

  const now = Math.floor(Date.now() / 1000);

  if (!force) {
    // Read pool state for info display
    const poolAccount = await connection.getAccountInfo(poolState);
    if (!poolAccount) {
      console.error("Pool not found. Has initialize_pool been called?");
      process.exit(1);
    }

    // Quick parse for display
    const data = poolAccount.data;
    const startTime = Number(data.readBigInt64LE(8 + 32 + 32 + 32 + 32));
    const snapshotCount = data.readUInt8(8 + 32 + 32 + 32 + 32 + 8 + 8 + 8);
    const currentDay = getCurrentDay(startTime, now);

    console.log("=".repeat(60));
    console.log("Memeland Airdrop - Snapshot");
    console.log("=".repeat(60));
    console.log(`Current day:      ${currentDay} / ${TOTAL_DAYS}`);
    console.log(`Snapshot count:   ${snapshotCount}`);
    console.log("=".repeat(60));
  }

  // Send the tx — let the program validate
  console.log("\nSending snapshot() tx...");
  try {
    const tx = await program.methods
      .snapshot()
      .accounts({
        signer: admin.publicKey,
        poolState,
      })
      .rpc();

    console.log(`Success! TX: ${tx}`);
  } catch (err: any) {
    if (err?.logs) {
      console.error("Program logs:");
      for (const log of err.logs) console.error(`  ${log}`);
    }
    const errMsg = err.message || String(err);
    console.error(`Failed: ${errMsg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
