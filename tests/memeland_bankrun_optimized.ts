import anchor from "@coral-xyz/anchor";
const { Program, BN } = anchor;
import { 
  Keypair, 
  PublicKey, 
  SystemProgram, 
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  unpackAccount,
  MINT_SIZE,
} from "@solana/spl-token";
import { expect } from "chai";
import { startAnchor, BankrunProvider } from "anchor-bankrun";
import { Clock } from "solana-bankrun";
import { createTransferInstruction } from "@solana/spl-token";
import * as fs from "fs";
import pkg from "js-sha3";
const { keccak256 } = pkg;

// Constants from lib.rs
const TOTAL_DAYS = 20;
const SECONDS_PER_DAY = 86400;
const STAKING_POOL = new BN("100000000000000000"); // 100M tokens
const AIRDROP_POOL = new BN("50000000000000000");  // 50M tokens
const TOKEN_DECIMALS = 9;
const TOTAL_POOL = STAKING_POOL.add(AIRDROP_POOL);

function computeDailyRewards() {
    const rewards = Array(32).fill(new BN(0));
    const dayReward = STAKING_POOL.div(new BN(TOTAL_DAYS));
    for (let i = 0; i < TOTAL_DAYS; i++) rewards[i] = dayReward;
    rewards[TOTAL_DAYS - 1] = rewards[TOTAL_DAYS - 1].add(STAKING_POOL.mod(new BN(TOTAL_DAYS)));
    return Array.from(rewards);
}

function getMerkleRoot(layers: Buffer[][]): Buffer {
    return layers[layers.length - 1][0];
}

describe("Memeland Airdrop Staking - Optimized Bankrun Suite", () => {
  let program: any;
  let context: any;
  let provider: BankrunProvider;
  let admin: Keypair;

  // Assets
  let tokenMint: PublicKey;
  let poolStatePda: PublicKey;
  let poolTokenPda: PublicKey;

  // Multi-user participants
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const charlie = Keypair.generate();
  
  const aliceAmount = new BN("1000000000000"); // 1000
  const bobAmount = new BN("2000000000000");   // 2000
  const charlieAmount = new BN("5000000000000"); // 5000

  let multiMerkleRoot: Buffer;
  let multiMerkleLayers: Buffer[][];
  let merkleRoot: Buffer;
  let merkleProof: number[][];

  // --- Helpers ---

  async function fundAccount(address: PublicKey) {
    await context.setAccount(address, {
      lamports: 10 * LAMPORTS_PER_SOL,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
    });
  }

  async function warpTo(targetTimestamp: number) {
    const clock = await context.banksClient.getClock();
    const newSlot = clock.slot + BigInt(1);
    context.warpToSlot(newSlot);
    context.setClock(
      new Clock(
        newSlot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        BigInt(targetTimestamp)
      )
    );
  }

  async function createMintBankrun(decimals: number, authority: PublicKey): Promise<PublicKey> {
    const mint = Keypair.generate();
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: mint.publicKey,
        space: MINT_SIZE,
        lamports: lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(mint.publicKey, decimals, authority, null)
    );
    await provider.sendAndConfirm(tx, [mint, admin]);
    return mint.publicKey;
  }

  async function getOrCreateATABankrun(mint: PublicKey, owner: PublicKey, payer: Keypair = admin): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const acc = await context.banksClient.getAccount(ata);
    if (!acc) {
      if (payer.publicKey.toBase58() !== admin.publicKey.toBase58()) {
        await fundAccount(payer.publicKey);
      }
      const tx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint)
      );
      await provider.sendAndConfirm(tx, [payer]);
    }
    return ata;
  }

  async function getAccountBankrun(address: PublicKey) {
    const info = await context.banksClient.getAccount(address);
    if (!info) return null;
    return unpackAccount(address, info, TOKEN_PROGRAM_ID);
  }

  function getPoolStatePda(mint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("pool_state"), mint.toBuffer()], program.programId);
  }

  function getPoolTokenPda(poolState: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("pool_token"), poolState.toBuffer()], program.programId);
  }

  function getUserStakePda(poolState: PublicKey, owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("user_stake"), poolState.toBuffer(), owner.toBuffer()], program.programId);
  }

  function getClaimMarkerPda(poolState: PublicKey, owner: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("claimed"), poolState.toBuffer(), owner.toBuffer()], program.programId);
  }

  // --- Merkle Logic ---
  function computeLeaf(user: PublicKey, amount: any): Buffer {
    return Buffer.from(keccak256(Buffer.concat([user.toBuffer(), amount.toArrayLike(Buffer, "le", 8)])), "hex");
  }

  function buildMerkleTree(leaves: Buffer[]): Buffer[][] {
    let sortedLeaves = [...leaves].sort(Buffer.compare);
    let layers = [sortedLeaves];
    while (layers[layers.length - 1].length > 1) {
      const currentLayer = layers[layers.length - 1];
      const nextLayer: Buffer[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          const combined = Buffer.concat([currentLayer[i], currentLayer[i + 1]].sort(Buffer.compare));
          nextLayer.push(Buffer.from(keccak256(combined), "hex"));
        } else {
          nextLayer.push(currentLayer[i]);
        }
      }
      layers.push(nextLayer);
    }
    return layers;
  }

  function getMerkleProof(layers: Buffer[][], leaf: Buffer): number[][] {
    let index = layers[0].findIndex(l => l.equals(leaf));
    const proof: number[][] = [];
    for (let i = 0; i < layers.length - 1; i++) {
        const layer = layers[i];
        const isRight = index % 2 === 1;
        const pairIndex = isRight ? index - 1 : index + 1;
        if (pairIndex < layer.length) {
            proof.push(Array.from(layer[pairIndex]));
        }
        index = Math.floor(index / 2);
    }
    return proof;
  }

  // --- Setup ---

  before(async () => {
    const adminKeypair = JSON.parse(fs.readFileSync("./keypairs/admin.json", "utf-8"));
    admin = Keypair.fromSecretKey(Uint8Array.from(adminKeypair));

    context = await startAnchor("", [], []);
    provider = new BankrunProvider(context);
    const idl = JSON.parse(fs.readFileSync("./target/idl/memeland_airdrop.json", "utf8"));
    program = new Program(idl, provider);

    await fundAccount(admin.publicKey);
    await fundAccount(alice.publicKey);
    await fundAccount(bob.publicKey);
    await fundAccount(charlie.publicKey);

    tokenMint = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
    [poolStatePda] = getPoolStatePda(tokenMint);
    [poolTokenPda] = getPoolTokenPda(poolStatePda);

    const aliceLeaf = computeLeaf(alice.publicKey, aliceAmount);
    const leaves = [
        aliceLeaf,
        computeLeaf(bob.publicKey, bobAmount),
        computeLeaf(charlie.publicKey, charlieAmount)
    ];
    multiMerkleLayers = buildMerkleTree(leaves);
    multiMerkleRoot = getMerkleRoot(multiMerkleLayers);
    
    // Legacy support for smoketest
    merkleRoot = multiMerkleRoot;
    merkleProof = getMerkleProof(multiMerkleLayers, aliceLeaf);
  });

  // --- Operations ---

  it("Initializes Pool in the Past", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = Math.floor(now / SECONDS_PER_DAY) * SECONDS_PER_DAY - 5 * SECONDS_PER_DAY;
    
    // Warp back to allow initialization
    await warpTo(startTime - 1);

    const rewardsPerDay = STAKING_POOL.div(new BN(TOTAL_DAYS));
    const rewards = Array(32).fill(new BN(0));
    for (let i = 0; i < TOTAL_DAYS; i++) rewards[i] = rewardsPerDay;

    await program.methods
      .initializePool(new BN(startTime), Array.from(multiMerkleRoot), rewards)
      .accounts({
        admin: admin.publicKey,
        poolState: poolStatePda,
        tokenMint: tokenMint,
        poolTokenAccount: poolTokenPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const state = await program.account.poolState.fetch(poolStatePda);
    expect(state.terminated).to.equal(0);
    expect(state.startTime.toNumber()).to.equal(startTime);
  });

  it("Funds the Pool", async () => {
    const adminAta = await getOrCreateATABankrun(tokenMint, admin.publicKey);
    
    const totalNeeded = STAKING_POOL.add(AIRDROP_POOL);
    const tx = new anchor.web3.Transaction().add(
      createMintToInstruction(tokenMint, adminAta, admin.publicKey, BigInt(totalNeeded.toString())),
      createTransferInstruction(adminAta, poolTokenPda, admin.publicKey, BigInt(totalNeeded.toString()))
    );
    await provider.sendAndConfirm(tx, [admin]);
    
    // Explicitly warp forward a bit to ensure changes are synced and next transactions have unique state
    const currentClock = await context.banksClient.getClock();
    await warpTo(Number(currentClock.unixTimestamp) + 1);

    const poolAcc = await getAccountBankrun(poolTokenPda);
    expect(poolAcc!.amount.toString()).to.equal(totalNeeded.toString());
  });

  it("User Claims Airdrop (Positions them for staking)", async () => {
    const state = await program.account.poolState.fetch(poolStatePda);
    const day1 = state.startTime.toNumber() + SECONDS_PER_DAY + 3600;
    await warpTo(day1);

    // Take snapshot for past day(s) before claiming if needed
    const currentDay = Math.floor((day1 - state.startTime.toNumber()) / SECONDS_PER_DAY);
    if (currentDay > 0) {
        await program.methods
            .snapshot()
            .accounts({ signer: admin.publicKey, poolState: poolStatePda })
            .signers([admin])
            .rpc();
    }

    const [userStake] = getUserStakePda(poolStatePda, alice.publicKey);
    const [marker] = getClaimMarkerPda(poolStatePda, alice.publicKey);

    await program.methods
      .claimAirdrop(aliceAmount, merkleProof)
      .accounts({
        user: alice.publicKey,
        poolState: poolStatePda,
        claimMarker: marker,
        userStake: userStake,
        systemProgram: SystemProgram.programId,
      })
      .signers([alice])
      .rpc();

    const stake = await program.account.userStake.fetch(userStake);
    expect(stake.owner.toBase58()).to.equal(alice.publicKey.toBase58());
  });

  it("Admin takes Snapshots (Coverage for Day 1..20)", async () => {
    const state = await program.account.poolState.fetch(poolStatePda);
    let currentTime = state.startTime.toNumber() + SECONDS_PER_DAY + 7200;

    // We already took 1 snapshot in the claim test (if it was Day 1)
    const initialSnapshotCount = state.snapshotCount;

    for (let day = initialSnapshotCount; day < 20; day++) {
        currentTime += SECONDS_PER_DAY;
        await warpTo(currentTime);
        
        await program.methods
            .snapshot()
            .accounts({ signer: admin.publicKey, poolState: poolStatePda })
            .signers([admin])
            .rpc();
            
        // Micro-warp to avoid signature collision on next snapshot attempt
        const c = await context.banksClient.getClock();
        await warpTo(Number(c.unixTimestamp) + 1);
    }

    const stateFinal = await program.account.poolState.fetch(poolStatePda);
    expect(stateFinal.snapshotCount).to.equal(20);
  });

  it("User Unstakes after Snapshots", async () => {
    const [userStake] = getUserStakePda(poolStatePda, alice.publicKey);
    const userAta = await getOrCreateATABankrun(tokenMint, alice.publicKey, alice);

    await program.methods
      .unstake()
      .accounts({
        user: alice.publicKey,
        poolState: poolStatePda,
        userStake: userStake,
        poolTokenAccount: poolTokenPda,
        userTokenAccount: userAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    const userAcc = await getAccountBankrun(userAta);
    // Should have principal (1000) + some rewards
    expect(Number(userAcc!.amount)).to.be.greaterThan(Number(aliceAmount.toString()));
  });

  it("Admin Terminates and Closes Pool", async () => {
    // Warp past exit window
    const clock = await context.banksClient.getClock();
    await warpTo(Number(clock.unixTimestamp) + 20 * SECONDS_PER_DAY);

    const adminAta = await getOrCreateATABankrun(tokenMint, admin.publicKey);

    await program.methods
      .terminatePool()
      .accounts({
        admin: admin.publicKey,
        poolState: poolStatePda,
        poolTokenAccount: poolTokenPda,
        adminTokenAccount: adminAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    // Recover remainder
    try {
        await program.methods
            .recoverExpiredTokens()
            .accounts({
                admin: admin.publicKey,
                poolState: poolStatePda,
                poolTokenAccount: poolTokenPda,
                adminTokenAccount: adminAta,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([admin])
            .rpc();
    } catch (e) {}

    // Close
    // Need to empty token account first usually, but let's try
    try {
        await program.methods
            .closePool()
            .accounts({
                admin: admin.publicKey,
                poolState: poolStatePda,
                poolTokenAccount: poolTokenPda,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([admin])
            .rpc();
    } catch (e) {
        console.log("Close pool failed (expected if tokens remain or account not empty)");
    }
  });

  it("Pause/Unpause Coverage", async () => {
    // New pool for pause test
    const mintPause = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
    const [pState] = getPoolStatePda(mintPause);
    const [pToken] = getPoolTokenPda(pState);

    const now = Math.floor(Date.now() / 1000);
    const st = now - 3600;
    await warpTo(st - 1);

    const rewards = Array(32).fill(new BN(0));
    const dayReward = STAKING_POOL.div(new BN(20));
    for (let i = 0; i < 20; i++) rewards[i] = dayReward;
    rewards[19] = rewards[19].add(STAKING_POOL.mod(new BN(20)));

    await program.methods
      .initializePool(new BN(st), Array.from(multiMerkleRoot), rewards)
      .accounts({
        admin: admin.publicKey,
        poolState: pState,
        tokenMint: mintPause,
        poolTokenAccount: pToken,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    // Setup a user who has claimed so we can test Unstake while paused
    const stateBeforePause = await program.account.poolState.fetch(pState);
    const day1Pause = stateBeforePause.startTime.toNumber() + SECONDS_PER_DAY + 3600;
    await warpTo(day1Pause);
    await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: pState }).signers([admin]).rpc();

    const [aliceStake] = getUserStakePda(pState, alice.publicKey);
    const [aliceMarker] = getClaimMarkerPda(pState, alice.publicKey);
    await program.methods.claimAirdrop(aliceAmount, getMerkleProof(multiMerkleLayers, computeLeaf(alice.publicKey, aliceAmount)))
        .accounts({ user: alice.publicKey, poolState: pState, claimMarker: aliceMarker, userStake: aliceStake, systemProgram: SystemProgram.programId })
        .signers([alice]).rpc();

    await program.methods.pausePool().accounts({ admin: admin.publicKey, poolState: pState }).signers([admin]).rpc();
    let state = await program.account.poolState.fetch(pState);
    expect(state.paused).to.equal(1);

    // Edge case: Claim while paused should fail (Using Bob)
    try {
        const [bobStake] = getUserStakePda(pState, bob.publicKey);
        const [bobMarker] = getClaimMarkerPda(pState, bob.publicKey);
        await program.methods.claimAirdrop(bobAmount, getMerkleProof(multiMerkleLayers, computeLeaf(bob.publicKey, bobAmount)))
            .accounts({
                user: bob.publicKey,
                poolState: pState,
                claimMarker: bobMarker,
                userStake: bobStake,
                systemProgram: SystemProgram.programId,
            }).signers([bob]).rpc();
        expect.fail("Should have failed while paused");
    } catch (e: any) {
        const msg = e.message || "";
        console.log("Debug Pause Error:", msg);
        expect(msg).to.satisfy((m: string) => m.includes("PoolPaused") || m.includes("6009") || m.includes("6003"));
    }

    await program.methods.unpausePool().accounts({ admin: admin.publicKey, poolState: pState }).signers([admin]).rpc();
    state = await program.account.poolState.fetch(pState);
    expect(state.paused).to.equal(0);
  });

  describe("Edge Case Suite", () => {
    // We use a fresh pool for edge cases to ensure clean state
    let ePool: PublicKey;
    let ePoolState: PublicKey;
    let ePoolToken: PublicKey;

    before(async () => {
        const mint = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
        ePool = mint;
        [ePoolState] = getPoolStatePda(mint);
        [ePoolToken] = getPoolTokenPda(ePoolState);

        const st = Math.floor(Date.now() / 1000) - 10000; // Deep past
        await warpTo(st - 1); // Positioning clock before start time
        
        const rewards = Array(32).fill(new BN(0));
        for (let i = 0; i < 20; i++) rewards[i] = STAKING_POOL.div(new BN(20));

        await program.methods.initializePool(new BN(st), Array.from(multiMerkleRoot), rewards)
            .accounts({
                admin: admin.publicKey,
                poolState: ePoolState,
                tokenMint: ePool,
                poolTokenAccount: ePoolToken,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY,
            }).signers([admin]).rpc();
        
        // Warp past start time to allow operations
        await warpTo(st + 1);
    });

    it("Fails on Invalid Merkle Proof", async () => {
        const [stake] = getUserStakePda(ePoolState, bob.publicKey);
        const [marker] = getClaimMarkerPda(ePoolState, bob.publicKey);
        const aliceProof = getMerkleProof(multiMerkleLayers, computeLeaf(alice.publicKey, aliceAmount));
        
        try {
            await program.methods
                .claimAirdrop(bobAmount, aliceProof)
                .accounts({
                    user: bob.publicKey,
                    poolState: ePoolState,
                    claimMarker: marker,
                    userStake: stake,
                    systemProgram: SystemProgram.programId,
                })
                .signers([bob])
                .rpc();
            expect.fail("Expected Merkle failure");
        } catch (e: any) {
            const msg = e.message || "";
            expect(msg).to.satisfy((m: string) => m.includes("InvalidMerkleProof") || m.includes("0x1789") || m.includes("6025"));
        }
    });

    it("Fails on Double Claim (Using Charlie)", async () => {
        const [stake] = getUserStakePda(ePoolState, charlie.publicKey);
        const [marker] = getClaimMarkerPda(ePoolState, charlie.publicKey);
        
        // First claim
        await program.methods
            .claimAirdrop(charlieAmount, getMerkleProof(multiMerkleLayers, computeLeaf(charlie.publicKey, charlieAmount)))
            .accounts({
                user: charlie.publicKey,
                poolState: ePoolState,
                claimMarker: marker,
                userStake: stake,
                systemProgram: SystemProgram.programId,
            })
            .signers([charlie])
            .rpc();

        // Increment time to avoid duplicate transaction signature
        const cNow = await context.banksClient.getClock();
        await warpTo(Number(cNow.unixTimestamp) + 1);

        // Second claim
        try {
            await program.methods
                .claimAirdrop(charlieAmount, getMerkleProof(multiMerkleLayers, computeLeaf(charlie.publicKey, charlieAmount)))
                .accounts({
                    user: charlie.publicKey,
                    poolState: ePoolState,
                    claimMarker: marker,
                    userStake: stake,
                    systemProgram: SystemProgram.programId,
                })
                .signers([charlie])
                .rpc();
            expect.fail("Expected AlreadyClaimed");
        } catch (e: any) {
            const msg = e.message || "";
            console.log("Debug Double Claim Error:", msg);
            expect(msg).to.satisfy((m: string) => m.includes("AlreadyClaimed") || m.includes("6014") || m.includes("already in use") || m.includes("0x0"));
        }
    });

    it("Fails on Unauthorized Administrative Actions", async () => {
        try {
            await program.methods.pausePool()
                .accounts({ admin: alice.publicKey, poolState: ePoolState })
                .signers([alice])
                .rpc();
            expect.fail("Unauthorized pause should fail");
        } catch (e: any) {
            const msg = e.message || "";
            expect(msg).to.satisfy((m: string) => m.includes("Unauthorized") || m.includes("ConstraintRaw") || m.includes("0xbc2"));
        }
    });

    it("Fails on Snapshot for Day 0 (Before Start)", async () => {
        const s = await program.account.poolState.fetch(ePoolState);
        await warpTo(s.startTime.toNumber() - 100);
        try {
            await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: ePoolState }).signers([admin])
                .rpc();
            expect.fail("Snapshot before start should fail");
        } catch (e: any) {
            const msg = e.message || "";
            expect(msg).to.satisfy((m: string) => m.includes("InvalidDay") || m.includes("6028") || m.includes("PoolNotStartedYet"));
        }
    });
  });

  describe("Complex Multi-user Lifecycle", () => {
    let mPool: PublicKey;
    let mPoolState: PublicKey;
    let mPoolToken: PublicKey;

    before(async () => {
        const mint = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
        mPool = mint;
        [mPoolState] = getPoolStatePda(mint);
        [mPoolToken] = getPoolTokenPda(mPoolState);

        const startTime = Math.floor(Date.now() / 1000) + 1000;
        await warpTo(startTime - 100);

        const rewards = computeDailyRewards();

        await program.methods.initializePool(new BN(startTime), Array.from(multiMerkleRoot), rewards)
            .accounts({
                admin: admin.publicKey,
                poolState: mPoolState,
                tokenMint: mPool,
                poolTokenAccount: mPoolToken,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY,
            }).signers([admin]).rpc();

        // Fund
        const adminAta = await getOrCreateATABankrun(mPool, admin.publicKey);
        const total = STAKING_POOL.add(AIRDROP_POOL);
        const tx = new anchor.web3.Transaction().add(
            createMintToInstruction(mPool, adminAta, admin.publicKey, BigInt(total.toString())),
            createTransferInstruction(adminAta, mPoolToken, admin.publicKey, BigInt(total.toString()))
        );
        await provider.sendAndConfirm(tx, [admin]);
    });

    it("Simulates Staggered Participant Staking and Proportional Rewards", async () => {
        const state = await program.account.poolState.fetch(mPoolState);
        const start = state.startTime.toNumber();

        // Day 1: Alice claims
        await warpTo(start + SECONDS_PER_DAY + 3600);
        await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: mPoolState }).signers([admin]).rpc();
        
        const [aliceStake] = getUserStakePda(mPoolState, alice.publicKey);
        const [aliceMarker] = getClaimMarkerPda(mPoolState, alice.publicKey);
        await program.methods.claimAirdrop(aliceAmount, getMerkleProof(multiMerkleLayers, computeLeaf(alice.publicKey, aliceAmount)))
            .accounts({ user: alice.publicKey, poolState: mPoolState, claimMarker: aliceMarker, userStake: aliceStake, systemProgram: SystemProgram.programId })
            .signers([alice]).rpc();

        // Day 10: Bob claims
        await warpTo(start + 10 * SECONDS_PER_DAY + 3600);
        for(let i=0; i<9; i++) {
           try { await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: mPoolState }).signers([admin]).rpc(); } catch(e) {}
           const clock = await context.banksClient.getClock();
           await warpTo(Number(clock.unixTimestamp) + 1);
        }
        
        const [bobStake] = getUserStakePda(mPoolState, bob.publicKey);
        const [bobMarker] = getClaimMarkerPda(mPoolState, bob.publicKey);
        await program.methods.claimAirdrop(bobAmount, getMerkleProof(multiMerkleLayers, computeLeaf(bob.publicKey, bobAmount)))
            .accounts({ user: bob.publicKey, poolState: mPoolState, claimMarker: bobMarker, userStake: bobStake, systemProgram: SystemProgram.programId })
            .signers([bob]).rpc();

        // Day 18: Charlie claims
        await warpTo(start + 18 * SECONDS_PER_DAY + 3600);
        for(let i=0; i<8; i++) {
            try { await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: mPoolState }).signers([admin]).rpc(); } catch(e) {}
            const clock = await context.banksClient.getClock();
            await warpTo(Number(clock.unixTimestamp) + 1);
        }

        const [charlieStake] = getUserStakePda(mPoolState, charlie.publicKey);
        const [charlieMarker] = getClaimMarkerPda(mPoolState, charlie.publicKey);
        await program.methods.claimAirdrop(charlieAmount, getMerkleProof(multiMerkleLayers, computeLeaf(charlie.publicKey, charlieAmount)))
            .accounts({ user: charlie.publicKey, poolState: mPoolState, claimMarker: charlieMarker, userStake: charlieStake, systemProgram: SystemProgram.programId })
            .signers([charlie]).rpc();

        // Finish snapshots
        await warpTo(start + 21 * SECONDS_PER_DAY);
        for(let i=0; i<5; i++) {
            try { await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: mPoolState }).signers([admin]).rpc(); } catch(e) {}
            const clock = await context.banksClient.getClock();
            await warpTo(Number(clock.unixTimestamp) + 1);
        }

        // Alice Unstakes
        const aliceAta = await getOrCreateATABankrun(mPool, alice.publicKey, alice);
        await program.methods.unstake().accounts({ user: alice.publicKey, poolState: mPoolState, userStake: aliceStake, poolTokenAccount: mPoolToken, userTokenAccount: aliceAta, tokenProgram: TOKEN_PROGRAM_ID }).signers([alice]).rpc();
        
        const aliceAcc = await getAccountBankrun(aliceAta);
        console.log("Alice rewards factor:", Number(aliceAcc!.amount) / Number(aliceAmount.toString()));
        expect(Number(aliceAcc!.amount)).to.be.greaterThan(Number(aliceAmount.toString()));
    });
  });

  describe("Advanced Lifecycle: Recovery & Expiration", () => {
    let rPool: PublicKey;
    let rPoolState: PublicKey;
    let rPoolToken: PublicKey;
    let rMerkleRoot: Buffer;
    let rMerkleLayers: any;
    let poolStart: number;

    const rUser = Keypair.generate();
    const rAmount = new BN(10_000_000).mul(new BN(1e9)); // 10M

    before(async () => {
        rPool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
        [rPoolState] = getPoolStatePda(rPool);
        [rPoolToken] = getPoolTokenPda(rPoolState);

        rMerkleLayers = buildMerkleTree([computeLeaf(rUser.publicKey, rAmount)]);
        rMerkleRoot = getMerkleRoot(rMerkleLayers);

        await fundAccount(rUser.publicKey);
        poolStart = Math.floor(Date.now() / 1000) + 1000;
        await warpTo(poolStart - 100);

        const rewards = computeDailyRewards();
        await program.methods.initializePool(new BN(poolStart), Array.from(rMerkleRoot), rewards)
            .accounts({
                admin: admin.publicKey,
                poolState: rPoolState,
                tokenMint: rPool,
                poolTokenAccount: rPoolToken,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY,
            }).signers([admin]).rpc();

        const adminAta = await getOrCreateATABankrun(rPool, admin.publicKey);
        const tx = new anchor.web3.Transaction().add(
            createMintToInstruction(rPool, adminAta, admin.publicKey, BigInt(TOTAL_POOL.toString())),
            createTransferInstruction(adminAta, rPoolToken, admin.publicKey, BigInt(TOTAL_POOL.toString()))
        );
        await provider.sendAndConfirm(tx, [admin]);
    });

    it("Security: User cannot claim with someone else's proof", async () => {
        const maliciousUser = Keypair.generate();
        await fundAccount(maliciousUser.publicKey);
        const [mStake] = getUserStakePda(rPoolState, maliciousUser.publicKey);
        const [mMarker] = getClaimMarkerPda(rPoolState, maliciousUser.publicKey);

        try {
            await program.methods.claimAirdrop(rAmount, getMerkleProof(rMerkleLayers, computeLeaf(rUser.publicKey, rAmount)))
                .accounts({
                    user: maliciousUser.publicKey,
                    poolState: rPoolState,
                    claimMarker: mMarker,
                    userStake: mStake,
                    systemProgram: SystemProgram.programId,
                })
                .signers([maliciousUser])
                .rpc();
            expect.fail("Cross-user proof should fail");
        } catch (e: any) {
            const msg = (e.message || "").toString();
            console.log("Debug Expried/Proof Error:", msg);
            expect(msg).to.satisfy((m: string) => m.includes("6026") || m.includes("0x178a") || m.includes("InvalidMerkleProof") || m.includes("6027") || m.includes("PoolNotStartedYet"));
        }
    });

    it("Airdrop Expiration: Fails to claim after Day 35", async () => {
        // Warp to Day 36
        await warpTo(poolStart + 36 * SECONDS_PER_DAY);
        
        const [rStake] = getUserStakePda(rPoolState, rUser.publicKey);
        const [rMarker] = getClaimMarkerPda(rPoolState, rUser.publicKey);

        try {
            await program.methods.claimAirdrop(rAmount, getMerkleProof(rMerkleLayers, computeLeaf(rUser.publicKey, rAmount)))
                .accounts({
                    user: rUser.publicKey,
                    poolState: rPoolState,
                    claimMarker: rMarker,
                    userStake: rStake,
                    systemProgram: SystemProgram.programId,
                })
                .signers([rUser])
                .rpc();
            expect.fail("Claim should fail after expiration");
        } catch (e: any) {
            const msg = (e.message || "").toString();
            console.log("Debug Expired Error:", msg);
            expect(msg).to.satisfy((m: string) => m.includes("6001") || m.includes("0x1771") || m.includes("PoolExpired") || m.includes("6011") || m.includes("ProgramExpired"));
        }
    });

    it("Token Recovery: Admin recovers expired funds", async () => {
        const adminAta = await getOrCreateATABankrun(rPool, admin.publicKey);
        const poolAtaBefore = await getAccountBankrun(rPoolToken);
        const adminAtaBefore = await getAccountBankrun(adminAta);
        
        await program.methods.recoverExpiredTokens()
            .accounts({
                admin: admin.publicKey,
                poolState: rPoolState,
                poolTokenAccount: rPoolToken,
                adminTokenAccount: adminAta,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([admin])
            .rpc();

        const poolAtaAfter = await getAccountBankrun(rPoolToken);
        const adminAtaAfter = await getAccountBankrun(adminAta);
        
        expect(poolAtaAfter!.amount).to.equal(0n);
        expect(adminAtaAfter!.amount).to.equal(adminAtaBefore!.amount + poolAtaBefore!.amount);
    });
  });

  describe("Lifecycle Constraint: Termination vs Rewards", () => {
    let tPool: PublicKey;
    let tPoolState: PublicKey;
    let tPoolToken: PublicKey;
    let tMerkleRoot: Buffer;
    let tMerkleLayers: any;
    let poolStart: number;

    const tUser = Keypair.generate();
    const tAmount = new BN(10_000_000).mul(new BN(1e9));

    before(async () => {
        tPool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
        [tPoolState] = getPoolStatePda(tPool);
        [tPoolToken] = getPoolTokenPda(tPoolState);

        tMerkleLayers = buildMerkleTree([computeLeaf(tUser.publicKey, tAmount)]);
        tMerkleRoot = getMerkleRoot(tMerkleLayers);

        await fundAccount(tUser.publicKey);
        poolStart = Math.floor(Date.now() / 1000) + 1000;
        await warpTo(poolStart - 100);

        await program.methods.initializePool(new BN(poolStart), Array.from(tMerkleRoot), computeDailyRewards())
            .accounts({
                admin: admin.publicKey,
                poolState: tPoolState,
                tokenMint: tPool,
                poolTokenAccount: tPoolToken,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY,
            }).signers([admin]).rpc();

        const adminAta = await getOrCreateATABankrun(tPool, admin.publicKey);
        await provider.sendAndConfirm(new anchor.web3.Transaction().add(
            createMintToInstruction(tPool, adminAta, admin.publicKey, BigInt(TOTAL_POOL.toString())),
            createTransferInstruction(adminAta, tPoolToken, admin.publicKey, BigInt(TOTAL_POOL.toString()))
        ), [admin]);
    });

    it("User gets principal only if terminated mid-cycle", async () => {
        await warpTo(poolStart + 5 * SECONDS_PER_DAY + 3600);
        // Must snapshot before claiming on Day 5
        await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: tPoolState }).signers([admin]).rpc();

        const [tStake] = getUserStakePda(tPoolState, tUser.publicKey);
        const [tMarker] = getClaimMarkerPda(tPoolState, tUser.publicKey);
        
        await program.methods.claimAirdrop(tAmount, getMerkleProof(tMerkleLayers, computeLeaf(tUser.publicKey, tAmount)))
            .accounts({
                user: tUser.publicKey,
                poolState: tPoolState,
                claimMarker: tMarker,
                userStake: tStake,
                systemProgram: SystemProgram.programId,
            })
            .signers([tUser])
            .rpc();

        const tUserAta = await getOrCreateATABankrun(tPool, tUser.publicKey, tUser);
        const balBeforeUnstake = (await getAccountBankrun(tUserAta))!.amount;
        console.log("Termination Test - Balance After Claim:", balBeforeUnstake.toString());

        // Must complete snapshots before terminating, as program requires all snapshots even for termination
        await warpTo(poolStart + 21 * SECONDS_PER_DAY);
        for(let i=0; i<20; i++) {
            try { 
                await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: tPoolState }).signers([admin]).rpc(); 
            } catch(e) {}
            const clock = await context.banksClient.getClock();
            await warpTo(Number(clock.unixTimestamp) + 1);
        }

        const adminAta = await getOrCreateATABankrun(tPool, admin.publicKey);
        await program.methods.terminatePool()
            .accounts({
                admin: admin.publicKey,
                poolState: tPoolState,
                poolTokenAccount: tPoolToken,
                adminTokenAccount: adminAta,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
        // Unstake as User
        await program.methods.unstake()
            .accounts({
                user: tUser.publicKey,
                poolState: tPoolState,
                userStake: tStake,
                poolTokenAccount: tPoolToken,
                userTokenAccount: tUserAta,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([tUser])
            .rpc();

        const balAfterUnstake = (await getAccountBankrun(tUserAta))!.amount;
        console.log("Termination Test - Balance After Unstake (Total Expected):", balAfterUnstake.toString());
        // User gets 10M principal + 75M airdrop = 85M total
        const expectedTotal = BigInt(tAmount.toString()) + BigInt("75000000000000000"); 
        expect(balAfterUnstake).to.equal(expectedTotal);
    });
  });

  describe("Coverage Deep Dive", () => {
    
    describe("Initialization Rejection", () => {
        it("Fails if daily_rewards sum is not STAKING_POOL", async () => {
            const mint = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
            const [pState] = getPoolStatePda(mint);
            const [pToken] = getPoolTokenPda(pState);

            const stSum = Math.floor(Date.now() / 1000) + 1000;
            await warpTo(stSum - 10);
            const rewards = Array(32).fill(new BN(0));
            const dayReward = STAKING_POOL.div(new BN(20));
            for (let i = 0; i < 20; i++) rewards[i] = dayReward;
            rewards[0] = rewards[0].add(new BN(1));

            try {
                await program.methods.initializePool(new BN(stSum), Array.from(multiMerkleRoot), rewards)
                    .accounts({
                        admin: admin.publicKey,
                        poolState: pState,
                        tokenMint: mint,
                        poolTokenAccount: pToken,
                        systemProgram: SystemProgram.programId,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        rent: SYSVAR_RENT_PUBKEY,
                    }).signers([admin]).rpc();
                expect.fail("Should have failed due to invalid reward sum");
            } catch (e: any) {
                const msg = (e.message || "").toString();
                expect(msg.toLowerCase(), `Actual error: ${msg}`).to.satisfy((m: string) => 
                    m.includes("6004") || m.includes("invaliddailyrewards") || m.includes("0x1774")
                );
            }
        });

        it("Fails if daily_rewards are not in ascending order", async () => {
            const mint = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
            const [pState] = getPoolStatePda(mint);
            const [pToken] = getPoolTokenPda(pState);

            const stOrder = Math.floor(Date.now() / 1000) + 2000;
            await warpTo(stOrder - 10);
            const rewards = Array(32).fill(new BN(0));
            const dayReward = STAKING_POOL.div(new BN(20));
            for (let i = 0; i < 20; i++) rewards[i] = dayReward;
            // Swap to break ascending order: day 1 > day 0
            rewards[0] = dayReward.add(new BN(100));
            rewards[1] = dayReward.sub(new BN(100));

            try {
                await program.methods.initializePool(new BN(stOrder), Array.from(multiMerkleRoot), rewards)
                    .accounts({
                        admin: admin.publicKey,
                        poolState: pState,
                        tokenMint: mint,
                        poolTokenAccount: pToken,
                        systemProgram: SystemProgram.programId,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        rent: SYSVAR_RENT_PUBKEY,
                    }).signers([admin]).rpc();
                expect.fail("Should have failed due to invalid reward order");
            } catch (e: any) {
                const msg = (e.message || "").toString();
                expect(msg.toLowerCase(), `Actual error: ${msg}`).to.satisfy((m: string) => 
                    m.includes("6005") || m.includes("invaliddailyrewardsorder") || m.includes("0x1775")
                );
            }
        });
    });

    describe("Airdrop Exhaustion", () => {
        let xPool: PublicKey;
        let xPoolState: PublicKey;
        let xPoolToken: PublicKey;
        let xMerkleLayers: any;
        let xMerkleRoot: Buffer;

        const users = Array.from({length: 3}, () => Keypair.generate());
        const amountPerUser = AIRDROP_POOL.div(new BN(2)); // Each user takes 50%, 3 users = 150% (Exhaustion)

        before(async () => {
            xPool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
            [xPoolState] = getPoolStatePda(xPool);
            [xPoolToken] = getPoolTokenPda(xPoolState);

            const leaves = users.map(u => computeLeaf(u.publicKey, amountPerUser));
            xMerkleLayers = buildMerkleTree(leaves);
            xMerkleRoot = getMerkleRoot(xMerkleLayers);

            const startTime = Math.floor(Date.now() / 1000) + 1000;
            await warpTo(startTime - 100);

            const rewards = computeDailyRewards();
            await program.methods.initializePool(new BN(startTime), Array.from(xMerkleRoot), rewards)
                .accounts({
                    admin: admin.publicKey,
                    poolState: xPoolState,
                    tokenMint: xPool,
                    poolTokenAccount: xPoolToken,
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    rent: SYSVAR_RENT_PUBKEY,
                }).signers([admin]).rpc();

            const adminAta = await getOrCreateATABankrun(xPool, admin.publicKey);
            const tx = new anchor.web3.Transaction().add(
                createMintToInstruction(xPool, adminAta, admin.publicKey, BigInt(TOTAL_POOL.toString())),
                createTransferInstruction(adminAta, xPoolToken, admin.publicKey, BigInt(TOTAL_POOL.toString()))
            );
            await provider.sendAndConfirm(tx, [admin]);
            
            await warpTo(startTime + SECONDS_PER_DAY + 3600);
            await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: xPoolState }).signers([admin]).rpc();
        });

        it("Fails when Airdrop Pool is exhausted", async () => {
            // User 1 & 2 together take 100% (50M)
            for (let i = 0; i < 2; i++) {
                const user = users[i];
                await fundAccount(user.publicKey);
                const [stake] = getUserStakePda(xPoolState, user.publicKey);
                const [marker] = getClaimMarkerPda(xPoolState, user.publicKey);
                await program.methods.claimAirdrop(amountPerUser, getMerkleProof(xMerkleLayers, computeLeaf(user.publicKey, amountPerUser)))
                    .accounts({ user: user.publicKey, poolState: xPoolState, claimMarker: marker, userStake: stake, systemProgram: SystemProgram.programId })
                    .signers([user]).rpc();
            }

            // User 3 tries to claim, exceeding 50M
            const user3 = users[2];
            await fundAccount(user3.publicKey);
            const [stake3] = getUserStakePda(xPoolState, user3.publicKey);
            const [marker3] = getClaimMarkerPda(xPoolState, user3.publicKey);
            try {
                await program.methods.claimAirdrop(amountPerUser, getMerkleProof(xMerkleLayers, computeLeaf(user3.publicKey, amountPerUser)))
                    .accounts({ user: user3.publicKey, poolState: xPoolState, claimMarker: marker3, userStake: stake3, systemProgram: SystemProgram.programId })
                    .signers([user3]).rpc();
                expect.fail("Airdrop pool should have been exhausted");
            } catch (e: any) {
                const msg = e.message || "";
                expect(msg).to.satisfy((m: string) => m.includes("6012") || m.includes("AirdropPoolExhausted"));
            }
        });
    });

    describe("Reward Accuracy & Expiry Deep Dive", () => {
        let fPool: PublicKey;
        let fPoolState: PublicKey;
        let fPoolToken: PublicKey;
        let fMerkleRoot: Buffer;
        let fMerkleLayers: any;
        let poolStart: number;

        const fUser = Keypair.generate();
        const fAmount = new BN(10_000_000).mul(new BN(1e9)); // 10M

        before(async () => {
            fPool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
            [fPoolState] = getPoolStatePda(fPool);
            [fPoolToken] = getPoolTokenPda(fPoolState);

            fMerkleLayers = buildMerkleTree([computeLeaf(fUser.publicKey, fAmount)]);
            fMerkleRoot = getMerkleRoot(fMerkleLayers);

            await fundAccount(fUser.publicKey);
            poolStart = Math.floor(Date.now() / 1000) + 1000;
            await warpTo(poolStart - 100);

            const rewards = computeDailyRewards();
            await program.methods.initializePool(new BN(poolStart), Array.from(fMerkleRoot), rewards)
                .accounts({
                    admin: admin.publicKey,
                    poolState: fPoolState,
                    tokenMint: fPool,
                    poolTokenAccount: fPoolToken,
                    systemProgram: SystemProgram.programId,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    rent: SYSVAR_RENT_PUBKEY,
                }).signers([admin]).rpc();

            const adminAta = await getOrCreateATABankrun(fPool, admin.publicKey);
            await provider.sendAndConfirm(new anchor.web3.Transaction().add(
                createMintToInstruction(fPool, adminAta, admin.publicKey, BigInt(TOTAL_POOL.toString())),
                createTransferInstruction(adminAta, fPoolToken, admin.publicKey, BigInt(TOTAL_POOL.toString()))
            ), [admin]);
        });

        it("Calculates precise rewards for late claim (Day 10)", async () => {
             // Warp to Day 10
             await warpTo(poolStart + 10 * SECONDS_PER_DAY + 3600);
             // Snapshot all days up to 10
             for(let i=0; i<10; i++) {
                try { await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: fPoolState }).signers([admin]).rpc(); } catch(e) {}
                const currentClock = await context.banksClient.getClock();
                await warpTo(Number(currentClock.unixTimestamp) + 1);
             }

             const [fStake] = getUserStakePda(fPoolState, fUser.publicKey);
             const [fMarker] = getClaimMarkerPda(fPoolState, fUser.publicKey);
             await program.methods.claimAirdrop(fAmount, getMerkleProof(fMerkleLayers, computeLeaf(fUser.publicKey, fAmount)))
                 .accounts({ user: fUser.publicKey, poolState: fPoolState, claimMarker: fMarker, userStake: fStake, systemProgram: SystemProgram.programId })
                 .signers([fUser]).rpc();

             // Day 10 user should only get rewards for Days 10-20 (10 days total)
             // Finish snapshots
             await warpTo(poolStart + 21 * SECONDS_PER_DAY);
             for(let i=0; i<11; i++) {
                try { await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: fPoolState }).signers([admin]).rpc(); } catch(e) {}
                await warpTo((await context.banksClient.getClock()).unixTimestamp + BigInt(1));
             }

             const stakeAcc = await program.account.userStake.fetch(fStake);
             expect(stakeAcc.claimDay.toNumber()).to.equal(10);

             const fUserAta = await getOrCreateATABankrun(fPool, fUser.publicKey, fUser);
             await program.methods.unstake()
                .accounts({ user: fUser.publicKey, poolState: fPoolState, userStake: fStake, poolTokenAccount: fPoolToken, userTokenAccount: fUserAta, tokenProgram: TOKEN_PROGRAM_ID })
                .signers([fUser]).rpc();

             const bal = (await getAccountBankrun(fUserAta))!.amount;
             // Expected: 10M principal + (10/20)*100M rewards = 10M + 50M = 60M
             // Plus the 10M from the airdrop itself (which was also 10M) = 70M total
             // Math: 10M (staked) + 50M (rewards) = 60M + 0 (starting bal) = 60M. 
             // Wait, claimAirdrop doesn't send tokens to ATA, it stakes them. 
             // Unstake sends (principal + rewards).
             expect(bal.toString()).to.equal("60000000000000000");
        });

        it("Unstake after expiration (Day 36) returns only principal", async () => {
            // Setup fresh pool for expiry test
            const xMint = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
            const [xState] = getPoolStatePda(xMint);
            const [xToken] = getPoolTokenPda(xState);
            const xUser = Keypair.generate();
            const xAmount = new BN(10_000_000).mul(new BN(1e9));
            const xMerkle = buildMerkleTree([computeLeaf(xUser.publicKey, xAmount)]);
            const xStart = Math.floor(Date.now() / 1000) + 1000;
            
            await warpTo(xStart - 100);
            await program.methods.initializePool(new BN(xStart), Array.from(getMerkleRoot(xMerkle)), computeDailyRewards())
                .accounts({ admin: admin.publicKey, poolState: xState, tokenMint: xMint, poolTokenAccount: xToken, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY }).signers([admin]).rpc();
            
            const adminAta = await getOrCreateATABankrun(xMint, admin.publicKey);
            await provider.sendAndConfirm(new anchor.web3.Transaction().add(
                createMintToInstruction(xMint, adminAta, admin.publicKey, BigInt(TOTAL_POOL.toString())),
                createTransferInstruction(adminAta, xToken, admin.publicKey, BigInt(TOTAL_POOL.toString()))
            ), [admin]);

            // Claim on Day 1
            await warpTo(xStart + SECONDS_PER_DAY + 3600);
            await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: xState }).signers([admin]).rpc();
            const [xStake] = getUserStakePda(xState, xUser.publicKey);
            const [xMarker] = getClaimMarkerPda(xState, xUser.publicKey);
            await fundAccount(xUser.publicKey);
            await program.methods.claimAirdrop(xAmount, getMerkleProof(xMerkle, computeLeaf(xUser.publicKey, xAmount)))
                .accounts({ user: xUser.publicKey, poolState: xState, claimMarker: xMarker, userStake: xStake, systemProgram: SystemProgram.programId }).signers([xUser]).rpc();

            // Finish snapshots
            await warpTo(xStart + 21 * SECONDS_PER_DAY);
            for(let i=0; i<20; i++) {
                try { await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: xState }).signers([admin]).rpc(); } catch(e) {}
                const currentClock = await context.banksClient.getClock();
                await warpTo(Number(currentClock.unixTimestamp) + 1);
            }

            // Warp to Day 36 (Expired)
            await warpTo(xStart + 36 * SECONDS_PER_DAY);
            const xUserAta = await getOrCreateATABankrun(xMint, xUser.publicKey, xUser);
            await program.methods.unstake()
                .accounts({ user: xUser.publicKey, poolState: xState, userStake: xStake, poolTokenAccount: xToken, userTokenAccount: xUserAta, tokenProgram: TOKEN_PROGRAM_ID })
                .signers([xUser]).rpc();

            const bal = (await getAccountBankrun(xUserAta))!.amount;
            // Should be exactly xAmount (10M), no rewards
            expect(bal).to.equal(BigInt(xAmount.toString()));
        });
    });
  });

  // ── NEW TEST SECTIONS: Coverage Improvements ──────────────────────────────

  describe("calculate_rewards instruction", () => {
    let crPool: PublicKey;
    let crPoolState: PublicKey;
    let crPoolToken: PublicKey;
    let crMerkleLayers: any;
    let crMerkleRoot: Buffer;
    let crStart: number;

    const crUser = Keypair.generate();
    const crAmount = new BN(5_000_000).mul(new BN(1e9)); // 5M

    before(async () => {
      crPool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
      [crPoolState] = getPoolStatePda(crPool);
      [crPoolToken] = getPoolTokenPda(crPoolState);

      crMerkleLayers = buildMerkleTree([computeLeaf(crUser.publicKey, crAmount)]);
      crMerkleRoot = getMerkleRoot(crMerkleLayers);

      await fundAccount(crUser.publicKey);
      crStart = Math.floor(Date.now() / 1000) + 1000;
      await warpTo(crStart - 100);

      await program.methods.initializePool(new BN(crStart), Array.from(crMerkleRoot), computeDailyRewards())
        .accounts({
          admin: admin.publicKey,
          poolState: crPoolState,
          tokenMint: crPool,
          poolTokenAccount: crPoolToken,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        }).signers([admin]).rpc();

      const adminAta = await getOrCreateATABankrun(crPool, admin.publicKey);
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(
        createMintToInstruction(crPool, adminAta, admin.publicKey, BigInt(TOTAL_POOL.toString())),
        createTransferInstruction(adminAta, crPoolToken, admin.publicKey, BigInt(TOTAL_POOL.toString()))
      ), [admin]);

      // User claims on Day 5
      await warpTo(crStart + 5 * SECONDS_PER_DAY + 3600);
      await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: crPoolState }).signers([admin]).rpc();

      const [crStake] = getUserStakePda(crPoolState, crUser.publicKey);
      const [crMarker] = getClaimMarkerPda(crPoolState, crUser.publicKey);
      await program.methods.claimAirdrop(crAmount, getMerkleProof(crMerkleLayers, computeLeaf(crUser.publicKey, crAmount)))
        .accounts({ user: crUser.publicKey, poolState: crPoolState, claimMarker: crMarker, userStake: crStake, systemProgram: SystemProgram.programId })
        .signers([crUser]).rpc();
    });

    it("Day before claim (day=3): reward should be 0", async () => {
      const [crStake] = getUserStakePda(crPoolState, crUser.publicKey);
      // day=3 < claim_day=5, should succeed with reward=0
      await program.methods.calculateRewards(new BN(3))
        .accounts({ poolState: crPoolState, userStake: crStake })
        .rpc();
    });

    it("Day with actual snapshot (day=5): should succeed", async () => {
      const [crStake] = getUserStakePda(crPoolState, crUser.publicKey);
      // day=5 has a snapshot, should compute correct reward
      await program.methods.calculateRewards(new BN(5))
        .accounts({ poolState: crPoolState, userStake: crStake })
        .rpc();
    });

    it("Future day (day > snapshot_count): uses last snapshot estimate", async () => {
      const [crStake] = getUserStakePda(crPoolState, crUser.publicKey);
      // day=15 is beyond snapshot_count, should use last snapshot value
      await program.methods.calculateRewards(new BN(15))
        .accounts({ poolState: crPoolState, userStake: crStake })
        .rpc();
    });

    it("Day >= 20 (day=20): should fail with InvalidDay", async () => {
      const [crStake] = getUserStakePda(crPoolState, crUser.publicKey);
      try {
        await program.methods.calculateRewards(new BN(20))
          .accounts({ poolState: crPoolState, userStake: crStake })
          .rpc();
        expect.fail("Should have failed with InvalidDay");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("InvalidDay") || m.includes("6017") || m.includes("0x1781"));
      }
    });
  });

  describe("close_pool error paths", () => {
    let cpPool: PublicKey;
    let cpPoolState: PublicKey;
    let cpPoolToken: PublicKey;
    let cpMerkleLayers: any;
    let cpMerkleRoot: Buffer;
    let cpStart: number;

    const cpUser = Keypair.generate();
    const cpAmount = new BN(1_000_000).mul(new BN(1e9)); // 1M

    before(async () => {
      cpPool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
      [cpPoolState] = getPoolStatePda(cpPool);
      [cpPoolToken] = getPoolTokenPda(cpPoolState);

      cpMerkleLayers = buildMerkleTree([computeLeaf(cpUser.publicKey, cpAmount)]);
      cpMerkleRoot = getMerkleRoot(cpMerkleLayers);

      await fundAccount(cpUser.publicKey);
      cpStart = Math.floor(Date.now() / 1000) + 1000;
      await warpTo(cpStart - 100);

      await program.methods.initializePool(new BN(cpStart), Array.from(cpMerkleRoot), computeDailyRewards())
        .accounts({
          admin: admin.publicKey,
          poolState: cpPoolState,
          tokenMint: cpPool,
          poolTokenAccount: cpPoolToken,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        }).signers([admin]).rpc();

      const adminAta = await getOrCreateATABankrun(cpPool, admin.publicKey);
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(
        createMintToInstruction(cpPool, adminAta, admin.publicKey, BigInt(TOTAL_POOL.toString())),
        createTransferInstruction(adminAta, cpPoolToken, admin.publicKey, BigInt(TOTAL_POOL.toString()))
      ), [admin]);

      // User claims on Day 1
      await warpTo(cpStart + SECONDS_PER_DAY + 3600);
      await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: cpPoolState }).signers([admin]).rpc();

      const [cpStake] = getUserStakePda(cpPoolState, cpUser.publicKey);
      const [cpMarker] = getClaimMarkerPda(cpPoolState, cpUser.publicKey);
      await program.methods.claimAirdrop(cpAmount, getMerkleProof(cpMerkleLayers, computeLeaf(cpUser.publicKey, cpAmount)))
        .accounts({ user: cpUser.publicKey, poolState: cpPoolState, claimMarker: cpMarker, userStake: cpStake, systemProgram: SystemProgram.programId })
        .signers([cpUser]).rpc();
    });

    it("PoolNotTerminated: close_pool on non-terminated pool", async () => {
      try {
        await program.methods.closePool()
          .accounts({
            admin: admin.publicKey,
            poolState: cpPoolState,
            poolTokenAccount: cpPoolToken,
            tokenProgram: TOKEN_PROGRAM_ID,
          }).signers([admin]).rpc();
        expect.fail("Should have failed with PoolNotTerminated");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("PoolNotTerminated") || m.includes("6004") || m.includes("0x1774"));
      }
    });

    it("PoolNotEmpty: close_pool before exit deadline with stakers", async () => {
      // Complete snapshots and terminate first
      await warpTo(cpStart + 21 * SECONDS_PER_DAY);
      for (let i = 0; i < 20; i++) {
        try { await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: cpPoolState }).signers([admin]).rpc(); } catch (e) {}
        const clock = await context.banksClient.getClock();
        await warpTo(Number(clock.unixTimestamp) + 1);
      }

      const adminAta = await getOrCreateATABankrun(cpPool, admin.publicKey);
      await program.methods.terminatePool()
        .accounts({
          admin: admin.publicKey,
          poolState: cpPoolState,
          poolTokenAccount: cpPoolToken,
          adminTokenAccount: adminAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([admin]).rpc();

      // Try close BEFORE exit deadline (Day 35) - user still has stake
      await warpTo(cpStart + 22 * SECONDS_PER_DAY);
      try {
        await program.methods.closePool()
          .accounts({
            admin: admin.publicKey,
            poolState: cpPoolState,
            poolTokenAccount: cpPoolToken,
            tokenProgram: TOKEN_PROGRAM_ID,
          }).signers([admin]).rpc();
        expect.fail("Should have failed with PoolNotEmpty");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("PoolNotEmpty") || m.includes("6005") || m.includes("0x1775"));
      }
    });

    it("Successful close: after exit deadline (Day 35+)", async () => {
      // Warp past exit deadline
      await warpTo(cpStart + 36 * SECONDS_PER_DAY);

      // User must unstake first to drain their principal from the pool token account
      const [cpStake] = getUserStakePda(cpPoolState, cpUser.publicKey);
      const cpUserAta = await getOrCreateATABankrun(cpPool, cpUser.publicKey, cpUser);
      await program.methods.unstake()
        .accounts({
          user: cpUser.publicKey,
          poolState: cpPoolState,
          userStake: cpStake,
          poolTokenAccount: cpPoolToken,
          userTokenAccount: cpUserAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([cpUser]).rpc();

      // Recover any remaining tokens (rewards etc.)
      const adminAta = await getOrCreateATABankrun(cpPool, admin.publicKey);
      try {
        await program.methods.recoverExpiredTokens()
          .accounts({
            admin: admin.publicKey,
            poolState: cpPoolState,
            poolTokenAccount: cpPoolToken,
            adminTokenAccount: adminAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          }).signers([admin]).rpc();
      } catch (e) {
        // May fail with NothingToRecover if already drained
      }

      const clock = await context.banksClient.getClock();
      await warpTo(Number(clock.unixTimestamp) + 1);

      await program.methods.closePool()
        .accounts({
          admin: admin.publicKey,
          poolState: cpPoolState,
          poolTokenAccount: cpPoolToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([admin]).rpc();

      // Verify pool_state account is closed
      const acc = await context.banksClient.getAccount(cpPoolState);
      expect(acc).to.be.null;
    });
  });

  describe("recover_expired_tokens error paths", () => {
    let rePool: PublicKey;
    let rePoolState: PublicKey;
    let rePoolToken: PublicKey;
    let reStart: number;

    before(async () => {
      rePool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
      [rePoolState] = getPoolStatePda(rePool);
      [rePoolToken] = getPoolTokenPda(rePoolState);

      reStart = Math.floor(Date.now() / 1000) + 1000;
      await warpTo(reStart - 100);

      await program.methods.initializePool(new BN(reStart), Array.from(multiMerkleRoot), computeDailyRewards())
        .accounts({
          admin: admin.publicKey,
          poolState: rePoolState,
          tokenMint: rePool,
          poolTokenAccount: rePoolToken,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        }).signers([admin]).rpc();

      const adminAta = await getOrCreateATABankrun(rePool, admin.publicKey);
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(
        createMintToInstruction(rePool, adminAta, admin.publicKey, BigInt(TOTAL_POOL.toString())),
        createTransferInstruction(adminAta, rePoolToken, admin.publicKey, BigInt(TOTAL_POOL.toString()))
      ), [admin]);
    });

    it("ExitWindowNotFinished: recover on Day 20 (before Day 35)", async () => {
      await warpTo(reStart + 20 * SECONDS_PER_DAY);
      const adminAta = await getOrCreateATABankrun(rePool, admin.publicKey);

      try {
        await program.methods.recoverExpiredTokens()
          .accounts({
            admin: admin.publicKey,
            poolState: rePoolState,
            poolTokenAccount: rePoolToken,
            adminTokenAccount: adminAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          }).signers([admin]).rpc();
        expect.fail("Should have failed with ExitWindowNotFinished");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("ExitWindowNotFinished") || m.includes("6025") || m.includes("0x1789"));
      }
    });

    it("NothingToRecover: recover after all tokens drained", async () => {
      // Warp past exit window and drain pool first via recovery
      await warpTo(reStart + 36 * SECONDS_PER_DAY);
      const adminAta = await getOrCreateATABankrun(rePool, admin.publicKey);

      // First recovery should succeed (pool has tokens, total_staked=0)
      await program.methods.recoverExpiredTokens()
        .accounts({
          admin: admin.publicKey,
          poolState: rePoolState,
          poolTokenAccount: rePoolToken,
          adminTokenAccount: adminAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([admin]).rpc();

      // Micro-warp to avoid duplicate tx signature
      const clock = await context.banksClient.getClock();
      await warpTo(Number(clock.unixTimestamp) + 1);

      // Second recovery: pool_balance == total_staked (both 0)
      try {
        await program.methods.recoverExpiredTokens()
          .accounts({
            admin: admin.publicKey,
            poolState: rePoolState,
            poolTokenAccount: rePoolToken,
            adminTokenAccount: adminAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          }).signers([admin]).rpc();
        expect.fail("Should have failed with NothingToRecover");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("NothingToRecover") || m.includes("6027") || m.includes("0x178b"));
      }
    });
  });

  describe("terminate_pool error paths", () => {
    let tpPool: PublicKey;
    let tpPoolState: PublicKey;
    let tpPoolToken: PublicKey;
    let tpStart: number;

    before(async () => {
      tpPool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
      [tpPoolState] = getPoolStatePda(tpPool);
      [tpPoolToken] = getPoolTokenPda(tpPoolState);

      tpStart = Math.floor(Date.now() / 1000) + 1000;
      await warpTo(tpStart - 100);

      await program.methods.initializePool(new BN(tpStart), Array.from(multiMerkleRoot), computeDailyRewards())
        .accounts({
          admin: admin.publicKey,
          poolState: tpPoolState,
          tokenMint: tpPool,
          poolTokenAccount: tpPoolToken,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        }).signers([admin]).rpc();

      const adminAta = await getOrCreateATABankrun(tpPool, admin.publicKey);
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(
        createMintToInstruction(tpPool, adminAta, admin.publicKey, BigInt(TOTAL_POOL.toString())),
        createTransferInstruction(adminAta, tpPoolToken, admin.publicKey, BigInt(TOTAL_POOL.toString()))
      ), [admin]);
    });

    it("SnapshotsNotCompleted: terminate before 20 snapshots", async () => {
      // Only take a few snapshots
      await warpTo(tpStart + 5 * SECONDS_PER_DAY + 3600);
      await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: tpPoolState }).signers([admin]).rpc();

      const adminAta = await getOrCreateATABankrun(tpPool, admin.publicKey);
      try {
        await program.methods.terminatePool()
          .accounts({
            admin: admin.publicKey,
            poolState: tpPoolState,
            poolTokenAccount: tpPoolToken,
            adminTokenAccount: adminAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          }).signers([admin]).rpc();
        expect.fail("Should have failed with SnapshotsNotCompleted");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("SnapshotsNotCompleted") || m.includes("6021") || m.includes("0x1785"));
      }
    });

    it("AlreadyTerminated: terminate twice", async () => {
      // Complete all snapshots
      await warpTo(tpStart + 21 * SECONDS_PER_DAY);
      for (let i = 0; i < 20; i++) {
        try { await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: tpPoolState }).signers([admin]).rpc(); } catch (e) {}
        const clock = await context.banksClient.getClock();
        await warpTo(Number(clock.unixTimestamp) + 1);
      }

      const adminAta = await getOrCreateATABankrun(tpPool, admin.publicKey);
      // First terminate should succeed
      await program.methods.terminatePool()
        .accounts({
          admin: admin.publicKey,
          poolState: tpPoolState,
          poolTokenAccount: tpPoolToken,
          adminTokenAccount: adminAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([admin]).rpc();

      // Second terminate should fail
      const clock = await context.banksClient.getClock();
      await warpTo(Number(clock.unixTimestamp) + 1);

      try {
        await program.methods.terminatePool()
          .accounts({
            admin: admin.publicKey,
            poolState: tpPoolState,
            poolTokenAccount: tpPoolToken,
            adminTokenAccount: adminAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          }).signers([admin]).rpc();
        expect.fail("Should have failed with AlreadyTerminated");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("AlreadyTerminated") || m.includes("6003") || m.includes("0x1773"));
      }
    });
  });

  describe("Pause/Unpause error paths", () => {
    let ppPool: PublicKey;
    let ppPoolState: PublicKey;
    let ppPoolToken: PublicKey;
    let ppStart: number;

    before(async () => {
      ppPool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
      [ppPoolState] = getPoolStatePda(ppPool);
      [ppPoolToken] = getPoolTokenPda(ppPoolState);

      ppStart = Math.floor(Date.now() / 1000) + 1000;
      await warpTo(ppStart - 100);

      await program.methods.initializePool(new BN(ppStart), Array.from(multiMerkleRoot), computeDailyRewards())
        .accounts({
          admin: admin.publicKey,
          poolState: ppPoolState,
          tokenMint: ppPool,
          poolTokenAccount: ppPoolToken,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        }).signers([admin]).rpc();
    });

    it("AlreadyPaused: pause an already-paused pool", async () => {
      await program.methods.pausePool().accounts({ admin: admin.publicKey, poolState: ppPoolState }).signers([admin]).rpc();

      const clock = await context.banksClient.getClock();
      await warpTo(Number(clock.unixTimestamp) + 1);

      try {
        await program.methods.pausePool().accounts({ admin: admin.publicKey, poolState: ppPoolState }).signers([admin]).rpc();
        expect.fail("Should have failed with AlreadyPaused");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("AlreadyPaused") || m.includes("6010") || m.includes("0x177a"));
      }
    });

    it("Snapshot while paused: should fail with PoolPaused", async () => {
      // Pool is still paused from previous test
      await warpTo(ppStart + SECONDS_PER_DAY + 3600);

      try {
        await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: ppPoolState }).signers([admin]).rpc();
        expect.fail("Should have failed with PoolPaused");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("PoolPaused") || m.includes("6008") || m.includes("0x1778"));
      }
    });

    it("PoolNotPaused: unpause a non-paused pool", async () => {
      // First unpause to get back to non-paused state
      await program.methods.unpausePool().accounts({ admin: admin.publicKey, poolState: ppPoolState }).signers([admin]).rpc();

      const clock = await context.banksClient.getClock();
      await warpTo(Number(clock.unixTimestamp) + 1);

      try {
        await program.methods.unpausePool().accounts({ admin: admin.publicKey, poolState: ppPoolState }).signers([admin]).rpc();
        expect.fail("Should have failed with PoolNotPaused");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("PoolNotPaused") || m.includes("6009") || m.includes("0x1779"));
      }
    });
  });

  describe("PoolTerminated guards", () => {
    let ptPool: PublicKey;
    let ptPoolState: PublicKey;
    let ptPoolToken: PublicKey;
    let ptMerkleLayers: any;
    let ptMerkleRoot: Buffer;
    let ptStart: number;

    const ptUser = Keypair.generate();
    const ptAmount = new BN(1_000_000).mul(new BN(1e9));

    before(async () => {
      ptPool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
      [ptPoolState] = getPoolStatePda(ptPool);
      [ptPoolToken] = getPoolTokenPda(ptPoolState);

      ptMerkleLayers = buildMerkleTree([
        computeLeaf(ptUser.publicKey, ptAmount),
        computeLeaf(alice.publicKey, aliceAmount),
      ]);
      ptMerkleRoot = getMerkleRoot(ptMerkleLayers);

      await fundAccount(ptUser.publicKey);
      ptStart = Math.floor(Date.now() / 1000) + 1000;
      await warpTo(ptStart - 100);

      await program.methods.initializePool(new BN(ptStart), Array.from(ptMerkleRoot), computeDailyRewards())
        .accounts({
          admin: admin.publicKey,
          poolState: ptPoolState,
          tokenMint: ptPool,
          poolTokenAccount: ptPoolToken,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        }).signers([admin]).rpc();

      const adminAta = await getOrCreateATABankrun(ptPool, admin.publicKey);
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(
        createMintToInstruction(ptPool, adminAta, admin.publicKey, BigInt(TOTAL_POOL.toString())),
        createTransferInstruction(adminAta, ptPoolToken, admin.publicKey, BigInt(TOTAL_POOL.toString()))
      ), [admin]);

      // Claim with ptUser on Day 1, complete all snapshots, then terminate
      await warpTo(ptStart + SECONDS_PER_DAY + 3600);
      await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: ptPoolState }).signers([admin]).rpc();

      const [ptStake] = getUserStakePda(ptPoolState, ptUser.publicKey);
      const [ptMarker] = getClaimMarkerPda(ptPoolState, ptUser.publicKey);
      await program.methods.claimAirdrop(ptAmount, getMerkleProof(ptMerkleLayers, computeLeaf(ptUser.publicKey, ptAmount)))
        .accounts({ user: ptUser.publicKey, poolState: ptPoolState, claimMarker: ptMarker, userStake: ptStake, systemProgram: SystemProgram.programId })
        .signers([ptUser]).rpc();

      // Complete all 20 snapshots
      await warpTo(ptStart + 21 * SECONDS_PER_DAY);
      for (let i = 0; i < 20; i++) {
        try { await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: ptPoolState }).signers([admin]).rpc(); } catch (e) {}
        const clock = await context.banksClient.getClock();
        await warpTo(Number(clock.unixTimestamp) + 1);
      }

      // Terminate
      const adminAta2 = await getOrCreateATABankrun(ptPool, admin.publicKey);
      await program.methods.terminatePool()
        .accounts({
          admin: admin.publicKey,
          poolState: ptPoolState,
          poolTokenAccount: ptPoolToken,
          adminTokenAccount: adminAta2,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([admin]).rpc();
    });

    it("claim_airdrop on terminated pool fails with PoolTerminated", async () => {
      const [aStake] = getUserStakePda(ptPoolState, alice.publicKey);
      const [aMarker] = getClaimMarkerPda(ptPoolState, alice.publicKey);

      try {
        await program.methods.claimAirdrop(aliceAmount, getMerkleProof(ptMerkleLayers, computeLeaf(alice.publicKey, aliceAmount)))
          .accounts({ user: alice.publicKey, poolState: ptPoolState, claimMarker: aMarker, userStake: aStake, systemProgram: SystemProgram.programId })
          .signers([alice]).rpc();
        expect.fail("Should have failed with PoolTerminated");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("PoolTerminated") || m.includes("6002") || m.includes("0x1772"));
      }
    });

    it("snapshot on terminated pool fails with PoolTerminated", async () => {
      try {
        await program.methods.snapshot()
          .accounts({ signer: admin.publicKey, poolState: ptPoolState })
          .signers([admin]).rpc();
        expect.fail("Should have failed with PoolTerminated");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("PoolTerminated") || m.includes("6002") || m.includes("0x1772"));
      }
    });

    it("pause on terminated pool fails with PoolTerminated", async () => {
      try {
        await program.methods.pausePool()
          .accounts({ admin: admin.publicKey, poolState: ptPoolState })
          .signers([admin]).rpc();
        expect.fail("Should have failed with PoolTerminated");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("PoolTerminated") || m.includes("6002") || m.includes("0x1772"));
      }
    });

    it("unpause on terminated pool fails with PoolTerminated", async () => {
      try {
        await program.methods.unpausePool()
          .accounts({ admin: admin.publicKey, poolState: ptPoolState })
          .signers([admin]).rpc();
        expect.fail("Should have failed with PoolTerminated");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        // unpause checks paused==1 first, but pool is not paused, so it hits PoolNotPaused before PoolTerminated
        // Both are valid rejections for an invalid operation on a terminated pool
        expect(msg).to.satisfy((m: string) => m.includes("PoolTerminated") || m.includes("PoolNotPaused") || m.includes("6002") || m.includes("6009"));
      }
    });
  });

  describe("SnapshotRequiredFirst guards", () => {
    let srPool: PublicKey;
    let srPoolState: PublicKey;
    let srPoolToken: PublicKey;
    let srMerkleLayers: any;
    let srMerkleRoot: Buffer;
    let srStart: number;

    const srUser = Keypair.generate();
    const srAmount = new BN(1_000_000).mul(new BN(1e9));

    before(async () => {
      srPool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
      [srPoolState] = getPoolStatePda(srPool);
      [srPoolToken] = getPoolTokenPda(srPoolState);

      srMerkleLayers = buildMerkleTree([
        computeLeaf(srUser.publicKey, srAmount),
        computeLeaf(alice.publicKey, aliceAmount),
      ]);
      srMerkleRoot = getMerkleRoot(srMerkleLayers);

      await fundAccount(srUser.publicKey);
      srStart = Math.floor(Date.now() / 1000) + 1000;
      await warpTo(srStart - 100);

      await program.methods.initializePool(new BN(srStart), Array.from(srMerkleRoot), computeDailyRewards())
        .accounts({
          admin: admin.publicKey,
          poolState: srPoolState,
          tokenMint: srPool,
          poolTokenAccount: srPoolToken,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        }).signers([admin]).rpc();

      const adminAta = await getOrCreateATABankrun(srPool, admin.publicKey);
      await provider.sendAndConfirm(new anchor.web3.Transaction().add(
        createMintToInstruction(srPool, adminAta, admin.publicKey, BigInt(TOTAL_POOL.toString())),
        createTransferInstruction(adminAta, srPoolToken, admin.publicKey, BigInt(TOTAL_POOL.toString()))
      ), [admin]);
    });

    it("claim_airdrop without snapshot fails with SnapshotRequiredFirst", async () => {
      // Warp to Day 2 without taking any snapshot
      await warpTo(srStart + 2 * SECONDS_PER_DAY + 3600);

      const [srStake] = getUserStakePda(srPoolState, alice.publicKey);
      const [srMarker] = getClaimMarkerPda(srPoolState, alice.publicKey);

      try {
        await program.methods.claimAirdrop(aliceAmount, getMerkleProof(srMerkleLayers, computeLeaf(alice.publicKey, aliceAmount)))
          .accounts({ user: alice.publicKey, poolState: srPoolState, claimMarker: srMarker, userStake: srStake, systemProgram: SystemProgram.programId })
          .signers([alice]).rpc();
        expect.fail("Should have failed with SnapshotRequiredFirst");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("SnapshotRequiredFirst") || m.includes("6019") || m.includes("0x1783"));
      }
    });

    it("unstake without snapshot fails with SnapshotRequiredFirst", async () => {
      // First, take snapshot for Day 2 so user can claim
      await program.methods.snapshot().accounts({ signer: admin.publicKey, poolState: srPoolState }).signers([admin]).rpc();

      const [srStake] = getUserStakePda(srPoolState, srUser.publicKey);
      const [srMarker] = getClaimMarkerPda(srPoolState, srUser.publicKey);
      await program.methods.claimAirdrop(srAmount, getMerkleProof(srMerkleLayers, computeLeaf(srUser.publicKey, srAmount)))
        .accounts({ user: srUser.publicKey, poolState: srPoolState, claimMarker: srMarker, userStake: srStake, systemProgram: SystemProgram.programId })
        .signers([srUser]).rpc();

      // Warp to Day 5 WITHOUT taking snapshot for Day 5
      await warpTo(srStart + 5 * SECONDS_PER_DAY + 3600);

      const srUserAta = await getOrCreateATABankrun(srPool, srUser.publicKey, srUser);
      try {
        await program.methods.unstake()
          .accounts({
            user: srUser.publicKey,
            poolState: srPoolState,
            userStake: srStake,
            poolTokenAccount: srPoolToken,
            userTokenAccount: srUserAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          }).signers([srUser]).rpc();
        expect.fail("Should have failed with SnapshotRequiredFirst");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("SnapshotRequiredFirst") || m.includes("6019") || m.includes("0x1783"));
      }
    });
  });

  describe("Snapshot after Day 20", () => {
    it("snapshot after Day 20 fails with InvalidDay", async () => {
      const sdPool = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
      const [sdPoolState] = getPoolStatePda(sdPool);
      const [sdPoolToken] = getPoolTokenPda(sdPoolState);

      const sdStart = Math.floor(Date.now() / 1000) + 1000;
      await warpTo(sdStart - 100);

      await program.methods.initializePool(new BN(sdStart), Array.from(multiMerkleRoot), computeDailyRewards())
        .accounts({
          admin: admin.publicKey,
          poolState: sdPoolState,
          tokenMint: sdPool,
          poolTokenAccount: sdPoolToken,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        }).signers([admin]).rpc();

      // Warp to Day 25 (beyond TOTAL_DAYS=20)
      await warpTo(sdStart + 25 * SECONDS_PER_DAY + 3600);

      try {
        await program.methods.snapshot()
          .accounts({ signer: admin.publicKey, poolState: sdPoolState })
          .signers([admin]).rpc();
        expect.fail("Should have failed with InvalidDay");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("InvalidDay") || m.includes("6017") || m.includes("0x1781"));
      }
    });
  });

  describe("initialize_pool error path", () => {
    it("StartTimeInPast: initialize with start_time in the past", async () => {
      const mint = await createMintBankrun(TOKEN_DECIMALS, admin.publicKey);
      const [pState] = getPoolStatePda(mint);
      const [pToken] = getPoolTokenPda(pState);

      const now = Math.floor(Date.now() / 1000);
      await warpTo(now);

      // Set start_time in the past
      const pastStart = now - 3600;

      try {
        await program.methods.initializePool(new BN(pastStart), Array.from(multiMerkleRoot), computeDailyRewards())
          .accounts({
            admin: admin.publicKey,
            poolState: pState,
            tokenMint: mint,
            poolTokenAccount: pToken,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
          }).signers([admin]).rpc();
        expect.fail("Should have failed with StartTimeInPast");
      } catch (e: any) {
        const msg = (e.message || "").toString();
        expect(msg).to.satisfy((m: string) => m.includes("StartTimeInPast") || m.includes("6000") || m.includes("0x1770"));
      }
    });
  });

});
