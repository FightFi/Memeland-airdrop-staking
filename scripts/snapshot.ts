/**
 * snapshot.ts
 *
 * Smart snapshot script that:
 * 1. Checks the current program day
 * 2. Takes snapshot for today if not already taken
 * 3. Optionally backfills any missed snapshots
 *
 * Usage:
 *   yarn snapshot:devnet          # Take today's snapshot
 *   yarn snapshot:prod            # Take today's snapshot on mainnet
 *   yarn snapshot:devnet --backfill   # Also backfill missed days
 *
 * Can be automated via cron (run daily, script handles idempotency):
 *   0 6 * * * cd /path/to/memeland-airdrop && yarn snapshot:prod >> logs/snapshot.log 2>&1
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
import BN from "bn.js";

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
  return Math.floor((now - startTime) / SECONDS_PER_DAY) + 1;
}

interface PoolData {
  startTime: number;
  totalStaked: bigint;
  snapshotCount: number;
  terminated: number;
  paused: number;
  dailySnapshots: bigint[];
}

function parsePoolState(data: Buffer): PoolData {
  // PoolState layout (after 8-byte discriminator):
  // admin: 32, token_mint: 32, pool_token_account: 32, merkle_root: 32,
  // start_time: 8, total_staked: 8, total_airdrop_claimed: 8,
  // snapshot_count: 1, terminated: 1, bump: 1, pool_token_bump: 1, paused: 1, _padding: 3
  // daily_rewards: 256, daily_snapshots: 256

  const startTime = Number(data.readBigInt64LE(8 + 32 + 32 + 32 + 32));
  const totalStaked = data.readBigUInt64LE(8 + 32 + 32 + 32 + 32 + 8);
  const snapshotCount = data.readUInt8(8 + 32 + 32 + 32 + 32 + 8 + 8 + 8);
  const terminated = data.readUInt8(8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 1);
  const paused = data.readUInt8(8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1 + 1);

  // daily_snapshots starts after daily_rewards (256 bytes)
  const snapshotsOffset = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 1 + 3 + 256;
  const dailySnapshots: bigint[] = [];
  for (let i = 0; i < 20; i++) {
    dailySnapshots.push(data.readBigUInt64LE(snapshotsOffset + i * 8));
  }

  return { startTime, totalStaked, snapshotCount, terminated, paused, dailySnapshots };
}

async function main() {
  const args = process.argv.slice(2);
  const shouldBackfill = args.includes("--backfill");

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

  // Read pool state
  const poolAccount = await connection.getAccountInfo(poolState);
  if (!poolAccount) {
    console.error("Pool not found. Has initialize_pool been called?");
    process.exit(1);
  }

  const pool = parsePoolState(poolAccount.data);
  const now = Math.floor(Date.now() / 1000);
  const currentDay = getCurrentDay(pool.startTime, now);

  console.log("=".repeat(60));
  console.log("Memeland Airdrop - Snapshot Script");
  console.log("=".repeat(60));
  console.log(`Current UTC time: ${new Date().toUTCString()}`);
  console.log(`Pool start time:  ${new Date(pool.startTime * 1000).toUTCString()}`);
  console.log(`Current day:      ${currentDay} / ${TOTAL_DAYS}`);
  console.log(`Total staked:     ${Number(pool.totalStaked) / 1e9} tokens`);
  console.log(`Snapshot count:   ${pool.snapshotCount}`);
  console.log(`Pool paused:      ${pool.paused === 1 ? "YES" : "NO"}`);
  console.log(`Pool terminated:  ${pool.terminated === 1 ? "YES" : "NO"}`);
  console.log("=".repeat(60));

  // Check pool status
  if (pool.paused === 1) {
    console.error("\nPool is PAUSED. Cannot take snapshots.");
    process.exit(1);
  }

  if (pool.terminated === 1) {
    console.error("\nPool is TERMINATED. Cannot take snapshots.");
    process.exit(1);
  }

  if (currentDay < 1) {
    console.log("\nPool has not started yet. No snapshots needed.");
    process.exit(0);
  }

  if (currentDay > TOTAL_DAYS) {
    console.log("\nStaking period ended (day > 20). No more snapshots needed.");
    process.exit(0);
  }

  // Find missing snapshots
  const missingDays: number[] = [];
  for (let day = 1; day <= Math.min(currentDay, TOTAL_DAYS); day++) {
    if (pool.dailySnapshots[day - 1] === 0n) {
      missingDays.push(day);
    }
  }

  if (missingDays.length === 0) {
    console.log("\nAll snapshots up to date. Nothing to do.");
    process.exit(0);
  }

  console.log(`\nMissing snapshots for days: ${missingDays.join(", ")}`);

  // Determine which snapshots to take
  let daysToSnapshot: number[] = [];

  if (shouldBackfill) {
    // Backfill all missing days
    daysToSnapshot = missingDays;
  } else {
    // Only take today's snapshot if missing
    if (missingDays.includes(currentDay)) {
      daysToSnapshot = [currentDay];
    } else {
      console.log(`\nToday's snapshot (day ${currentDay}) already exists.`);
      if (missingDays.length > 0) {
        console.log(`Missing days (${missingDays.join(", ")}) require --backfill flag to fill.`);
      }
      process.exit(0);
    }
  }

  console.log(`\nWill take snapshots for days: ${daysToSnapshot.join(", ")}`);

  // Take snapshots
  let successCount = 0;
  for (const day of daysToSnapshot) {
    const isToday = day === currentDay;
    const method = isToday ? "snapshot" : "backfillSnapshot";

    console.log(`\n[Day ${day}] Calling ${method}()...`);

    try {
      let tx: string;

      if (isToday) {
        // Use snapshot() for current day
        tx = await program.methods
          .snapshot()
          .accounts({
            signer: admin.publicKey,
            poolState,
          })
          .rpc();
      } else {
        // Use backfillSnapshot() for past days
        tx = await program.methods
          .backfillSnapshot(new BN(day))
          .accounts({
            signer: admin.publicKey,
            poolState,
          })
          .rpc();
      }

      console.log(`[Day ${day}] Success! TX: ${tx}`);
      successCount++;
    } catch (err: any) {
      const errMsg = err.message || String(err);

      if (errMsg.includes("SnapshotAlreadyExists")) {
        console.log(`[Day ${day}] Snapshot already exists (race condition). Skipping.`);
      } else if (errMsg.includes("PoolPaused")) {
        console.error(`[Day ${day}] Failed: Pool is paused.`);
        break;
      } else if (errMsg.includes("PoolTerminated")) {
        console.error(`[Day ${day}] Failed: Pool is terminated.`);
        break;
      } else if (errMsg.includes("SnapshotTooEarly")) {
        console.error(`[Day ${day}] Failed: Day has not elapsed yet.`);
      } else if (errMsg.includes("InvalidDay")) {
        console.error(`[Day ${day}] Failed: Invalid day number.`);
      } else {
        console.error(`[Day ${day}] Failed: ${errMsg}`);
      }
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Completed: ${successCount}/${daysToSnapshot.length} snapshots taken.`);
  console.log("=".repeat(60));

  if (successCount < daysToSnapshot.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
