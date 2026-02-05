/**
 * calculate-rewards.ts
 *
 * Calculate accumulated staking rewards for a specific address.
 * Replicates the on-chain `calculate_user_rewards` logic (lib.rs:546-574).
 *
 * Usage:
 *   yarn rewards:devnet <ADDRESS>
 *   yarn rewards:prod <ADDRESS>
 *
 * Required env vars:
 *   ANCHOR_PROVIDER_URL  — RPC endpoint
 *   PROGRAM_ID           — deployed program ID
 *   TOKEN_MINT           — $FIGHT token mint address
 */

import { Connection, PublicKey } from "@solana/web3.js";

const SECONDS_PER_DAY = 86400;
const TOTAL_DAYS = 20;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

interface PoolData {
  admin: PublicKey;
  tokenMint: PublicKey;
  poolTokenAccount: PublicKey;
  merkleRoot: number[];
  startTime: number;
  totalStaked: bigint;
  totalAirdropClaimed: bigint;
  snapshotCount: number;
  terminated: number;
  paused: number;
  dailyRewards: bigint[];
  dailySnapshots: bigint[];
}

function parsePoolState(data: Buffer): PoolData {
  let offset = 8; // Skip discriminator

  const admin = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const tokenMint = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const poolTokenAccount = new PublicKey(data.slice(offset, offset + 32));
  offset += 32;

  const merkleRoot = Array.from(data.slice(offset, offset + 32));
  offset += 32;

  const startTime = Number(data.readBigInt64LE(offset));
  offset += 8;

  const totalStaked = data.readBigUInt64LE(offset);
  offset += 8;

  const totalAirdropClaimed = data.readBigUInt64LE(offset);
  offset += 8;

  const snapshotCount = data.readUInt8(offset);
  offset += 1;

  const terminated = data.readUInt8(offset);
  offset += 1;

  // bump
  offset += 1;

  // pool_token_bump
  offset += 1;

  const paused = data.readUInt8(offset);
  offset += 1;

  // _padding
  offset += 3;

  // daily_rewards (32 * u64)
  const dailyRewards: bigint[] = [];
  for (let i = 0; i < 32; i++) {
    dailyRewards.push(data.readBigUInt64LE(offset + i * 8));
  }
  offset += 32 * 8;

  // daily_snapshots (32 * u64)
  const dailySnapshots: bigint[] = [];
  for (let i = 0; i < 32; i++) {
    dailySnapshots.push(data.readBigUInt64LE(offset + i * 8));
  }

  return {
    admin,
    tokenMint,
    poolTokenAccount,
    merkleRoot,
    startTime,
    totalStaked,
    totalAirdropClaimed,
    snapshotCount,
    terminated,
    paused,
    dailyRewards,
    dailySnapshots,
  };
}

interface UserStakeData {
  owner: PublicKey;
  stakedAmount: bigint;
  claimDay: number;
}

function parseUserStake(data: Buffer): UserStakeData {
  const owner = new PublicKey(data.slice(8, 8 + 32));
  const stakedAmount = data.readBigUInt64LE(8 + 32);
  const claimDay = Number(data.readBigUInt64LE(8 + 32 + 8));
  return { owner, stakedAmount, claimDay };
}

function formatTokens(amount: bigint, decimals = 9): string {
  const num = Number(amount) / Math.pow(10, decimals);
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Replicate on-chain calculate_user_rewards (lib.rs:546-574).
 * Uses BigInt for u128 precision matching the Rust implementation.
 */
function calculateUserRewards(
  stakedAmount: bigint,
  claimDay: number,
  snapshotCount: number,
  dailyRewards: bigint[],
  dailySnapshots: bigint[]
): bigint {
  let totalRewards = 0n;

  const start = claimDay;

  for (let d = start; d < snapshotCount; d++) {
    const snapshotTotal = dailySnapshots[d];
    if (snapshotTotal === 0n) {
      continue;
    }

    const daily = dailyRewards[d];
    const userShare = (stakedAmount * daily) / snapshotTotal;
    totalRewards += userShare;
  }

  return totalRewards;
}

async function main() {
  const address = process.argv[2];
  if (!address) {
    console.error("Usage: yarn rewards:devnet <ADDRESS>");
    process.exit(1);
  }

  let userPubkey: PublicKey;
  try {
    userPubkey = new PublicKey(address);
  } catch {
    console.error(`Invalid address: ${address}`);
    process.exit(1);
  }

  const rpcUrl = requireEnv("ANCHOR_PROVIDER_URL");
  const programIdStr = requireEnv("PROGRAM_ID");
  const tokenMintStr = requireEnv("TOKEN_MINT");

  const connection = new Connection(rpcUrl, "confirmed");
  const programId = new PublicKey(programIdStr);
  const tokenMint = new PublicKey(tokenMintStr);

  // Derive PDAs
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state"), tokenMint.toBuffer()],
    programId
  );

  const [userStakePda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user_stake"),
      poolState.toBuffer(),
      userPubkey.toBuffer(),
    ],
    programId
  );

  // Fetch pool state
  const poolAccount = await connection.getAccountInfo(poolState);
  if (!poolAccount) {
    console.error("Pool not found. Has initialize_pool been called?");
    process.exit(1);
  }
  const pool = parsePoolState(poolAccount.data);

  // Current day
  const now = Math.floor(Date.now() / 1000);
  const elapsedSeconds = Math.max(0, now - pool.startTime);
  const currentDay =
    pool.startTime > now
      ? 0
      : Math.floor(elapsedSeconds / SECONDS_PER_DAY) + 1;

  // Fetch user stake
  const userStakeAccount = await connection.getAccountInfo(userStakePda);
  if (!userStakeAccount) {
    console.error(`No stake found for address: ${address}`);
    console.error(`  (looked up PDA: ${userStakePda.toBase58()})`);
    process.exit(1);
  }
  const userStake = parseUserStake(userStakeAccount.data);

  // Calculate rewards
  const totalRewards = calculateUserRewards(
    userStake.stakedAmount,
    userStake.claimDay,
    pool.snapshotCount,
    pool.dailyRewards,
    pool.dailySnapshots
  );

  // Output
  console.log();
  console.log("=== Reward Calculator ===");
  console.log(`Address:        ${userPubkey.toBase58()}`);
  console.log(`Staked Amount:  ${formatTokens(userStake.stakedAmount)} tokens`);
  console.log(`Claim Day:      ${userStake.claimDay + 1}`);
  console.log(`Current Day:    ${currentDay}`);
  console.log(`Snapshots:      ${pool.snapshotCount}`);
  console.log();

  // Per-day breakdown
  const start = userStake.claimDay;
  let runningTotal = 0n;

  for (let d = start; d < pool.snapshotCount; d++) {
    const snapshotTotal = pool.dailySnapshots[d];
    if (snapshotTotal === 0n) {
      console.log(
        `Day ${(d + 1).toString().padStart(2)}:  ${"0.00".padStart(14)} tokens  (snapshot = 0, skipped)`
      );
      continue;
    }

    const daily = pool.dailyRewards[d];
    const userShare = (userStake.stakedAmount * daily) / snapshotTotal;
    runningTotal += userShare;

    console.log(
      `Day ${(d + 1).toString().padStart(2)}:  ${formatTokens(userShare).padStart(14)} tokens  (reward: ${formatTokens(userStake.stakedAmount)} * ${formatTokens(daily)} / ${formatTokens(snapshotTotal)})`
    );
  }

  console.log();
  const principalPlusRewards = userStake.stakedAmount + totalRewards;
  console.log(
    `Total Rewards:  ${formatTokens(totalRewards)} tokens (principal + rewards = ${formatTokens(principalPlusRewards)})`
  );
  console.log();
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
