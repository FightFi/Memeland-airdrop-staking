/**
 * pause.ts
 *
 * Pause or unpause the pool (admin only).
 * When paused: claims, snapshots, and backfills are blocked.
 * Users can ALWAYS unstake even when paused.
 *
 * Usage:
 *   yarn pause:devnet              # Pause the pool
 *   yarn unpause:devnet            # Unpause the pool
 *   yarn pause:devnet --status     # Check current pause status
 *   yarn pause:devnet --yes        # Skip confirmation
 *
 * Required env vars:
 *   ANCHOR_PROVIDER_URL  — RPC endpoint
 *   ANCHOR_WALLET        — path to admin keypair JSON
 *   PROGRAM_ID           — deployed program ID
 *   TOKEN_MINT           — $FIGHT token mint address
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
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

function parseArgs(): { action: "pause" | "unpause" | "status"; skipConfirm: boolean } {
  const args = process.argv.slice(2);
  let action: "pause" | "unpause" | "status" = "status";
  let skipConfirm = false;

  // Check script name to determine default action
  const scriptName = process.argv[1] || "";
  if (scriptName.includes("unpause")) {
    action = "unpause";
  } else if (scriptName.includes("pause")) {
    action = "pause";
  }

  for (const arg of args) {
    if (arg === "--status" || arg === "-s") {
      action = "status";
    } else if (arg === "--pause" || arg === "pause") {
      action = "pause";
    } else if (arg === "--unpause" || arg === "unpause") {
      action = "unpause";
    } else if (arg === "--yes" || arg === "-y") {
      skipConfirm = true;
    }
  }

  return { action, skipConfirm };
}

interface PoolData {
  admin: PublicKey;
  startTime: number;
  totalStaked: bigint;
  snapshotCount: number;
  paused: number;
}

function parsePoolState(data: Buffer): PoolData {
  const admin = new PublicKey(data.slice(8, 8 + 32));
  const startTime = Number(data.readBigInt64LE(8 + 32 + 32 + 32 + 32));
  const totalStaked = data.readBigUInt64LE(8 + 32 + 32 + 32 + 32 + 8);
  const snapshotCount = data.readUInt8(8 + 32 + 32 + 32 + 32 + 8 + 8 + 8);
  // skip bump (1) + pool_token_bump (1)
  const paused = data.readUInt8(8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1);

  return { admin, startTime, totalStaked, snapshotCount, paused };
}

async function askConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question + " (y/n): ", (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

async function main() {
  const { action, skipConfirm } = parseArgs();

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

  // Derive pool state PDA
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state"), tokenMint.toBuffer()],
    programId
  );

  // Read pool state
  const poolAccount = await connection.getAccountInfo(poolState);
  if (!poolAccount) {
    console.error("Pool not found. Has initialize_pool been called?");
    process.exit(1);
  }

  const pool = parsePoolState(poolAccount.data);
  const networkName = rpcUrl.includes("devnet") ? "DEVNET" : rpcUrl.includes("mainnet") ? "MAINNET" : "UNKNOWN";

  console.log("=".repeat(60));
  console.log("Memeland Airdrop - Pause Control");
  console.log("=".repeat(60));
  console.log(`Network:        ${networkName}`);
  console.log(`Pool State:     ${poolState.toBase58()}`);
  console.log(`Pool Admin:     ${pool.admin.toBase58()}`);
  console.log(`Your Wallet:    ${admin.publicKey.toBase58()}`);
  console.log(`Total Staked:   ${Number(pool.totalStaked) / 1e9} tokens`);
  console.log("=".repeat(60));
  console.log(`Current Status:`);
  console.log(`   Paused:      ${pool.paused === 1 ? "YES 🔴" : "NO 🟢"}`);
  console.log("=".repeat(60));

  // Check if caller is admin
  if (!admin.publicKey.equals(pool.admin)) {
    console.error("\n❌ Error: Your wallet is not the pool admin.");
    console.error(`   Pool admin: ${pool.admin.toBase58()}`);
    console.error(`   Your wallet: ${admin.publicKey.toBase58()}`);
    process.exit(1);
  }

  // Status only mode
  if (action === "status") {
    if (pool.paused === 1) {
      console.log("\n🔴 Pool is currently PAUSED");
      console.log("   - Claims are blocked");
      console.log("   - Snapshots are blocked");
      console.log("   - Users can still unstake");
    } else {
      console.log("\n🟢 Pool is currently ACTIVE");
      console.log("   - All operations are available");
    }
    process.exit(0);
  }

  // Validate action
  if (action === "pause" && pool.paused === 1) {
    console.log("\n⚠️  Pool is already paused. Nothing to do.");
    process.exit(0);
  }

  if (action === "unpause" && pool.paused === 0) {
    console.log("\n⚠️  Pool is already active. Nothing to do.");
    process.exit(0);
  }

  // Confirm action
  const actionText = action === "pause" ? "PAUSE" : "UNPAUSE";
  const warningText = action === "pause"
    ? "This will BLOCK claims and snapshots. Users can still unstake."
    : "This will RESUME normal operations.";

  console.log(`\n⚠️  You are about to ${actionText} the pool.`);
  console.log(`   ${warningText}`);

  if (!skipConfirm) {
    const confirmed = await askConfirmation(`Do you want to ${actionText} the pool?`);
    if (!confirmed) {
      console.log("\n❌ Operation cancelled by user.");
      process.exit(0);
    }
  } else {
    console.log("   (--yes flag: skipping confirmation)");
  }

  // Load IDL and create program
  const idlPath = path.resolve(__dirname, "..", "target", "idl", "memeland_airdrop.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const wallet = new anchor.Wallet(admin);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl, provider);

  // Execute action
  console.log(`\n📤 Submitting ${action}_pool transaction...`);

  try {
    let tx: string;

    if (action === "pause") {
      tx = await program.methods
        .pausePool()
        .accounts({
          admin: admin.publicKey,
          poolState,
        })
        .rpc();
    } else {
      tx = await program.methods
        .unpausePool()
        .accounts({
          admin: admin.publicKey,
          poolState,
        })
        .rpc();
    }

    console.log(`\n✅ ${actionText} successful!`);
    console.log(`   TX: ${tx}`);

    if (action === "pause") {
      console.log("\n🔴 Pool is now PAUSED");
      console.log("   - Claims are blocked");
      console.log("   - Snapshots are blocked");
      console.log("   - Users can still unstake");
      console.log("\n   Run 'yarn unpause:devnet' to resume operations.");
    } else {
      console.log("\n🟢 Pool is now ACTIVE");
      console.log("   - All operations are available");
    }
  } catch (err: any) {
    const errMsg = err.message || String(err);

    if (errMsg.includes("AlreadyPaused")) {
      console.error("\n❌ Failed: Pool is already paused.");
    } else if (errMsg.includes("PoolNotPaused")) {
      console.error("\n❌ Failed: Pool is not paused.");
    } else if (errMsg.includes("UnauthorizedAdmin")) {
      console.error("\n❌ Failed: You are not the pool admin.");
    } else {
      console.error(`\n❌ Failed: ${errMsg}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
