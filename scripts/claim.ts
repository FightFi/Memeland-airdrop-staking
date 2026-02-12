/**
 * claim.ts
 *
 * Claims airdrop tokens for a user wallet.
 * Looks up the wallet in the merkle JSON and submits the claim transaction.
 *
 * Usage:
 *   yarn claim:devnet                           # Claim using ANCHOR_WALLET
 *   yarn claim:devnet --wallet <path>           # Claim using specific keypair
 *   yarn claim:devnet --check                   # Only check eligibility, don't claim
 *   yarn claim:devnet --check --address <pubkey> # Check eligibility for any address
 *   yarn claim:devnet --yes                     # Skip confirmation prompt
 *
 * Required env vars:
 *   ANCHOR_PROVIDER_URL  — RPC endpoint
 *   ANCHOR_WALLET        — path to user keypair JSON (default wallet)
 *   PROGRAM_ID           — deployed program ID
 *   TOKEN_MINT           — $FIGHT token mint address
 *   MERKLE_JSON          — path to merkle tree JSON
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

function parseArgs(): { walletPath?: string; checkOnly: boolean; address?: string; skipConfirm: boolean } {
  const args = process.argv.slice(2);
  let walletPath: string | undefined;
  let checkOnly = false;
  let address: string | undefined;
  let skipConfirm = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--wallet" && args[i + 1]) {
      walletPath = args[i + 1];
      i++;
    } else if (args[i] === "--check") {
      checkOnly = true;
    } else if (args[i] === "--address" && args[i + 1]) {
      address = args[i + 1];
      i++;
    } else if (args[i] === "--yes" || args[i] === "-y") {
      skipConfirm = true;
    }
  }

  return { walletPath, checkOnly, address, skipConfirm };
}

interface ClaimData {
  amount: string;
  amountRaw: string;
  proof: number[][];
}

interface MerkleJson {
  merkleRoot: number[];
  totalEntries: number;
  totalAmount: string;
  totalAmountHuman: string;
  claims: Record<string, ClaimData>;
}

interface PoolData {
  startTime: number;
  totalStaked: bigint;
  totalAirdropClaimed: bigint;
  snapshotCount: number;
  terminated: number;
  paused: number;
}

function parsePoolState(data: Buffer): PoolData {
  const startTime = Number(data.readBigInt64LE(8 + 32 + 32 + 32 + 32));
  const totalStaked = data.readBigUInt64LE(8 + 32 + 32 + 32 + 32 + 8);
  const totalAirdropClaimed = data.readBigUInt64LE(8 + 32 + 32 + 32 + 32 + 8 + 8);
  const snapshotCount = data.readUInt8(8 + 32 + 32 + 32 + 32 + 8 + 8 + 8);
  const terminated = data.readUInt8(8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 1);
  const paused = data.readUInt8(8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1 + 1);

  return { startTime, totalStaked, totalAirdropClaimed, snapshotCount, terminated, paused };
}

async function main() {
  const { walletPath: argWalletPath, checkOnly, address: checkAddress, skipConfirm } = parseArgs();

  const rpcUrl = requireEnv("ANCHOR_PROVIDER_URL");
  const defaultWalletPath = requireEnv("ANCHOR_WALLET");
  const programIdStr = requireEnv("PROGRAM_ID");
  const tokenMintStr = requireEnv("TOKEN_MINT");
  const merkleJsonPath = requireEnv("MERKLE_JSON");

  // Resolve wallet path
  const walletPath = argWalletPath || defaultWalletPath;
  const resolvedWalletPath = walletPath.startsWith("~")
    ? walletPath.replace("~", process.env.HOME || "")
    : path.resolve(walletPath);

  // Load merkle JSON
  const resolvedMerklePath = path.resolve(merkleJsonPath);
  if (!fs.existsSync(resolvedMerklePath)) {
    console.error(`Merkle JSON not found: ${resolvedMerklePath}`);
    process.exit(1);
  }
  const merkleData: MerkleJson = JSON.parse(fs.readFileSync(resolvedMerklePath, "utf-8"));

  // Determine which address to check/claim for
  let userPubkey: PublicKey;
  let userKeypair: Keypair | null = null;

  if (checkAddress) {
    // Just checking an address, no keypair needed
    userPubkey = new PublicKey(checkAddress);
  } else {
    // Load keypair for claiming
    const userSecret = JSON.parse(fs.readFileSync(resolvedWalletPath, "utf-8"));
    userKeypair = Keypair.fromSecretKey(Uint8Array.from(userSecret));
    userPubkey = userKeypair.publicKey;
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const programId = new PublicKey(programIdStr);
  const tokenMint = new PublicKey(tokenMintStr);

  console.log("=".repeat(60));
  console.log("Memeland Airdrop - Claim Script");
  console.log("=".repeat(60));
  console.log(`RPC:        ${rpcUrl}`);
  console.log(`Program:    ${programIdStr}`);
  console.log(`Token Mint: ${tokenMintStr}`);
  console.log(`User:       ${userPubkey.toBase58()}`);
  console.log(`Mode:       ${checkOnly ? "CHECK ONLY" : "CLAIM"}`);
  console.log("=".repeat(60));

  // Check if user is in merkle tree
  const userAddress = userPubkey.toBase58();
  const claimData = merkleData.claims[userAddress];

  if (!claimData) {
    console.log("\n❌ Wallet NOT FOUND in merkle tree.");
    console.log("This wallet is not eligible for the airdrop.");
    process.exit(1);
  }

  console.log("\n✅ Wallet FOUND in merkle tree!");
  console.log(`   Amount:     ${claimData.amount} tokens`);
  console.log(`   Amount Raw: ${claimData.amountRaw}`);
  console.log(`   Proof size: ${claimData.proof.length} hashes`);

  // Derive PDAs
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_state"), tokenMint.toBuffer()],
    programId
  );
  const [claimMarker] = PublicKey.findProgramAddressSync(
    [Buffer.from("claimed"), poolState.toBuffer(), userPubkey.toBuffer()],
    programId
  );
  const [userStake] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stake"), poolState.toBuffer(), userPubkey.toBuffer()],
    programId
  );
  const [poolTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_token"), poolState.toBuffer()],
    programId
  );
  const userTokenAccount = await getAssociatedTokenAddress(tokenMint, userPubkey);

  console.log(`\n   Pool State:    ${poolState.toBase58()}`);
  console.log(`   Claim Marker:  ${claimMarker.toBase58()}`);
  console.log(`   User Stake:    ${userStake.toBase58()}`);
  console.log(`   Pool Token:    ${poolTokenAccount.toBase58()}`);
  console.log(`   User Token:    ${userTokenAccount.toBase58()}`);

  // Check pool state
  const poolAccount = await connection.getAccountInfo(poolState);
  if (!poolAccount) {
    console.error("\n❌ Pool not found. Has initialize_pool been called?");
    process.exit(1);
  }

  const pool = parsePoolState(poolAccount.data);
  console.log(`\n   Pool Status:`);
  console.log(`   - Paused:     ${pool.paused === 1 ? "YES ⚠️" : "NO"}`);
  console.log(`   - Terminated: ${pool.terminated === 1 ? "YES ⚠️" : "NO"}`);
  console.log(`   - Total Claimed: ${Number(pool.totalAirdropClaimed) / 1e9} tokens`);

  // Check if already claimed
  const claimMarkerAccount = await connection.getAccountInfo(claimMarker);
  if (claimMarkerAccount) {
    console.log("\n⚠️  Already claimed! ClaimMarker exists.");

    // Check if stake still exists
    const stakeAccount = await connection.getAccountInfo(userStake);
    if (stakeAccount) {
      // Parse stake amount
      const stakedAmount = stakeAccount.data.readBigUInt64LE(8 + 32); // after discriminator + owner
      console.log(`   Current stake: ${Number(stakedAmount) / 1e9} tokens`);
      console.log("   User can call unstake() to withdraw.");
    } else {
      console.log("   User has already unstaked.");
    }
    process.exit(0);
  }

  if (checkOnly) {
    console.log("\n✅ Eligible to claim! Use without --check to submit transaction.");
    process.exit(0);
  }

  // Verify we can claim
  if (pool.paused === 1) {
    console.error("\n❌ Pool is PAUSED. Cannot claim.");
    process.exit(1);
  }

  if (pool.terminated === 1) {
    console.error("\n❌ Pool is TERMINATED. Cannot claim.");
    process.exit(1);
  }

  if (!userKeypair) {
    console.error("\n❌ Cannot claim: no keypair loaded (use --wallet or set ANCHOR_WALLET)");
    process.exit(1);
  }

  // Load IDL and create program
  const idlPath = path.resolve(__dirname, "..", "target", "idl", "memeland_airdrop.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const wallet = new anchor.Wallet(userKeypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(idl, provider);

  // Check SOL balance
  const solBalance = await connection.getBalance(userPubkey);
  console.log(`\n   SOL Balance: ${(solBalance / 1e9).toFixed(4)} SOL`);

  if (solBalance < 0.01 * 1e9) {
    console.error("❌ Insufficient SOL for transaction fees (~0.01 SOL needed)");
    process.exit(1);
  }

  // Confirm before submitting
  console.log("\n" + "=".repeat(60));
  console.log("⚠️  CONFIRM CLAIM");
  console.log("=".repeat(60));
  console.log(`   Wallet:  ${userPubkey.toBase58()}`);
  console.log(`   Amount:  ${claimData.amount} tokens`);
  console.log(`   Network: ${rpcUrl.includes("devnet") ? "DEVNET" : rpcUrl.includes("mainnet") ? "MAINNET" : rpcUrl}`);
  console.log("=".repeat(60));

  if (!skipConfirm) {
    const confirmed = await askConfirmation("Do you want to proceed with the claim?");
    if (!confirmed) {
      console.log("\n❌ Claim cancelled by user.");
      process.exit(0);
    }
  } else {
    console.log("   (--yes flag: skipping confirmation)");
  }

  // Submit claim
  console.log("\n📤 Submitting claim transaction...");

  try {
    const tx = await program.methods
      .claimAirdrop(new BN(claimData.amountRaw), claimData.proof)
      .accounts({
        user: userPubkey,
        poolState,
        claimMarker,
        userStake,
        poolTokenAccount,
        userTokenAccount,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userKeypair])
      .rpc();

    console.log(`\n✅ Claim successful!`);
    console.log(`   TX: ${tx}`);
    console.log(`   Amount: ${claimData.amount} tokens`);
    console.log(`\n   Tokens sent to your wallet. Earning staking rewards from day 0.`);
    console.log(`   Call unstake() before day 35 to collect rewards.`);
  } catch (err: any) {
    const errMsg = err.message || String(err);

    if (errMsg.includes("PoolPaused")) {
      console.error("\n❌ Failed: Pool is paused.");
    } else if (errMsg.includes("PoolTerminated")) {
      console.error("\n❌ Failed: Pool is terminated.");
    } else if (errMsg.includes("InvalidMerkleProof")) {
      console.error("\n❌ Failed: Invalid merkle proof.");
    } else if (errMsg.includes("AirdropPoolExhausted")) {
      console.error("\n❌ Failed: Airdrop pool exhausted (67M limit reached).");
    } else if (errMsg.includes("StakingPeriodEnded")) {
      console.error("\n❌ Failed: Staking period has ended — claims no longer accepted.");
    } else if (errMsg.includes("already in use")) {
      console.error("\n❌ Failed: Already claimed (ClaimMarker exists).");
    } else {
      console.error(`\n❌ Failed: ${errMsg}`);
    }
    process.exit(1);
  }
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

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
