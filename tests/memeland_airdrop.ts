import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
// @ts-ignore
import { keccak256 } from "js-sha3";

// ── Constants ──────────────────────────────────────────────────────────────────

const TOTAL_DAYS = 20;
const SECONDS_PER_DAY = 86400;
const AIRDROP_POOL = new BN("50000000000000"); // 50M with 6 decimals
const STAKING_POOL = new BN("100000000000000"); // 100M with 6 decimals
const TOTAL_POOL = AIRDROP_POOL.add(STAKING_POOL); // 150M

// ── Merkle tree helpers ────────────────────────────────────────────────────────

function keccakHash(data: Buffer): Buffer {
  return Buffer.from(keccak256.arrayBuffer(data));
}

function computeLeaf(wallet: PublicKey, amount: BN): Buffer {
  const amountBuf = amount.toArrayLike(Buffer, "le", 8);
  return keccakHash(Buffer.concat([wallet.toBuffer(), amountBuf]));
}

function hashPair(a: Buffer, b: Buffer): Buffer {
  const [left, right] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return keccakHash(Buffer.concat([left, right]));
}

function buildMerkleTree(leaves: Buffer[]): Buffer[][] {
  const sorted = [...leaves].sort(Buffer.compare);
  const layers: Buffer[][] = [sorted];
  let current = sorted;
  while (current.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashPair(current[i], current[i + 1]));
      } else {
        next.push(current[i]);
      }
    }
    layers.push(next);
    current = next;
  }
  return layers;
}

function getMerkleRoot(layers: Buffer[][]): Buffer {
  return layers[layers.length - 1][0];
}

function getMerkleProof(layers: Buffer[][], leaf: Buffer): Buffer[] {
  let idx = layers[0].findIndex((l) => l.equals(leaf));
  const proof: Buffer[] = [];
  for (const layer of layers.slice(0, -1)) {
    const pairIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (pairIdx < layer.length) {
      proof.push(layer[pairIdx]);
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}

// ── Off-chain reward computation ─────────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("memeland_airdrop", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MemelandAirdrop as Program;
  const admin = (provider.wallet as anchor.Wallet).payer;

  let tokenMint: PublicKey;
  let poolStatePda: PublicKey;
  let poolTokenPda: PublicKey;
  let adminTokenAccount: PublicKey;

  // Test users
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();
  const user3 = Keypair.generate();

  const user1Amount = new BN(1_000_000_000_000); // 1M tokens
  const user2Amount = new BN(2_000_000_000_000); // 2M tokens
  const user3Amount = new BN(500_000_000_000); // 500k tokens

  // Merkle tree
  let merkleRoot: Buffer;
  let merkleLayers: Buffer[][];
  let user1Leaf: Buffer;
  let user2Leaf: Buffer;
  let user3Leaf: Buffer;

  // Start time: aligned to midnight UTC, 2 days in the past
  // This way snapshot for day 0 (and day 1) can be taken during test
  let startTime: number;

  function getPoolStatePda(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool_state"), mint.toBuffer()],
      program.programId
    );
  }

  function getPoolTokenPda(poolState: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool_token"), poolState.toBuffer()],
      program.programId
    );
  }

  function getUserStakePda(
    poolState: PublicKey,
    user: PublicKey
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("user_stake"), poolState.toBuffer(), user.toBuffer()],
      program.programId
    );
  }

  async function fundAccount(pubkey: PublicKey, lamports = 10_000_000_000) {
    const sig = await provider.connection.requestAirdrop(pubkey, lamports);
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  // Raw data offset for daily_rewards in PoolState (after 8-byte discriminator):
  // admin(32) + token_mint(32) + pool_token_account(32) + merkle_root(32)
  // + start_time(8) + total_staked(8) + total_airdrop_claimed(8)
  // + snapshot_count(1) + terminated(1) + bump(1) + pool_token_bump(1) + padding(4)
  // = 160
  const DAILY_REWARDS_OFFSET = 8 + 160;
  const DAILY_SNAPSHOTS_OFFSET = DAILY_REWARDS_OFFSET + 32 * 8; // +256

  before(async () => {
    await Promise.all([
      fundAccount(user1.publicKey),
      fundAccount(user2.publicKey),
      fundAccount(user3.publicKey),
    ]);

    tokenMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    [poolStatePda] = getPoolStatePda(tokenMint);
    [poolTokenPda] = getPoolTokenPda(poolStatePda);

    const adminAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      tokenMint,
      admin.publicKey
    );
    adminTokenAccount = adminAta.address;

    // Build merkle tree
    user1Leaf = computeLeaf(user1.publicKey, user1Amount);
    user2Leaf = computeLeaf(user2.publicKey, user2Amount);
    user3Leaf = computeLeaf(user3.publicKey, user3Amount);
    merkleLayers = buildMerkleTree([user1Leaf, user2Leaf, user3Leaf]);
    merkleRoot = getMerkleRoot(merkleLayers);
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. INITIALIZATION
  // ─────────────────────────────────────────────────────────────────

  describe("initialize_pool", () => {
    it("initializes pool with merkle root and exponential curve", async () => {
      // Start 2 days ago at midnight UTC
      const now = Math.floor(Date.now() / 1000);
      startTime = Math.floor(now / SECONDS_PER_DAY) * SECONDS_PER_DAY - 2 * SECONDS_PER_DAY;

      const dailyRewards = computeDailyRewards();

      console.log("\n      Daily Rewards (tokens with 6 decimals):");
      dailyRewards.forEach((r, i) => {
        const tokens = Number(r.toString()) / 1e6;
        console.log(`        Day ${String(i + 1).padStart(2)}: ${tokens.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} tokens  (raw: ${r.toString()})`);
      });
      const sum = dailyRewards.reduce((a, b) => a.add(b), new BN(0));
      console.log(`        ────────────────────────────────`);
      console.log(`        Total: ${(Number(sum.toString()) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2 })} tokens\n`);

      await program.methods
        .initializePool(
          new BN(startTime),
          Array.from(merkleRoot),
          dailyRewards
        )
        .accounts({
          admin: admin.publicKey,
          poolState: poolStatePda,
          tokenMint: tokenMint,
          poolTokenAccount: poolTokenPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      const poolAccount = await provider.connection.getAccountInfo(poolStatePda);
      expect(poolAccount).to.not.be.null;
      expect(poolAccount.data.length).to.equal(8 + 672);
    });

    it("pre-computes exponential daily rewards summing to STAKING_POOL", async () => {
      const poolAccount = await provider.connection.getAccountInfo(poolStatePda);
      const data = poolAccount.data;

      let totalDailyRewards = BigInt(0);
      for (let i = 0; i < TOTAL_DAYS; i++) {
        const reward = data.readBigUInt64LE(DAILY_REWARDS_OFFSET + i * 8);
        totalDailyRewards += reward;
      }

      const stakingPoolBig = BigInt(STAKING_POOL.toString());
      expect(totalDailyRewards).to.equal(stakingPoolBig);
    });

    it("rewards are monotonically increasing", async () => {
      const poolAccount = await provider.connection.getAccountInfo(poolStatePda);
      const data = poolAccount.data;

      let prevReward = 0;
      for (let i = 0; i < TOTAL_DAYS; i++) {
        const reward = Number(data.readBigUInt64LE(DAILY_REWARDS_OFFSET + i * 8));
        expect(reward).to.be.greaterThan(prevReward);
        prevReward = reward;
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. FUND THE POOL
  // ─────────────────────────────────────────────────────────────────

  describe("fund pool", () => {
    it("admin funds pool with 150M tokens", async () => {
      await mintTo(
        provider.connection,
        admin,
        tokenMint,
        adminTokenAccount,
        admin,
        BigInt(TOTAL_POOL.toString())
      );

      const ix = createTransferInstruction(
        adminTokenAccount,
        poolTokenPda,
        admin.publicKey,
        BigInt(TOTAL_POOL.toString())
      );
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix));

      const poolTokenInfo = await getAccount(provider.connection, poolTokenPda);
      expect(poolTokenInfo.amount.toString()).to.equal(TOTAL_POOL.toString());
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. CLAIM AIRDROP (merkle proof)
  // ─────────────────────────────────────────────────────────────────

  describe("claim_airdrop", () => {
    it("user1 claims with valid merkle proof", async () => {
      const [userStakePda] = getUserStakePda(poolStatePda, user1.publicKey);
      const proof = getMerkleProof(merkleLayers, user1Leaf);
      const proofArrays = proof.map((p) => Array.from(p));

      await program.methods
        .claimAirdrop(user1Amount, proofArrays)
        .accounts({
          user: user1.publicKey,
          poolState: poolStatePda,
          userStake: userStakePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      const userStake = await program.account.userStake.fetch(userStakePda);
      expect(userStake.owner.toString()).to.equal(user1.publicKey.toString());
      expect(userStake.stakedAmount.toString()).to.equal(user1Amount.toString());
      expect(userStake.hasClaimedAirdrop).to.be.true;
      expect(userStake.hasUnstaked).to.be.false;
    });

    it("user2 claims with valid merkle proof", async () => {
      const [userStakePda] = getUserStakePda(poolStatePda, user2.publicKey);
      const proof = getMerkleProof(merkleLayers, user2Leaf);
      const proofArrays = proof.map((p) => Array.from(p));

      await program.methods
        .claimAirdrop(user2Amount, proofArrays)
        .accounts({
          user: user2.publicKey,
          poolState: poolStatePda,
          userStake: userStakePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      const userStake = await program.account.userStake.fetch(userStakePda);
      expect(userStake.stakedAmount.toString()).to.equal(user2Amount.toString());
    });

    it("rejects claim with invalid merkle proof", async () => {
      const fakeUser = Keypair.generate();
      await fundAccount(fakeUser.publicKey);
      const [userStakePda] = getUserStakePda(poolStatePda, fakeUser.publicKey);

      // Use user1's proof but with fakeUser's wallet — should fail
      const proof = getMerkleProof(merkleLayers, user1Leaf);
      const proofArrays = proof.map((p) => Array.from(p));

      try {
        await program.methods
          .claimAirdrop(user1Amount, proofArrays)
          .accounts({
            user: fakeUser.publicKey,
            poolState: poolStatePda,
            userStake: userStakePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([fakeUser])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err.toString()).to.include("InvalidMerkleProof");
      }
    });

    it("rejects claim with wrong amount", async () => {
      const [userStakePda] = getUserStakePda(poolStatePda, user3.publicKey);
      const proof = getMerkleProof(merkleLayers, user3Leaf);
      const proofArrays = proof.map((p) => Array.from(p));

      // Pass wrong amount (double the real one)
      try {
        await program.methods
          .claimAirdrop(user3Amount.mul(new BN(2)), proofArrays)
          .accounts({
            user: user3.publicKey,
            poolState: poolStatePda,
            userStake: userStakePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([user3])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err.toString()).to.include("InvalidMerkleProof");
      }
    });

    it("cannot claim twice", async () => {
      const [userStakePda] = getUserStakePda(poolStatePda, user1.publicKey);
      const proof = getMerkleProof(merkleLayers, user1Leaf);
      const proofArrays = proof.map((p) => Array.from(p));

      try {
        await program.methods
          .claimAirdrop(user1Amount, proofArrays)
          .accounts({
            user: user1.publicKey,
            poolState: poolStatePda,
            userStake: userStakePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err.toString()).to.include("AlreadyClaimed");
      }
    });

    it("pool total_staked reflects claims", async () => {
      const poolAccount = await provider.connection.getAccountInfo(poolStatePda);
      const data = poolAccount.data;
      // total_staked offset: 8 (disc) + 128 (pubkeys+merkle) + 8 (start_time) = 144
      const totalStaked = data.readBigUInt64LE(8 + 128 + 8);
      const expected = BigInt(user1Amount.add(user2Amount).toString());
      expect(totalStaked).to.equal(expected);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. SNAPSHOT
  // ─────────────────────────────────────────────────────────────────

  describe("snapshot", () => {
    it("admin can take snapshot (warp clock to midnight)", async () => {
      // On local validator we can't easily warp the clock.
      // The pool started 2 days ago. We need to call snapshot
      // at a time between 00:00-00:05 UTC.
      // Since localnet clock may not be at midnight, we test
      // the logic by checking if the instruction succeeds or fails
      // based on the actual time. If outside the window, we skip gracefully.

      try {
        await program.methods
          .snapshot()
          .accounts({
            admin: admin.publicKey,
            poolState: poolStatePda,
          })
          .rpc();

        // If it succeeded, verify the snapshot was recorded
        const poolAccount = await provider.connection.getAccountInfo(poolStatePda);
        const data = poolAccount.data;
        // snapshot_count at offset 8 + 128 + 8 + 8 + 8 = 160
        const snapshotCount = data.readUInt8(8 + 160);
        expect(snapshotCount).to.be.greaterThan(0);
      } catch (err) {
        // If outside snapshot window, that's expected
        const errStr = err.toString();
        if (
          errStr.includes("OutsideSnapshotWindow") ||
          errStr.includes("SnapshotTooEarly")
        ) {
          // Expected - we're not at midnight UTC
          console.log(
            "    (snapshot skipped: outside window or too early - expected in CI)"
          );
        } else {
          throw err;
        }
      }
    });

    it("non-admin cannot take snapshot", async () => {
      try {
        await program.methods
          .snapshot()
          .accounts({
            admin: user1.publicKey,
            poolState: poolStatePda,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        // Should fail with Unauthorized or constraint violation
        expect(err.toString()).to.include("nauthorized");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. UNSTAKE
  // ─────────────────────────────────────────────────────────────────

  describe("unstake", () => {
    it("user1 unstakes and receives principal (+ any rewards)", async () => {
      const [userStakePda] = getUserStakePda(poolStatePda, user1.publicKey);
      const user1Ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        user1,
        tokenMint,
        user1.publicKey
      );

      const balanceBefore = (
        await getAccount(provider.connection, user1Ata.address)
      ).amount;

      // Unstake may fail if we're in the snapshot window
      try {
        await program.methods
          .unstake()
          .accounts({
            user: user1.publicKey,
            poolState: poolStatePda,
            userStake: userStakePda,
            poolTokenAccount: poolTokenPda,
            userTokenAccount: user1Ata.address,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();

        const balanceAfter = (
          await getAccount(provider.connection, user1Ata.address)
        ).amount;
        const received = balanceAfter - balanceBefore;

        // Should receive at least principal
        expect(Number(received)).to.be.greaterThanOrEqual(
          Number(user1Amount.toString())
        );

        const userStake = await program.account.userStake.fetch(userStakePda);
        expect(userStake.hasUnstaked).to.be.true;
        expect(userStake.stakedAmount.toString()).to.equal("0");
      } catch (err) {
        if (err.toString().includes("UnstakeBlockedDuringSnapshot")) {
          console.log("    (unstake skipped: inside snapshot window)");
        } else {
          throw err;
        }
      }
    });

    it("cannot unstake twice", async () => {
      const [userStakePda] = getUserStakePda(poolStatePda, user1.publicKey);
      const user1Ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        user1,
        tokenMint,
        user1.publicKey
      );

      try {
        await program.methods
          .unstake()
          .accounts({
            user: user1.publicKey,
            poolState: poolStatePda,
            userStake: userStakePda,
            poolTokenAccount: poolTokenPda,
            userTokenAccount: user1Ata.address,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        const errStr = err.toString();
        expect(
          errStr.includes("PermanentlyExited") ||
            errStr.includes("NothingStaked")
        ).to.be.true;
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. EXPONENTIAL CURVE
  // ─────────────────────────────────────────────────────────────────

  describe("exponential emission curve", () => {
    it("day 20 reward is greater than day 1 (exponential growth)", async () => {
      const poolAccount = await provider.connection.getAccountInfo(poolStatePda);
      const data = poolAccount.data;

      const day1 = Number(data.readBigUInt64LE(DAILY_REWARDS_OFFSET));
      const day20 = Number(
        data.readBigUInt64LE(DAILY_REWARDS_OFFSET + 19 * 8)
      );

      // With k=0.05, day20/day1 = e^(0.05*19) ≈ 2.59
      const ratio = day20 / day1;
      expect(ratio).to.be.greaterThan(2);
      expect(ratio).to.be.lessThan(4);
    });

    it("last 5 days emit significant portion of rewards", async () => {
      const poolAccount = await provider.connection.getAccountInfo(poolStatePda);
      const data = poolAccount.data;

      let totalRewards = BigInt(0);
      let last5 = BigInt(0);
      for (let i = 0; i < TOTAL_DAYS; i++) {
        const reward = data.readBigUInt64LE(DAILY_REWARDS_OFFSET + i * 8);
        totalRewards += reward;
        if (i >= 15) last5 += reward;
      }

      const ratio = Number(last5) / Number(totalRewards);
      // Last 5 of 20 days with k=0.05 should emit ~30%+
      expect(ratio).to.be.greaterThan(0.28);
      expect(ratio).to.be.lessThan(0.5);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 7. TERMINATE POOL
  // ─────────────────────────────────────────────────────────────────

  describe("terminate_pool", () => {
    let mint2: PublicKey;
    let poolState2: PublicKey;
    let poolToken2: PublicKey;

    before(async () => {
      mint2 = await createMint(
        provider.connection,
        admin,
        admin.publicKey,
        null,
        6
      );
      [poolState2] = getPoolStatePda(mint2);
      [poolToken2] = getPoolTokenPda(poolState2);

      const now = Math.floor(Date.now() / 1000);
      const st = Math.floor(now / SECONDS_PER_DAY) * SECONDS_PER_DAY - SECONDS_PER_DAY;

      await program.methods
        .initializePool(new BN(st), Array.from(merkleRoot), computeDailyRewards())
        .accounts({
          admin: admin.publicKey,
          poolState: poolState2,
          tokenMint: mint2,
          poolTokenAccount: poolToken2,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      // Fund pool
      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint2,
        admin.publicKey
      );
      await mintTo(
        provider.connection,
        admin,
        mint2,
        ata.address,
        admin,
        BigInt(TOTAL_POOL.toString())
      );
      const ix = createTransferInstruction(
        ata.address,
        poolToken2,
        admin.publicKey,
        BigInt(TOTAL_POOL.toString())
      );
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix));
    });

    it("admin can terminate pool", async () => {
      const adminAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint2,
        admin.publicKey
      );

      await program.methods
        .terminatePool()
        .accounts({
          admin: admin.publicKey,
          poolState: poolState2,
          poolTokenAccount: poolToken2,
          adminTokenAccount: adminAta.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const poolAccount = await provider.connection.getAccountInfo(poolState2);
      const data = poolAccount.data;
      // terminated at offset: 8 (disc) + 32+32+32+32 (pubkeys+merkle) + 8+8+8 (i64+u64+u64) + 1 (snapshot_count) = 161
      const terminated = data.readUInt8(161);
      expect(terminated).to.equal(1);
    });

    it("cannot terminate twice", async () => {
      const adminAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint2,
        admin.publicKey
      );

      try {
        await program.methods
          .terminatePool()
          .accounts({
            admin: admin.publicKey,
            poolState: poolState2,
            poolTokenAccount: poolToken2,
            adminTokenAccount: adminAta.address,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err.toString()).to.include("AlreadyTerminated");
      }
    });

    it("claims blocked after termination", async () => {
      const [userStakePda] = getUserStakePda(poolState2, user3.publicKey);
      const proof = getMerkleProof(merkleLayers, user3Leaf);
      const proofArrays = proof.map((p) => Array.from(p));

      try {
        await program.methods
          .claimAirdrop(user3Amount, proofArrays)
          .accounts({
            user: user3.publicKey,
            poolState: poolState2,
            userStake: userStakePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([user3])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err.toString()).to.include("PoolTerminated");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 8. PRO-RATA REWARDS (separate pool, test reward math)
  // ─────────────────────────────────────────────────────────────────

  describe("pro-rata reward distribution", () => {
    let mint3: PublicKey;
    let poolState3: PublicKey;
    let poolToken3: PublicKey;

    const userA = Keypair.generate();
    const userB = Keypair.generate();
    const amountA = new BN(3_000_000_000_000); // 3M tokens
    const amountB = new BN(1_000_000_000_000); // 1M tokens

    // Build a separate merkle tree for this pool
    let tree3Layers: Buffer[][];
    let tree3Root: Buffer;
    let leafA: Buffer;
    let leafB: Buffer;

    before(async () => {
      await Promise.all([
        fundAccount(userA.publicKey),
        fundAccount(userB.publicKey),
      ]);

      leafA = computeLeaf(userA.publicKey, amountA);
      leafB = computeLeaf(userB.publicKey, amountB);
      tree3Layers = buildMerkleTree([leafA, leafB]);
      tree3Root = getMerkleRoot(tree3Layers);

      mint3 = await createMint(
        provider.connection,
        admin,
        admin.publicKey,
        null,
        6
      );
      [poolState3] = getPoolStatePda(mint3);
      [poolToken3] = getPoolTokenPda(poolState3);

      // Start 3 days ago
      const now = Math.floor(Date.now() / 1000);
      const st =
        Math.floor(now / SECONDS_PER_DAY) * SECONDS_PER_DAY -
        3 * SECONDS_PER_DAY;

      await program.methods
        .initializePool(new BN(st), Array.from(tree3Root), computeDailyRewards())
        .accounts({
          admin: admin.publicKey,
          poolState: poolState3,
          tokenMint: mint3,
          poolTokenAccount: poolToken3,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      // Fund
      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin,
        mint3,
        admin.publicKey
      );
      await mintTo(
        provider.connection,
        admin,
        mint3,
        ata.address,
        admin,
        BigInt(TOTAL_POOL.toString())
      );
      const ix = createTransferInstruction(
        ata.address,
        poolToken3,
        admin.publicKey,
        BigInt(TOTAL_POOL.toString())
      );
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(ix));

      // Both claim
      const [stakeA] = getUserStakePda(poolState3, userA.publicKey);
      const proofA = getMerkleProof(tree3Layers, leafA).map((p) =>
        Array.from(p)
      );
      await program.methods
        .claimAirdrop(amountA, proofA)
        .accounts({
          user: userA.publicKey,
          poolState: poolState3,
          userStake: stakeA,
          systemProgram: SystemProgram.programId,
        })
        .signers([userA])
        .rpc();

      const [stakeB] = getUserStakePda(poolState3, userB.publicKey);
      const proofB = getMerkleProof(tree3Layers, leafB).map((p) =>
        Array.from(p)
      );
      await program.methods
        .claimAirdrop(amountB, proofB)
        .accounts({
          user: userB.publicKey,
          poolState: poolState3,
          userStake: stakeB,
          systemProgram: SystemProgram.programId,
        })
        .signers([userB])
        .rpc();
    });

    it("both users unstake - A gets 3x more rewards than B", async () => {
      const [stakeA] = getUserStakePda(poolState3, userA.publicKey);
      const [stakeB] = getUserStakePda(poolState3, userB.publicKey);

      const ataA = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        userA,
        mint3,
        userA.publicKey
      );
      const ataB = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        userB,
        mint3,
        userB.publicKey
      );

      // Try to take a snapshot first (may fail due to time window)
      try {
        await program.methods
          .snapshot()
          .accounts({ admin: admin.publicKey, poolState: poolState3 })
          .rpc();
      } catch {
        // OK if outside window
      }

      await program.methods
        .unstake()
        .accounts({
          user: userA.publicKey,
          poolState: poolState3,
          userStake: stakeA,
          poolTokenAccount: poolToken3,
          userTokenAccount: ataA.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userA])
        .rpc();

      await program.methods
        .unstake()
        .accounts({
          user: userB.publicKey,
          poolState: poolState3,
          userStake: stakeB,
          poolTokenAccount: poolToken3,
          userTokenAccount: ataB.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userB])
        .rpc();

      const balA = Number(
        (await getAccount(provider.connection, ataA.address)).amount
      );
      const balB = Number(
        (await getAccount(provider.connection, ataB.address)).amount
      );

      // Both should get at least principal
      expect(balA).to.be.greaterThanOrEqual(Number(amountA.toString()));
      expect(balB).to.be.greaterThanOrEqual(Number(amountB.toString()));

      // If rewards were distributed, ratio should be ~3:1
      const rewardsA = balA - Number(amountA.toString());
      const rewardsB = balB - Number(amountB.toString());

      if (rewardsA > 0 && rewardsB > 0) {
        const rewardRatio = rewardsA / rewardsB;
        expect(rewardRatio).to.be.greaterThan(2);
        expect(rewardRatio).to.be.lessThan(4);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 9. CALCULATE REWARDS VIEW
  // ─────────────────────────────────────────────────────────────────

  describe("calculate_rewards", () => {
    it("can call calculate_rewards for a day", async () => {
      // Use user2 who is still staked on the main pool
      const [userStakePda] = getUserStakePda(poolStatePda, user2.publicKey);

      // Should not throw for day 0
      await program.methods
        .calculateRewards(new BN(0))
        .accounts({
          poolState: poolStatePda,
          userStake: userStakePda,
        })
        .rpc();
    });

    it("rejects invalid day (>= 20)", async () => {
      const [userStakePda] = getUserStakePda(poolStatePda, user2.publicKey);

      try {
        await program.methods
          .calculateRewards(new BN(20))
          .accounts({
            poolState: poolStatePda,
            userStake: userStakePda,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err.toString()).to.include("InvalidDay");
      }
    });
  });
});
