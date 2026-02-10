# Memeland $FIGHT Airdrop & 20-Day Exponential Staking Program

A Solana smart contract that distributes 200,000,000 $FIGHT tokens through a combined airdrop and staking mechanism over 20 days.

## Token Distribution

| Pool | Amount | Share |
|------|--------|-------|
| Airdrop (pre-staked) | 67,000,000 | 1/3 |
| Staking rewards | 133,000,000 | 2/3 |
| **Total** | **200,000,000** | |

Token decimals: **9** (amounts are stored as raw units × 10⁹)

## How It Works

### Airdrop & Auto-Staking
- Eligible wallets and amounts are defined in a CSV allowlist
- A **merkle tree** is built from the list; only the 32-byte root is stored on-chain
- Users claim via `claim_airdrop` by submitting their amount and merkle proof — no backend or admin signature needed
- Claimed tokens are immediately auto-staked — there is no separate staking step
- Each wallet can only claim once

### Merkle Allowlist

The allowlist is a CSV file mapping wallets to their airdrop amounts:

```csv
wallet,amount
7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV,1000000.000000000
BLDpSMCi4FUYcY3sMfZRjcMTSqRTkGFB5gVH8GhnBi3P,2500000.000000000
```

A build script computes the merkle tree and outputs a JSON file with the root and per-user proofs:

```bash
yarn build-merkle data/allowlist.csv
```

Output JSON contains:
- `merkleRoot` — pass to `initialize_pool`
- `claims[wallet].proof` — user submits with `claim_airdrop`
- `claims[wallet].amountRaw` — raw token amount (9 decimals)

### Exponential Emission Curve

Daily staking rewards follow an exponential curve (K ≈ 0.15):

```
R(d) = R₁ × e^(k × (d - 1))
```

| Day | Reward (approx) |
|-----|-----------------|
| 1   | ~1.13M tokens |
| 2   | ~1.31M tokens |
| 3   | ~1.52M tokens |
| 4   | ~1.77M tokens |
| 5   | ~2.05M tokens |
| 6   | ~2.39M tokens |
| 7   | ~2.77M tokens |
| 8   | ~3.22M tokens |
| 9   | ~3.74M tokens |
| 10  | ~4.35M tokens |
| 11  | ~5.05M tokens |
| 12  | ~5.87M tokens |
| 13  | ~6.82M tokens |
| 14  | ~7.93M tokens |
| 15  | ~9.21M tokens |
| 16  | ~10.70M tokens |
| 17  | ~12.43M tokens |
| 18  | ~14.44M tokens |
| 19  | ~16.78M tokens |
| 20  | ~19.50M tokens |

- Last 5 days emit ~56% of total staking rewards
- Rewards are computed off-chain and validated on-chain (must sum to exactly 133M)

### Daily Snapshots

**Design:** Admin can take snapshots **anytime** during the day (no fixed time window).

- Admin calls `snapshot()` once per day to record `total_staked`
- Claims and unstakes are **blocked** on day N (N ≥ 2) until snapshot for day N-1 exists
- Days 0-1: Free operations (no previous snapshot required)
- If admin misses a snapshot, `backfill_snapshot(day)` can be used to catch up

| Day | Required Snapshots |
|-----|-------------------|
| 0-1 | None |
| 2   | Snapshot 1 |
| 3   | Snapshots 1-2 |
| N   | Snapshots 1 to N-1 |

### Reward Accumulation & Pro-Rata Distribution

- Rewards accumulate and are paid out on unstake
- For each day: `user_reward = (user_staked / daily_snapshot_total) × daily_reward`
- `calculate_rewards(day)` lets users preview rewards for any day
- For future days, the last snapshot value is used for estimates

### One-Way Unstake

- `unstake` is **permanent** — no re-entry
- Returns principal + all accumulated rewards
- `UserStake` account is closed (rent returned to user)
- `ClaimMarker` persists (prevents re-claiming)

### Pool Lifecycle

```
Day 0-20: Active staking period
  └── Users claim and stake
  └── Admin takes daily snapshots
  └── Users can unstake anytime (after required snapshots)
  └── Admin can pause/unpause for emergencies

Day 20-35: Exit window (15 days grace period)
  └── No new claims
  └── Users can still unstake with rewards

After Day 35:
  └── Admin can recover unclaimed rewards (user principal protected)
  └── Admin can close pool when all users have unstaked
```

### Emergency Pause

Admin can pause the pool at any time to block:
- `claim_airdrop` - new claims blocked
- `snapshot` - snapshots blocked
- `backfill_snapshot` - backfills blocked

**Users can ALWAYS unstake** even when paused - this protects user funds.

## Architecture

### Accounts

**PoolState** (PDA: `["pool_state", mint]`)
- Admin, mint, token account references, merkle root
- `daily_rewards[32]` — pre-computed reward curve (indices 0-19 used)
- `daily_snapshots[32]` — recorded total_staked per day
- `snapshot_count` — highest day snapshotted

**ClaimMarker** (PDA: `["claimed", pool_state, user]`)
- Permanent marker preventing re-claims (~0.001 SOL rent)
- Created on claim, never closed

**UserStake** (PDA: `["user_stake", pool_state, user]`)
- `staked_amount`, `claim_day`, `owner`
- Created on claim, **closed on unstake** (rent returned)

**Pool Token Account** (PDA: `["pool_token", pool_state]`)
- Self-authority token account holding all pool tokens

### Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize_pool(start_time, merkle_root, daily_rewards)` | admin | Creates pool, validates rewards sum |
| `claim_airdrop(amount, proof)` | user | Verifies proof, creates ClaimMarker + UserStake |
| `snapshot()` | admin | Records daily total_staked |
| `backfill_snapshot(day)` | admin | Backfill missed snapshot |
| `unstake()` | user | Exit: returns stake + rewards, closes UserStake |
| `pause_pool()` | admin | Emergency pause - blocks claims/snapshots |
| `unpause_pool()` | admin | Resume normal operations |
| `terminate_pool()` | admin | Stops claims, drains excess tokens |
| `recover_expired_tokens()` | admin | After day 35, recover unclaimed rewards |
| `close_pool()` | admin | Close pool when empty |
| `calculate_rewards(day)` | none | View: logs user's reward for a day |

### Events

```rust
PoolInitialized { admin, token_mint, start_time }
AirdropClaimed { user, amount, claim_day }
SnapshotTaken { day, total_staked }
Unstaked { user, principal, rewards }
PoolPausedEvent { admin }
PoolUnpausedEvent { admin }
PoolTerminated { drained_amount }
TokensRecovered { amount }
PoolClosed { lamports_returned }
```

## Project Structure

```
memeland-airdrop/
├── programs/memeland_airdrop/src/lib.rs   # Smart contract
├── target/idl/memeland_airdrop.json       # IDL
├── tests/memeland_airdrop.ts              # Test suite (64 tests)
├── scripts/
│   ├── build-merkle-tree.ts               # CSV → merkle JSON
│   ├── initialize-pool.ts                 # Initialize + fund pool
│   ├── snapshot.ts                        # Daily snapshot caller
│   ├── utils/rewards.ts                   # Shared reward computation
│   └── generate-keypairs.ts               # Keypair generator
├── data/
│   └── allowlist-example.csv              # Example allowlist
├── .env.local                             # Local validator config
├── .env.testnet                           # Devnet config
├── .env.prod                              # Mainnet config
└── Anchor.toml
```

## Scripts

| Command | Description |
|---------|-------------|
| `yarn build-merkle <csv>` | Build merkle tree from allowlist |
| `yarn generate-keypairs` | Generate admin + mint keypairs |
| `yarn init-pool:devnet` | Initialize pool on devnet |
| `yarn init-pool:prod` | Initialize pool on mainnet |
| `yarn snapshot:devnet` | Take today's snapshot on devnet (idempotent) |
| `yarn snapshot:prod` | Take today's snapshot on mainnet (idempotent) |
| `yarn snapshot:devnet:backfill` | Backfill all missing snapshots (devnet) |
| `yarn snapshot:prod:backfill` | Backfill all missing snapshots (mainnet) |
| `anchor test` | Run test suite (64 tests) |
| `anchor build` | Build the program |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANCHOR_PROVIDER_URL` | Solana RPC endpoint |
| `ANCHOR_WALLET` | Path to admin keypair JSON |
| `PROGRAM_ID` | Deployed program address |
| `TOKEN_MINT` | $FIGHT token mint address |
| `MERKLE_JSON` | Path to merkle tree JSON |
| `START_TIME` | (optional) Unix timestamp for pool start |

## Prerequisites

- Rust 1.84+
- [Solana CLI](https://docs.solanalabs.com/cli/install) v2+
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) 0.31.0
- Node.js 20+ and Yarn

## Build & Test

```bash
# Build
anchor build

# Test (64 tests)
anchor test
```

## Deploy

### Devnet

```bash
# 1. Generate keypairs
yarn generate-keypairs

# 2. Fund admin wallet
solana airdrop 2 <ADMIN_PUBKEY> --url devnet

# 3. Build merkle tree
yarn build-merkle data/allowlist.csv

# 4. Deploy
anchor deploy --provider.cluster devnet

# 5. Initialize and fund
yarn init-pool:devnet
```

### Mainnet

```bash
# 1. Configure .env.prod with admin wallet, token mint, merkle JSON
# 2. Ensure admin has SOL + 200M $FIGHT tokens

# 3. Deploy
anchor deploy --provider.cluster mainnet

# 4. Initialize and fund
yarn init-pool:prod
```

## User Flow

1. User connects wallet to frontend
2. Frontend looks up `claims[wallet]` in merkle JSON
3. Frontend calls `claim_airdrop(amountRaw, proof)`
4. Contract verifies proof, creates ClaimMarker + UserStake
5. Tokens are auto-staked and earn rewards immediately
6. User can unstake anytime to receive principal + accumulated rewards

## Admin Operations

### Daily Snapshot

The snapshot script is smart and idempotent:
- Detects the current program day
- Checks if snapshot already exists for today
- Only takes snapshot if missing
- Handles pool paused/terminated states

```bash
# Take today's snapshot (safe to run multiple times)
yarn snapshot:prod

# Backfill ALL missing snapshots (days 1 to current)
yarn snapshot:prod:backfill
```

Automate with cron (script handles idempotency):

```bash
# Run daily at 6 AM UTC - safe to run even if already taken
0 6 * * * cd /path/to/project && yarn snapshot:prod >> logs/snapshot.log 2>&1
```

Example output:
```
============================================================
Memeland Airdrop - Snapshot Script
============================================================
Current UTC time: Tue, 04 Feb 2026 15:30:00 GMT
Pool start time:  Mon, 03 Feb 2026 00:00:00 GMT
Current day:      2 / 20
Total staked:     1000000 tokens
Snapshot count:   1
Pool paused:      NO
Pool terminated:  NO
============================================================

Missing snapshots for days: 2

Will take snapshots for days: 2

[Day 2] Calling snapshot()...
[Day 2] Success! TX: 5abc...

============================================================
Completed: 1/1 snapshots taken.
============================================================
```

### Emergency Pause/Unpause

```typescript
// Pause pool (blocks claims, snapshots)
await program.methods
  .pausePool()
  .accounts({ admin: adminPubkey, poolState: poolStatePda })
  .rpc();

// Unpause pool (resume operations)
await program.methods
  .unpausePool()
  .accounts({ admin: adminPubkey, poolState: poolStatePda })
  .rpc();
```

### Termination

```bash
# Terminate pool (blocks new claims, drains excess)
# Users can still unstake
```

### Recovery (After Day 35)

```bash
# Recover unclaimed rewards (user principal protected)
# Close pool when all users have unstaked
```

## Program ID

```
4uxX6uS3V9pyP3ei8NWZzz6RsqSddEhwosSqLD3ZbsVs
```

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | StartTimeInPast | Start time is in the past |
| 6001 | AirdropPoolExhausted | Airdrop pool (67M) fully claimed |
| 6002 | PoolTerminated | Pool has been terminated |
| 6003 | AlreadyTerminated | Pool already terminated |
| 6004 | PoolNotTerminated | Must terminate before closing |
| 6005 | PoolNotEmpty | Users must unstake before closing |
| 6006 | InvalidDailyRewards | Rewards don't sum to STAKING_POOL |
| 6007 | InvalidDailyRewardsOrder | Daily rewards must be ascending |
| 6008 | PoolPaused | Pool is paused - operations disabled |
| 6009 | PoolNotPaused | Pool is not paused |
| 6010 | AlreadyPaused | Pool is already paused |
| 6011 | ProgramExpired | Program has expired |
| 6012 | NothingStaked | No staked balance to unstake |
| 6013 | InvalidStakeOwner | UserStake owner mismatch |
| 6014 | UnauthorizedAdmin | Signer is not the pool admin |
| 6015 | Unauthorized | Generic access denied |
| 6016 | InvalidMerkleProof | Proof doesn't verify |
| 6017 | InvalidDay | Day out of range |
| 6018 | SnapshotRequiredFirst | Previous day's snapshot missing |
| 6019 | SnapshotsNotCompleted | Must take all 20 snapshots |
| 6020 | InvalidPoolTokenAccount | Pool token account mismatch |
| 6021 | ExitWindowNotFinished | Must wait until day 35 |
| 6022 | NothingToRecover | No tokens to recover |
| 6023 | PoolNotStartedYet | Pool not started yet |

## Constants

```rust
TOTAL_DAYS = 20              // Program duration
SECONDS_PER_DAY = 86400      // 24 hours
EXIT_WINDOW_DAYS = 15        // Grace period after day 20
AIRDROP_POOL = 67M × 10⁹     // 67M tokens (9 decimals)
STAKING_POOL = 133M × 10⁹    // 133M tokens (9 decimals)
```

## Security

 Key points:

- **Merkle claims**: Cryptographically verified, no admin signature needed
- **ClaimMarker**: Permanent account prevents double-claims
- **Snapshot protection**: Operations blocked until relevant snapshot taken
- **Principal protection**: User funds protected in terminate and recovery
- **PDA security**: All accounts derived from program ID with centralized seeds
- **Overflow protection**: u128 intermediate math with checked operations
- **Emergency pause**: Admin can pause pool; users can always unstake (funds protected)
- **Specific error codes**: Constraint errors provide clear debugging information

## License

ISC
