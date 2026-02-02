/**
 * initialize-pool.ts
 *
 * Initializes the Memeland Airdrop pool and funds it with 150M $FIGHT tokens.
 *
 * Usage:
 *   yarn init-pool:devnet    # uses .env.testnet
 *   yarn init-pool:prod      # uses .env.prod
 *
 * Required env vars:
 *   ANCHOR_PROVIDER_URL  — RPC endpoint
 *   ANCHOR_WALLET        — path to admin keypair JSON
 *   PROGRAM_ID           — deployed program ID
 *   TOKEN_MINT           — $FIGHT token mint address
 *   MERKLE_JSON          — path to merkle tree JSON (from build-merkle)
 *
 * Optional env vars:
 *   START_TIME           — unix timestamp for pool start (default: now)
 *
 * What this script does:
 *   1. Reads merkle root from the merkle JSON file
 *   2. Calls initialize_pool(start_time, merkle_root)
 *   3. Transfers 150M tokens from admin ATA to the pool token account
 */

import * as fs from "fs";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  transfer,
  getAccount,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";

// ── Config from env ─────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

const TOTAL_SUPPLY = BigInt(150_000_000_000_000); // 150M with 6 decimals
const STAKING_POOL = new BN("100000000000000"); // 100M with 6 decimals

function computeDailyRewards(): BN[] {
  const K = 0.05;
  const expValues = Array.from({ length: 20 }, (_, d) => Math.exp(K * d));
  const totalExp = expValues.reduce((a, b) => a + b, 0);

  const rewards = expValues.map(
    (v) => new BN(Math.floor((Number(STAKING_POOL.toString()) * v) / totalExp))
  );

  // Adjust last element so sum is exactly STAKING_POOL
  const currentSum = rewards.reduce((a, b) => a.add(b), new BN(0));
  const diff = STAKING_POOL.sub(currentSum);
  rewards[19] = rewards[19].add(diff);

  return rewards;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Load env
  const rpcUrl = requireEnv("ANCHOR_PROVIDER_URL");
  const walletPath = requireEnv("ANCHOR_WALLET");
  const programIdStr = requireEnv("PROGRAM_ID");
  const tokenMintStr = requireEnv("TOKEN_MINT");
  const merkleJsonPath = requireEnv("MERKLE_JSON");
  const startTimeOverride = process.env.START_TIME;

  // Resolve wallet path
  const resolvedWalletPath = walletPath.startsWith("~")
    ? walletPath.replace("~", process.env.HOME || "")
    : path.resolve(walletPath);

  console.log("=== Memeland Pool Initialization ===\n");
  console.log(`RPC:        ${rpcUrl}`);
  console.log(`Wallet:     ${resolvedWalletPath}`);
  console.log(`Program:    ${programIdStr}`);
  console.log(`Token Mint: ${tokenMintStr}`);
  console.log(`Merkle:     ${merkleJsonPath}`);
  console.log("");

  // Load admin keypair
  const adminSecret = JSON.parse(fs.readFileSync(resolvedWalletPath, "utf-8"));
  const admin = Keypair.fromSecretKey(Uint8Array.from(adminSecret));
  console.log(`Admin pubkey: ${admin.publicKey.toBase58()}`);

  // Connection
  const connection = new Connection(rpcUrl, "confirmed");
  const balance = await connection.getBalance(admin.publicKey);
  console.log(`Admin SOL balance: ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 0.05 * 1e9) {
    console.error("Admin wallet needs more SOL for rent + transaction fees");
    process.exit(1);
  }

  // Program
  const programId = new PublicKey(programIdStr);
  const tokenMint = new PublicKey(tokenMintStr);

  // Load IDL
  const idlPath = path.resolve(__dirname, "..", "target", "idl", "memeland_airdrop.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  // Create provider and program
  const wallet = new anchor.Wallet(admin);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new Program(idl, provider);

  // Load merkle root
  const resolvedMerklePath = path.resolve(merkleJsonPath);
  if (!fs.existsSync(resolvedMerklePath)) {
    console.error(`Merkle JSON not found: ${resolvedMerklePath}`);
    console.error("Run: yarn build-merkle data/allowlist.csv");
    process.exit(1);
  }
  const merkleData = JSON.parse(fs.readFileSync(resolvedMerklePath, "utf-8"));
  const merkleRoot: number[] = merkleData.merkleRoot;
  console.log(`Merkle root: [${merkleRoot.slice(0, 4).join(", ")}...]`);
  console.log(`Merkle entries: ${merkleData.totalEntries}`);
  console.log(`Merkle total amount: ${merkleData.totalAmountHuman} tokens`);

  // Derive PDAs
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state"), tokenMint.toBuffer()],
    programId
  );
  const [poolTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_token"), poolState.toBuffer()],
    programId
  );

  console.log(`\nPool state PDA:  ${poolState.toBase58()}`);
  console.log(`Pool token PDA:  ${poolTokenAccount.toBase58()}`);

  // Check if pool already exists
  const existingPool = await connection.getAccountInfo(poolState);
  if (existingPool) {
    console.error("\nPool already initialized! Skipping initialize_pool.");
    console.error("If you need to re-initialize, close the account first.");
    process.exit(1);
  }

  // Start time
  const startTime = startTimeOverride
    ? parseInt(startTimeOverride)
    : Math.floor(Date.now() / 1000);
  const startDate = new Date(startTime * 1000);
  console.log(`\nStart time: ${startTime} (${startDate.toUTCString()})`);

  // ── Step 1: Initialize pool ───────────────────────────────────────────────

  console.log("\n--- Step 1: Initialize Pool ---");

  const dailyRewards = computeDailyRewards();
  console.log(`Daily rewards computed off-chain (${dailyRewards.length} days)`);

  const tx = await program.methods
    .initializePool(new BN(startTime), merkleRoot, dailyRewards)
    .accounts({
      admin: admin.publicKey,
      poolState,
      tokenMint,
      poolTokenAccount,
    })
    .rpc();

  console.log(`initialize_pool tx: ${tx}`);

  // Verify
  const poolAccount = await connection.getAccountInfo(poolState);
  if (!poolAccount) {
    console.error("Pool account not found after initialization!");
    process.exit(1);
  }
  console.log(`Pool account size: ${poolAccount.data.length} bytes`);

  // ── Step 2: Fund pool with 150M tokens ────────────────────────────────────

  console.log("\n--- Step 2: Fund Pool (150M $FIGHT) ---");

  // Get admin's ATA
  const adminAta = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    tokenMint,
    admin.publicKey
  );

  const adminBalance = adminAta.amount;
  console.log(`Admin token balance: ${Number(adminBalance) / 1e6} tokens`);

  if (adminBalance < TOTAL_SUPPLY) {
    console.error(
      `Insufficient token balance. Need ${Number(TOTAL_SUPPLY) / 1e6}, have ${Number(adminBalance) / 1e6}`
    );
    process.exit(1);
  }

  const fundTx = await transfer(
    connection,
    admin,
    adminAta.address,
    poolTokenAccount,
    admin,
    TOTAL_SUPPLY
  );
  console.log(`Fund tx: ${fundTx}`);

  // Verify pool balance
  const poolTokenInfo = await getAccount(connection, poolTokenAccount);
  console.log(
    `Pool token balance: ${Number(poolTokenInfo.amount) / 1e6} tokens`
  );

  // ── Done ──────────────────────────────────────────────────────────────────

  console.log("\n=== Pool Initialized & Funded ===");
  console.log(`Pool State:         ${poolState.toBase58()}`);
  console.log(`Pool Token Account: ${poolTokenAccount.toBase58()}`);
  console.log(`Token Mint:         ${tokenMint.toBase58()}`);
  console.log(`Start Time:         ${startDate.toUTCString()}`);
  console.log(`Total Funded:       ${Number(TOTAL_SUPPLY) / 1e6} $FIGHT`);
  console.log(`\nUsers can now claim airdrops using their merkle proofs.`);
  console.log(`Admin must call snapshot() daily at 12:00-12:05 AM UTC.`);
}

main().catch((err) => {
  console.error("\nError:", err.message || err);
  process.exit(1);
});
