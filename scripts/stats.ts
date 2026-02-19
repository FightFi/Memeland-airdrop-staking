/**
 * stats.ts
 *
 * Comprehensive pool statistics and analytics.
 * Shows claims, stakes, rewards, snapshots, and more.
 *
 * Usage:
 *   yarn stats:devnet                    # Show all stats
 *   yarn stats:devnet --json             # Output as JSON
 *   yarn stats:devnet --save             # Save to reports/stats-{timestamp}.txt
 *   yarn stats:devnet --save --json      # Save JSON to reports/stats-{timestamp}.json
 *   yarn stats:devnet --out report.txt   # Save to specific file
 *
 * Required env vars:
 *   ANCHOR_PROVIDER_URL  — RPC endpoint
 *   ADMIN_KEYPAIR        — path to admin keypair JSON
 *   PROGRAM_ID           — deployed program ID
 *   TOKEN_MINT           — $FIGHT token mint address
 *   MERKLE_JSON          — path to merkle tree JSON
 */

import * as fs from "fs";
import * as path from "path";
import { Connection, PublicKey, GetProgramAccountsFilter } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

// Constants matching the program
const TOTAL_DAYS = 20;
const CLAIM_WINDOW_DAYS = 40;
const SECONDS_PER_DAY = 86400;
const AIRDROP_POOL = BigInt("67000000000000000"); // 67M with 9 decimals
const STAKING_POOL = BigInt("133000000000000000"); // 133M with 9 decimals
const TOTAL_POOL = AIRDROP_POOL + STAKING_POOL; // 200M

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

function parseArgs(): { jsonOutput: boolean; save: boolean; outputFile?: string } {
  const args = process.argv.slice(2);
  let outputFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--out" || args[i] === "-o") && args[i + 1]) {
      outputFile = args[i + 1];
      i++;
    }
  }

  return {
    jsonOutput: args.includes("--json"),
    save: args.includes("--save") || !!outputFile,
    outputFile,
  };
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
  activeStakers: number;
  totalUnstaked: number;
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

  // allowlist_total_raw: u64 (added in audit)
  offset += 8;

  const startTime = Number(data.readBigInt64LE(offset));
  offset += 8;

  const totalStaked = data.readBigUInt64LE(offset);
  offset += 8;

  const totalAirdropClaimed = data.readBigUInt64LE(offset);
  offset += 8;

  const snapshotCount = data.readUInt8(offset);
  offset += 1;

  // bump
  offset += 1;

  // pool_token_bump
  offset += 1;

  const paused = data.readUInt8(offset);
  offset += 1;

  const activeStakers = data.readUInt32LE(offset);
  offset += 4;

  const totalUnstaked = data.readUInt32LE(offset);
  offset += 4;

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
    paused,
    activeStakers,
    totalUnstaked,
    dailyRewards,
    dailySnapshots,
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

interface MerkleJson {
  merkleRoot: number[];
  totalEntries: number;
  totalAmount: string;
  totalAmountHuman: string;
  claims: Record<string, { amount: string; amountRaw: string; proof: number[][] }>;
}

function formatTokens(amount: bigint, decimals = 9): string {
  const num = Number(amount) / Math.pow(10, decimals);
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(part: bigint, total: bigint): string {
  if (total === 0n) return "0.00%";
  const pct = (Number(part) / Number(total)) * 100;
  return pct.toFixed(2) + "%";
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${mins}m`;
  } else if (hours > 0) {
    return `${hours}h ${mins}m`;
  } else {
    return `${mins}m`;
  }
}

async function main() {
  const { jsonOutput, save, outputFile } = parseArgs();

  // Collect output for potential file saving
  const outputLines: string[] = [];
  const log = (msg: string = "") => {
    outputLines.push(msg);
    if (!save || outputFile) {
      console.log(msg);
    }
  };

  const rpcUrl = requireEnv("ANCHOR_PROVIDER_URL");
  const programIdStr = requireEnv("PROGRAM_ID");
  const tokenMintStr = requireEnv("TOKEN_MINT");
  const merkleJsonPath = process.env.MERKLE_JSON || "";

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
  const now = Math.floor(Date.now() / 1000);

  // Calculate time-based metrics
  const elapsedSeconds = Math.max(0, now - pool.startTime);
  console.log(pool.startTime, now)
  const currentDay = pool.startTime > now ? 0 : Math.floor(elapsedSeconds / SECONDS_PER_DAY);
  const daysRemaining = Math.max(0, TOTAL_DAYS - currentDay + 1);
  const isExpired = currentDay >= CLAIM_WINDOW_DAYS;

  // Load merkle data if available
  let merkleData: MerkleJson | null = null;
  let eligibleWallets = 0;
  let eligibleAmount = 0n;

  if (merkleJsonPath && fs.existsSync(path.resolve(merkleJsonPath))) {
    merkleData = JSON.parse(fs.readFileSync(path.resolve(merkleJsonPath), "utf-8"));
    eligibleWallets = merkleData!.totalEntries;
    eligibleAmount = BigInt(merkleData!.totalAmount);
  }

  // Fetch all ClaimMarker accounts (people who claimed)
  const claimMarkerFilters: GetProgramAccountsFilter[] = [
    { dataSize: 8 + 1 }, // discriminator + bump
    { memcmp: { offset: 0, bytes: "" } }, // We'll filter by program
  ];

  // Get all accounts owned by the program with ClaimMarker size
  const claimMarkerAccounts = await connection.getProgramAccounts(programId, {
    filters: [{ dataSize: 8 + 1 }], // ClaimMarker size
  });

  // Filter to only include markers for this pool
  let claimedCount = 0;
  for (const account of claimMarkerAccounts) {
    // ClaimMarker PDA: ["claimed", pool_state, user]
    // We verify by checking if the account is derived from our pool
    const [expectedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("claimed"), poolState.toBuffer(), account.account.data.slice(0, 0)], // Can't easily verify without iterating
      programId
    );
    // Since we can't easily filter, we count all markers as approximate
    claimedCount++;
  }

  // More accurate: count by fetching UserStake accounts
  const userStakeAccounts = await connection.getProgramAccounts(programId, {
    filters: [{ dataSize: 8 + 32 + 8 + 1 }], // UserStake size: discriminator + owner + staked_amount + bump
  });

  // Parse user stakes for detailed analysis
  const stakes: UserStakeData[] = [];
  let activeStakers = 0;
  let totalStakedVerified = 0n;

  for (const account of userStakeAccounts) {
    try {
      const stake = parseUserStake(account.account.data);
      // Verify this stake belongs to our pool by checking PDA derivation
      const [expectedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("user_stake"), poolState.toBuffer(), stake.owner.toBuffer()],
        programId
      );
      if (expectedPda.equals(account.pubkey)) {
        stakes.push(stake);
        activeStakers++;
        totalStakedVerified += stake.stakedAmount;
      }
    } catch (e) {
      // Skip invalid accounts
    }
  }

  // Get pool token balance
  let poolTokenBalance = 0n;
  try {
    const tokenAccount = await getAccount(connection, pool.poolTokenAccount);
    poolTokenBalance = tokenAccount.amount;
  } catch (e) {
    // Token account might not exist or be closed
  }

  // Calculate rewards metrics
  let totalRewardsConfigured = 0n;
  let rewardsDistributableSoFar = 0n;
  for (let i = 0; i < TOTAL_DAYS; i++) {
    totalRewardsConfigured += pool.dailyRewards[i];
    if (i < currentDay) {
      rewardsDistributableSoFar += pool.dailyRewards[i];
    }
  }

  // Estimate unstaked users (claimed - active stakers)
  // This is approximate since ClaimMarkers persist
  const estimatedUnstaked = Math.max(0, claimMarkerAccounts.length - activeStakers);

  // Calculate rewards paid out to unstakers from actual staking data:
  // 1. Sum total rewards distributed across all snapshotted days
  // 2. Subtract pending rewards for active stakers (their share still in the pool)
  // This avoids relying on a hardcoded initial funding amount.
  let totalRewardsDistributed = 0n;
  for (let d = 0; d < pool.snapshotCount && d < TOTAL_DAYS; d++) {
    totalRewardsDistributed += pool.dailyRewards[d];
  }

  let pendingRewardsForActiveStakers = 0n;
  for (const stake of stakes) {
    for (let d = 0; d < pool.snapshotCount && d < TOTAL_DAYS; d++) {
      const snapshotTotal = pool.dailySnapshots[d];
      if (snapshotTotal === 0n) continue;
      const daily = pool.dailyRewards[d];
      // Use 128-bit math to avoid overflow
      const userShare = (BigInt(stake.stakedAmount) * BigInt(daily)) / BigInt(snapshotTotal);
      pendingRewardsForActiveStakers += userShare;
    }
  }

  const totalRewardsPaid = totalRewardsDistributed > pendingRewardsForActiveStakers
    ? totalRewardsDistributed - pendingRewardsForActiveStakers
    : 0n;

  // Calculate claim statistics
  const airdropRemaining = AIRDROP_POOL - pool.totalAirdropClaimed;
  const claimPercentage = formatPercent(pool.totalAirdropClaimed, AIRDROP_POOL);

  let largestStake = 0n;
  let smallestStake = stakes.length > 0 ? stakes[0].stakedAmount : 0n;

  for (const stake of stakes) {
    if (stake.stakedAmount > largestStake) largestStake = stake.stakedAmount;
    if (stake.stakedAmount < smallestStake) smallestStake = stake.stakedAmount;
  }

  // Build stats object
  const stats = {
    pool: {
      address: poolState.toBase58(),
      admin: pool.admin.toBase58(),
      tokenMint: pool.tokenMint.toBase58(),
      status: pool.paused === 1 ? "PAUSED" : "ACTIVE",
      paused: pool.paused === 1,
    },
    time: {
      startTime: pool.startTime,
      startTimeHuman: new Date(pool.startTime * 1000).toUTCString(),
      currentDay,
      totalDays: TOTAL_DAYS,
      daysRemaining,
      daysElapsed: Math.min(currentDay, TOTAL_DAYS),
      elapsedTime: formatDuration(elapsedSeconds),
      isExpired,
    },
    claims: {
      totalEligibleWallets: eligibleWallets,
      totalEligibleAmount: formatTokens(eligibleAmount),
      totalClaimed: claimMarkerAccounts.length,
      claimedAmount: formatTokens(pool.totalAirdropClaimed),
      claimedAmountRaw: pool.totalAirdropClaimed.toString(),
      remainingAmount: formatTokens(airdropRemaining),
      claimPercentage,
      airdropPoolSize: formatTokens(AIRDROP_POOL),
    },
    staking: {
      activeStakers,
      estimatedUnstaked,
      totalStaked: formatTokens(pool.totalStaked),
      totalStakedRaw: pool.totalStaked.toString(),
      totalRewardsPaid: formatTokens(totalRewardsPaid),
      totalRewardsPaidRaw: totalRewardsPaid.toString(),
      averageStake: activeStakers > 0 ? formatTokens(pool.totalStaked / BigInt(activeStakers)) : "0",
      largestStake: formatTokens(largestStake),
      smallestStake: formatTokens(smallestStake),
      stakingPoolSize: formatTokens(STAKING_POOL),
    },
    stakers: stakes
      .sort((a, b) => (b.stakedAmount > a.stakedAmount ? 1 : -1))
      .map((s) => ({
        owner: s.owner.toBase58(),
        amount: formatTokens(s.stakedAmount),
        amountRaw: s.stakedAmount.toString(),
        share: formatPercent(s.stakedAmount, pool.totalStaked),
      })),
    snapshots: {
      count: pool.snapshotCount,
      required: Math.min(currentDay, TOTAL_DAYS),
      missing: Math.max(0, Math.min(currentDay, TOTAL_DAYS) - pool.snapshotCount),
      daily: pool.dailySnapshots.slice(0, TOTAL_DAYS).map((s, i) => ({
        day: i + 1,
        totalStaked: formatTokens(s),
        taken: s > 0n || i < pool.snapshotCount,
      })),
    },
    rewards: {
      totalConfigured: formatTokens(totalRewardsConfigured),
      distributableSoFar: formatTokens(rewardsDistributableSoFar),
      dailyRewards: pool.dailyRewards.slice(0, TOTAL_DAYS).map((r, i) => ({
        day: i + 1,
        amount: formatTokens(r),
        elapsed: i < currentDay,
      })),
    },
    treasury: {
      poolTokenBalance: formatTokens(poolTokenBalance),
      poolTokenBalanceRaw: poolTokenBalance.toString(),
      virtualStaked: formatTokens(pool.totalStaked),
      unclaimedAirdrop: merkleData ? formatTokens(eligibleAmount - pool.totalAirdropClaimed) : "N/A (no merkle data)",
      stakingRewardsMax: formatTokens(STAKING_POOL),
    },
  };

  if (jsonOutput) {
    const jsonStr = JSON.stringify(stats, null, 2);
    if (save) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = outputFile || `reports/stats-${timestamp}.json`;
      const dir = path.dirname(filename);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filename, jsonStr);
      console.log(`Stats saved to: ${filename}`);
    } else {
      console.log(jsonStr);
    }
    return;
  }

  // Pretty print
  const networkName = rpcUrl.includes("devnet") ? "DEVNET" : rpcUrl.includes("mainnet") ? "MAINNET" : "UNKNOWN";

  log("\n" + "═".repeat(70));
  log("   MEMELAND AIRDROP & STAKING - POOL STATISTICS");
  log("═".repeat(70));

  // Status Banner
  const statusEmoji = pool.paused === 1 ? "🔴" : "🟢";
  const statusText = pool.paused === 1 ? "PAUSED" : "ACTIVE";
  log(`\n   Status: ${statusEmoji} ${statusText}          Network: ${networkName}`);

  // Pool Info
  log("\n┌─ POOL INFO ─────────────────────────────────────────────────────┐");
  log(`│  Address:     ${poolState.toBase58()}`);
  log(`│  Admin:       ${pool.admin.toBase58()}`);
  log(`│  Token Mint:  ${pool.tokenMint.toBase58()}`);
  log("└─────────────────────────────────────────────────────────────────┘");

  // Time Progress
  log("\n┌─ TIME PROGRESS ─────────────────────────────────────────────────┐");
  log(`│  Started:       ${new Date(pool.startTime * 1000).toUTCString()}`);
  log(`│  Current Day:   ${currentDay} / ${TOTAL_DAYS} (${daysRemaining} days remaining)`);
  log(`│  Elapsed:       ${formatDuration(elapsedSeconds)}`);

  // Progress bar
  const progressPct = Math.min(100, (currentDay / TOTAL_DAYS) * 100);
  const progressBar = "█".repeat(Math.floor(progressPct / 5)) + "░".repeat(20 - Math.floor(progressPct / 5));
  log(`│  Progress:     [${progressBar}] ${progressPct.toFixed(0)}%`);

  if (isExpired) {
    log(`│  ⚠️  CLAIM WINDOW EXPIRED (day ${CLAIM_WINDOW_DAYS}+) - Admin can terminate, recover tokens, and close pool`);
  }
  log("└─────────────────────────────────────────────────────────────────┘");

  // Claims
  log("\n┌─ AIRDROP CLAIMS ────────────────────────────────────────────────┐");
  if (merkleData) {
    log(`│  Eligible Wallets:  ${eligibleWallets.toLocaleString()}`);
    log(`│  Eligible Amount:   ${formatTokens(eligibleAmount)} tokens`);
  }
  log(`│  Total Claimed:     ${claimMarkerAccounts.length.toLocaleString()} wallets`);
  log(`│  Claimed Amount:    ${formatTokens(pool.totalAirdropClaimed)} / ${formatTokens(AIRDROP_POOL)} (${claimPercentage})`);
  log(`│  Remaining:         ${formatTokens(airdropRemaining)} tokens`);

  // Claim progress bar
  const claimPct = Number(pool.totalAirdropClaimed) / Number(AIRDROP_POOL) * 100;
  const claimBar = "█".repeat(Math.floor(claimPct / 5)) + "░".repeat(20 - Math.floor(claimPct / 5));
  log(`│  Pool Usage:       [${claimBar}] ${claimPct.toFixed(1)}%`);
  log("└─────────────────────────────────────────────────────────────────┘");

  // Staking
  log("\n┌─ STAKING ───────────────────────────────────────────────────────┐");
  log(`│  Active Stakers:   ${pool.activeStakers.toLocaleString()} (on-chain)`);
  log(`│  Unstaked:         ${pool.totalUnstaked.toLocaleString()} users (on-chain)`);
  log(`│  Rewards Paid:     ${formatTokens(totalRewardsPaid)} tokens`);
  log(`│  Total Staked:     ${formatTokens(pool.totalStaked)} tokens`);
  if (pool.activeStakers > 0) {
    log(`│  Average Stake:    ${formatTokens(pool.totalStaked / BigInt(pool.activeStakers))} tokens`);
    log(`│  Largest Stake:    ${formatTokens(largestStake)} tokens`);
    log(`│  Smallest Stake:   ${formatTokens(smallestStake)} tokens`);
  }
  log("└─────────────────────────────────────────────────────────────────┘");

  // Individual Stakes
  if (stakes.length > 0) {
    const sorted = [...stakes].sort((a, b) => (b.stakedAmount > a.stakedAmount ? 1 : -1));
    log("\n┌─ STAKERS ───────────────────────────────────────────────────────┐");
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      const pct = formatPercent(s.stakedAmount, pool.totalStaked);
      log(`│  ${(i + 1).toString().padStart(2)}. ${s.owner.toBase58()}`);
      log(`│      ${formatTokens(s.stakedAmount).padStart(20)} tokens (${pct})`);
    }
    log("└─────────────────────────────────────────────────────────────────┘");
  }

  // Snapshots — snapshot for day N is taken on day N+1, so required = currentDay (not currentDay+1)
  const snapshotsRequired = Math.min(currentDay, TOTAL_DAYS);
  log("\n┌─ SNAPSHOTS ─────────────────────────────────────────────────────┐");
  log(`│  Taken:     ${pool.snapshotCount} / ${snapshotsRequired}`);
  const missingSnapshots = Math.max(0, snapshotsRequired - pool.snapshotCount);
  if (missingSnapshots > 0) {
    log(`│  ⚠️  Missing: ${missingSnapshots} snapshot(s) - run 'yarn snapshot:devnet'`);
  } else {
    log(`│  ✅ All snapshots up to date`);
  }

  // Show recent snapshots
  if (pool.snapshotCount > 0) {
    log("│");
    log("│  Recent Snapshots:");
    const startIdx = Math.max(0, pool.snapshotCount - 5);
    for (let i = startIdx; i < Math.min(pool.snapshotCount, TOTAL_DAYS); i++) {
      const snap = pool.dailySnapshots[i];
      log(`│    Day ${i.toString().padStart(2)}: ${formatTokens(snap).padStart(20)} tokens staked`);
    }
  }
  log("└─────────────────────────────────────────────────────────────────┘");

  // Rewards
  log("\n┌─ REWARDS ───────────────────────────────────────────────────────┐");
  log(`│  Total Pool:        ${formatTokens(STAKING_POOL)} tokens`);
  log(`│  Distributable:     ${formatTokens(rewardsDistributableSoFar)} (days 1-${Math.min(currentDay, TOTAL_DAYS)})`);
  log("│");
  log("│  Daily Rewards (first 5 and last 5 days):");
  for (let i = 0; i < 5; i++) {
    const emoji = i < currentDay ? "✅" : "⏳";
    log(`│    Day ${(i + 1).toString().padStart(2)}: ${formatTokens(pool.dailyRewards[i]).padStart(18)} ${emoji}`);
  }
  log("│    ...");
  for (let i = 15; i < 20; i++) {
    const emoji = i < currentDay ? "✅" : "⏳";
    log(`│    Day ${(i + 1).toString().padStart(2)}: ${formatTokens(pool.dailyRewards[i]).padStart(18)} ${emoji}`);
  }
  log("└─────────────────────────────────────────────────────────────────┘");

  // Treasury
  log("\n┌─ TREASURY ──────────────────────────────────────────────────────┐");
  log(`│  Pool Token Balance:     ${formatTokens(poolTokenBalance)} tokens`);
  log(`│  ├─ Virtual staked:     ${formatTokens(pool.totalStaked)} tokens (no real obligation)`);
  if (merkleData) {
    const unclaimedAirdrop = eligibleAmount - pool.totalAirdropClaimed;
    log(`│  ├─ Unclaimed airdrop:  ${formatTokens(unclaimedAirdrop)} tokens`);
  }
  log(`│  └─ Staking rewards:    ${formatTokens(STAKING_POOL)} tokens (max)`);
  log("└─────────────────────────────────────────────────────────────────┘");

  log("\n" + "═".repeat(70));
  log(`   Generated: ${new Date().toUTCString()}`);
  log("═".repeat(70) + "\n");

  // Save to file if requested
  if (save) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = outputFile || `reports/stats-${timestamp}.txt`;
    const dir = path.dirname(filename);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filename, outputLines.join("\n"));
    console.log(`\n📁 Stats saved to: ${filename}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
