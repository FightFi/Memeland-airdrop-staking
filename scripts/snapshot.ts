/**
 * snapshot.ts
 *
 * Calls the snapshot() instruction to record the daily total_staked.
 * Must be called between 12:00-12:05 AM UTC each day.
 *
 * Usage:
 *   yarn snapshot:devnet     # uses .env.testnet
 *   yarn snapshot:prod       # uses .env.prod
 *
 * Can be automated via cron:
 *   0 0 * * * cd /path/to/memeland-airdrop && yarn snapshot:prod
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

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

async function main() {
  const rpcUrl = requireEnv("ANCHOR_PROVIDER_URL");
  const walletPath = requireEnv("ANCHOR_WALLET");
  const programIdStr = requireEnv("PROGRAM_ID");
  const tokenMintStr = requireEnv("TOKEN_MINT");

  const resolvedWalletPath = walletPath.startsWith("~")
    ? walletPath.replace("~", process.env.HOME || "")
    : path.resolve(walletPath);

  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  console.log(`Current UTC time: ${now.toUTCString()}`);

  if (utcHour !== 0 || utcMin >= 5) {
    console.warn(
      `WARNING: Snapshot window is 12:00-12:05 AM UTC. Current: ${utcHour}:${String(utcMin).padStart(2, "0")} UTC`
    );
    console.warn("The on-chain instruction will reject if outside the window.");
  }

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

  // Read current snapshot count from raw data
  const poolAccount = await connection.getAccountInfo(poolState);
  if (!poolAccount) {
    console.error("Pool not found. Has initialize_pool been called?");
    process.exit(1);
  }
  const snapshotCount = poolAccount.data.readUInt8(160); // offset of snapshot_count
  console.log(`Current snapshot count: ${snapshotCount}/20`);

  if (snapshotCount >= 20) {
    console.log("All 20 snapshots already taken. Nothing to do.");
    process.exit(0);
  }

  // Read total_staked
  const totalStaked = poolAccount.data.readBigUInt64LE(144); // offset of total_staked
  console.log(`Current total_staked: ${Number(totalStaked) / 1e6} tokens`);

  // Call snapshot
  console.log("\nCalling snapshot()...");
  try {
    const tx = await program.methods
      .snapshot()
      .accounts({
        admin: admin.publicKey,
        poolState,
      })
      .rpc();

    console.log(`Snapshot tx: ${tx}`);
    console.log(`Snapshot ${snapshotCount + 1}/20 recorded.`);
  } catch (err: any) {
    const errMsg = err.message || String(err);
    if (errMsg.includes("OutsideSnapshotWindow")) {
      console.error("Failed: Outside snapshot window (12:00-12:05 AM UTC)");
    } else if (errMsg.includes("SnapshotTooEarly")) {
      console.error("Failed: Day has not yet elapsed since last snapshot");
    } else if (errMsg.includes("AllSnapshotsTaken")) {
      console.error("Failed: All 20 snapshots already taken");
    } else {
      console.error("Failed:", errMsg);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
