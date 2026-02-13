/**
 * unstake-preview.ts
 *
 * Previews what a user would receive if they unstake today.
 * Shows pool info, all snapshots, daily reward breakdown, and final payout.
 *
 * Usage:
 *   yarn unstake-preview:devnet <ADDRESS>
 *   yarn unstake-preview:prod <ADDRESS>
 *
 * Required env vars:
 *   ANCHOR_PROVIDER_URL  — RPC endpoint
 *   PROGRAM_ID           — deployed program ID
 *   TOKEN_MINT           — $FIGHT token mint address
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

const SECONDS_PER_DAY = 86400;
const TOTAL_DAYS = 20;
const CLAIM_WINDOW_DAYS = 40;
const AIRDROP_POOL = BigInt("67000000000000000"); // 67M with 9 decimals
const STAKING_POOL = BigInt("133000000000000000"); // 133M with 9 decimals
const TOTAL_POOL = AIRDROP_POOL + STAKING_POOL;
const DECIMALS = 9;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

/**
 * Must match on-chain get_current_day.
 * Returns 0-indexed day capped at TOTAL_DAYS.
 */
function getOnChainDay(startTime: number, now: number): number {
  if (now <= startTime) return 0;
  const elapsed = now - startTime;
  const day = Math.floor(elapsed / SECONDS_PER_DAY);
  return Math.min(day, TOTAL_DAYS);
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
  paused: number;
  dailyRewards: bigint[];
  dailySnapshots: bigint[];
}

function parsePoolState(data: Buffer): PoolData {
  let offset = 8;
  const admin = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const tokenMint = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const poolTokenAccount = new PublicKey(data.slice(offset, offset + 32)); offset += 32;
  const merkleRoot = Array.from(data.slice(offset, offset + 32)); offset += 32;
  const startTime = Number(data.readBigInt64LE(offset)); offset += 8;
  const totalStaked = data.readBigUInt64LE(offset); offset += 8;
  const totalAirdropClaimed = data.readBigUInt64LE(offset); offset += 8;
  const snapshotCount = data.readUInt8(offset); offset += 1;
  offset += 1; // bump
  offset += 1; // pool_token_bump
  const paused = data.readUInt8(offset); offset += 1;
  const activeStakers = data.readUInt32LE(offset); offset += 4;
  const totalUnstaked = data.readUInt32LE(offset); offset += 4;

  const dailyRewards: bigint[] = [];
  for (let i = 0; i < 32; i++) {
    dailyRewards.push(data.readBigUInt64LE(offset + i * 8));
  }
  offset += 32 * 8;

  const dailySnapshots: bigint[] = [];
  for (let i = 0; i < 32; i++) {
    dailySnapshots.push(data.readBigUInt64LE(offset + i * 8));
  }

  return {
    admin, tokenMint, poolTokenAccount, merkleRoot, startTime,
    totalStaked, totalAirdropClaimed, snapshotCount, paused,
    dailyRewards, dailySnapshots,
  };
}

interface UserStakeData {
  owner: PublicKey;
  stakedAmount: bigint;
}

function parseUserStake(data: Buffer): UserStakeData {
  const owner = new PublicKey(data.slice(8, 8 + 32));
  const stakedAmount = data.readBigUInt64LE(8 + 32);
  return { owner, stakedAmount };
}

function fmt(amount: bigint): string {
  const num = Number(amount) / Math.pow(10, DECIMALS);
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(part: bigint, total: bigint): string {
  if (total === 0n) return "0.00%";
  return ((Number(part) / Number(total)) * 100).toFixed(2) + "%";
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Replicates on-chain calculate_user_rewards.
 * All users earn from day 0.
 */
function calculateUserRewards(
  stakedAmount: bigint,
  snapshotCount: number,
  dailyRewards: bigint[],
  dailySnapshots: bigint[]
): { total: bigint; perDay: { day: number; reward: bigint; dailyPool: bigint; snapshot: bigint }[] } {
  let total = 0n;
  const perDay: { day: number; reward: bigint; dailyPool: bigint; snapshot: bigint }[] = [];

  for (let d = 0; d < snapshotCount; d++) {
    const snapshotTotal = dailySnapshots[d];
    if (snapshotTotal === 0n) {
      perDay.push({ day: d, reward: 0n, dailyPool: dailyRewards[d], snapshot: 0n });
      continue;
    }
    const daily = dailyRewards[d];
    const userShare = (stakedAmount * daily) / snapshotTotal;
    total += userShare;
    perDay.push({ day: d, reward: userShare, dailyPool: daily, snapshot: snapshotTotal });
  }

  return { total, perDay };
}

async function main() {
  const address = process.argv[2];
  if (!address) {
    console.error("Usage: yarn unstake-preview:devnet <ADDRESS>");
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
  const programId = new PublicKey(requireEnv("PROGRAM_ID"));
  const tokenMint = new PublicKey(requireEnv("TOKEN_MINT"));
  const connection = new Connection(rpcUrl, "confirmed");

  // Derive PDAs
  const [poolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state"), tokenMint.toBuffer()],
    programId
  );
  const [userStakePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stake"), poolStatePda.toBuffer(), userPubkey.toBuffer()],
    programId
  );

  // Fetch pool state
  const poolAccount = await connection.getAccountInfo(poolStatePda);
  if (!poolAccount) {
    console.error("Pool not found. Has initialize_pool been called?");
    process.exit(1);
  }
  const pool = parsePoolState(poolAccount.data);

  // Time calculations — uses on-chain day (0-indexed, matching get_current_day)
  const now = Math.floor(Date.now() / 1000);
  const elapsed = Math.max(0, now - pool.startTime);
  const onChainDay = getOnChainDay(pool.startTime, now);
  const displayDay = onChainDay + 1; // 1-indexed for humans
  const isRewardExpired = onChainDay >= CLAIM_WINDOW_DAYS;
  const isInClaimWindow = onChainDay > TOTAL_DAYS && !isRewardExpired;
  const daysRemaining = Math.max(0, TOTAL_DAYS - onChainDay);

  // Pool token balance
  let poolTokenBalance = 0n;
  try {
    const tokenAccount = await getAccount(connection, pool.poolTokenAccount);
    poolTokenBalance = tokenAccount.amount;
  } catch {}

  // ═══════════════════════════════════════════════════════════════
  // POOL GENERAL INFO
  // ═══════════════════════════════════════════════════════════════
  const statusText = pool.paused === 1 ? "PAUSED" : "ACTIVE";
  const networkName = rpcUrl.includes("devnet") ? "DEVNET" : rpcUrl.includes("mainnet") ? "MAINNET" : "CUSTOM";

  console.log();
  console.log("=".repeat(72));
  console.log("   UNSTAKE PREVIEW - What would I receive today?");
  console.log("=".repeat(72));

  console.log(`\n   Network: ${networkName}     Status: ${statusText}     On-chain day: ${onChainDay} (display: day ${displayDay}/${TOTAL_DAYS})`);

  console.log("\n-- POOL INFO -------------------------------------------------------");
  console.log(`  Pool PDA:           ${poolStatePda.toBase58()}`);
  console.log(`  Admin:              ${pool.admin.toBase58()}`);
  console.log(`  Token Mint:         ${pool.tokenMint.toBase58()}`);
  console.log(`  Start Time:         ${new Date(pool.startTime * 1000).toUTCString()}`);
  console.log(`  Elapsed:            ${formatDuration(elapsed)}`);
  console.log(`  Current Day:        ${onChainDay} on-chain / day ${displayDay} for users  (${daysRemaining > 0 ? daysRemaining + " days left" : isInClaimWindow ? "IN CLAIM WINDOW" : "EXPIRED"})`);
  console.log(`  Total Staked:       ${fmt(pool.totalStaked)} tokens`);
  console.log(`  Airdrop Claimed:    ${fmt(pool.totalAirdropClaimed)} / ${fmt(AIRDROP_POOL)} (${pct(pool.totalAirdropClaimed, AIRDROP_POOL)})`);
  console.log(`  Pool Token Balance: ${fmt(poolTokenBalance)} tokens`);
  console.log(`  Snapshots Taken:    ${pool.snapshotCount} / ${Math.min(onChainDay, TOTAL_DAYS)} (on-chain day ${onChainDay})`);

  if (pool.snapshotCount >= onChainDay) {
    console.log(`  Snapshot Status:    ALL UP TO DATE`);
  } else {
    console.log(`  Snapshot Status:    ${onChainDay - pool.snapshotCount} PENDING - run snapshot script!`);
  }

  // ═══════════════════════════════════════════════════════════════
  // SNAPSHOTS TABLE
  // ═══════════════════════════════════════════════════════════════
  console.log("\n-- ALL SNAPSHOTS ---------------------------------------------------");
  console.log("  Idx | Day | Total Staked           | Daily Reward Pool      | Status");
  console.log("  ----|-----|------------------------|------------------------|--------");

  let totalRewardsConfigured = 0n;
  for (let i = 0; i < TOTAL_DAYS; i++) {
    const snap = pool.dailySnapshots[i];
    const reward = pool.dailyRewards[i];
    totalRewardsConfigured += reward;

    // Use snapshot_count to determine taken (NOT the value — value can be 0 if total_staked was 0)
    const taken = i < pool.snapshotCount;
    const isPending = !taken && i < onChainDay;
    const isFuture = i >= onChainDay;

    let status = "";
    let snapDisplay = "";
    if (taken) {
      if (snap === 0n) {
        status = "OK (0 staked at snapshot time)";
        snapDisplay = "0 (taken but empty)".padStart(22);
      } else {
        status = "OK";
        snapDisplay = fmt(snap).padStart(22);
      }
    } else if (isPending) {
      status = "PENDING snapshot!";
      snapDisplay = "-".padStart(22);
    } else if (i === onChainDay) {
      status = "<- current (not yet snapshotable)";
      snapDisplay = "-".padStart(22);
    } else {
      status = "future";
      snapDisplay = "-".padStart(22);
    }

    console.log(
      `   ${i.toString().padStart(2)} |  ${(i + 1).toString().padStart(2)} | ` +
      `${snapDisplay} | ` +
      `${fmt(reward).padStart(22)} | ` +
      `${status}`
    );
  }
  console.log(`\n  Total Rewards Pool: ${fmt(totalRewardsConfigured)} tokens (${fmt(STAKING_POOL)} configured)`);

  // ═══════════════════════════════════════════════════════════════
  // USER STAKE INFO
  // ═══════════════════════════════════════════════════════════════
  console.log("\n-- USER STAKE ------------------------------------------------------");
  console.log(`  Address:  ${userPubkey.toBase58()}`);
  console.log(`  Stake PDA: ${userStakePda.toBase58()}`);

  const userStakeAccount = await connection.getAccountInfo(userStakePda);
  if (!userStakeAccount) {
    console.log("\n  ** No active stake found for this address. **");
    console.log("     Either they haven't claimed yet, or they already unstaked.");

    // Check if they have a ClaimMarker (already unstaked)
    const [claimMarkerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claimed"), poolStatePda.toBuffer(), userPubkey.toBuffer()],
      programId
    );
    const claimMarker = await connection.getAccountInfo(claimMarkerPda);
    if (claimMarker) {
      console.log("     ClaimMarker exists -> This user already claimed and unstaked.");
    } else {
      console.log("     No ClaimMarker -> This user has NOT claimed yet.");
    }

    // Check wallet balance
    try {
      const atas = await connection.getTokenAccountsByOwner(userPubkey, { mint: tokenMint });
      if (atas.value.length > 0) {
        const balance = await connection.getTokenAccountBalance(atas.value[0].pubkey);
        console.log(`\n  Wallet Balance: ${fmt(BigInt(balance.value.amount))} tokens`);
      }
    } catch {}

    console.log("\n" + "=".repeat(72) + "\n");
    process.exit(0);
  }

  const userStake = parseUserStake(userStakeAccount.data);

  // User wallet balance
  let walletBalance = 0n;
  try {
    const atas = await connection.getTokenAccountsByOwner(userPubkey, { mint: tokenMint });
    if (atas.value.length > 0) {
      const balance = await connection.getTokenAccountBalance(atas.value[0].pubkey);
      walletBalance = BigInt(balance.value.amount);
    }
  } catch {}

  console.log(`  Staked Amount: ${fmt(userStake.stakedAmount)} tokens (virtual stake)`);
  console.log(`  Wallet Balance: ${fmt(walletBalance)} tokens (airdrop received on claim)`);
  console.log(`  Share of Pool: ${pct(userStake.stakedAmount, pool.totalStaked)} of total staked`);

  // ═══════════════════════════════════════════════════════════════
  // REWARD CALCULATION
  // ═══════════════════════════════════════════════════════════════
  console.log("\n-- REWARD BREAKDOWN (if unstake today) -----------------------------");

  if (isRewardExpired) {
    console.log("\n  ** REWARD WINDOW EXPIRED (day > 40) - Rewards = 0 **");
    console.log(`  Unstaking will return 0 rewards (closes account, recovers ~0.002 SOL rent).`);
    console.log(`  Your airdrop tokens were already sent to your wallet on claim.`);
    console.log("\n" + "=".repeat(72) + "\n");
    process.exit(0);
  }

  const { total: totalRewards, perDay } = calculateUserRewards(
    userStake.stakedAmount,
    pool.snapshotCount,
    pool.dailyRewards,
    pool.dailySnapshots
  );

  console.log();
  console.log("  Idx | Your Reward            | Your Share  | Daily Pool             | Snapshot Total");
  console.log("  ----|------------------------|-------------|------------------------|------------------------");

  for (const entry of perDay) {
    if (entry.snapshot === 0n) {
      console.log(
        `   ${entry.day.toString().padStart(2)} | ${"(skipped - 0 staked)".padStart(22)} |      -      | ${fmt(entry.dailyPool).padStart(22)} | 0`
      );
    } else {
      const shareStr = pct(userStake.stakedAmount, entry.snapshot);
      console.log(
        `   ${entry.day.toString().padStart(2)} | ` +
        `${fmt(entry.reward).padStart(22)} | ` +
        `${shareStr.padStart(11)} | ` +
        `${fmt(entry.dailyPool).padStart(22)} | ` +
        `${fmt(entry.snapshot)}`
      );
    }
  }

  // Days not yet snapshotted
  const pendingDays = Math.max(0, Math.min(TOTAL_DAYS, onChainDay) - pool.snapshotCount);
  if (pendingDays > 0) {
    console.log(`\n  * ${pendingDays} day(s) pending snapshot (indices ${pool.snapshotCount}-${Math.min(TOTAL_DAYS, onChainDay) - 1}).`);
    console.log(`    These are NOT included in rewards until snapshot is taken.`);

    // Estimate what those days would yield using current total_staked
    let pendingEstimate = 0n;
    for (let d = pool.snapshotCount; d < Math.min(TOTAL_DAYS, onChainDay); d++) {
      if (pool.totalStaked > 0n) {
        pendingEstimate += (userStake.stakedAmount * pool.dailyRewards[d]) / pool.totalStaked;
      }
    }
    if (pendingEstimate > 0n) {
      console.log(`    Estimated pending rewards (if snapshot taken now): ~${fmt(pendingEstimate)} tokens`);
    }
  }

  // Future days not yet elapsed
  const futureDays = TOTAL_DAYS - Math.max(pool.snapshotCount, onChainDay);
  if (futureDays > 0) {
    let futureEstimate = 0n;
    const estimateBase = pool.totalStaked > 0n ? pool.totalStaked : 1n;
    for (let d = Math.max(pool.snapshotCount, onChainDay); d < TOTAL_DAYS; d++) {
      futureEstimate += (userStake.stakedAmount * pool.dailyRewards[d]) / estimateBase;
    }
    console.log(`\n  * ${futureDays} future day(s) remaining (indices ${Math.max(pool.snapshotCount, onChainDay)}-${TOTAL_DAYS - 1}).`);
    console.log(`    If you stay staked with current pool size: ~${fmt(futureEstimate)} extra tokens (estimate).`);
  }

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  const rewardPercentage = userStake.stakedAmount > 0n
    ? ((Number(totalRewards) / Number(userStake.stakedAmount)) * 100).toFixed(2)
    : "0.00";

  console.log("\n-- UNSTAKE SUMMARY -------------------------------------------------");
  console.log();
  console.log(`  Airdrop (already in wallet): ${fmt(walletBalance).padStart(20)} tokens`);
  console.log(`  Staking Rewards:             ${fmt(totalRewards).padStart(20)} tokens  (+${rewardPercentage}% of stake)`);
  console.log(`                               ${"─".repeat(20)}`);
  console.log(`  REWARDS YOU WOULD RECEIVE:   ${fmt(totalRewards).padStart(20)} tokens`);
  console.log();
  console.log(`  After unstake (wallet):      ${fmt(walletBalance + totalRewards).padStart(20)} tokens`);

  if (pendingDays > 0) {
    console.log();
    console.log(`  NOTE: ${pendingDays} day(s) are pending snapshot. Take snapshot first to include those rewards.`);
  }

  if (pool.paused === 1) {
    console.log();
    console.log(`  NOTE: Pool is PAUSED. Unstake still works while paused.`);
  }

  // ═══════════════════════════════════════════════════════════════
  // TIMING INFO
  // ═══════════════════════════════════════════════════════════════
  if (daysRemaining > 0 && onChainDay < TOTAL_DAYS) {
    const nextDayStart = pool.startTime + (onChainDay + 1) * SECONDS_PER_DAY;
    const secsToNextDay = nextDayStart - now;
    if (secsToNextDay > 0) {
      console.log();
      console.log(`  Next on-chain day (${onChainDay + 1}) starts in: ${formatDuration(secsToNextDay)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // RAW DEBUG
  // ═══════════════════════════════════════════════════════════════
  console.log("\n-- DEBUG (raw on-chain values) -------------------------------------");
  console.log(`  on-chain day:     ${onChainDay}`);
  console.log(`  snapshot_count:   ${pool.snapshotCount}`);
  console.log(`  total_staked raw: ${pool.totalStaked}`);
  console.log(`  staked_amount raw:${userStake.stakedAmount}`);
  for (let i = 0; i < Math.min(pool.snapshotCount + 2, TOTAL_DAYS); i++) {
    console.log(`  daily_snapshots[${i}] raw: ${pool.dailySnapshots[i]}`);
  }

  console.log();
  console.log("=".repeat(72));
  console.log(`   Generated: ${new Date().toUTCString()}`);
  console.log("=".repeat(72));
  console.log();
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
