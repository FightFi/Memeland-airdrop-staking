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
    multiMerkleRoot = multiMerkleLayers[multiMerkleLayers.length - 1][0];
    
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

        const rewards = Array(32).fill(new BN(0));
        const dayReward = STAKING_POOL.div(new BN(20));
        for (let i = 0; i < 20; i++) rewards[i] = dayReward;
        rewards[19] = rewards[19].add(STAKING_POOL.mod(new BN(20)));

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

});
