# Memeland $FIGHT Airdrop & Exponential Staking Program

A Solana smart contract that distributes 200,000,000 $FIGHT tokens through a combined airdrop and staking rewards mechanism. Rewards are computed over 20 days with an exponential curve, and users have a 40-day claim window.

## Token Distribution

| Pool | Amount | Share |
|------|--------|-------|
| Airdrop (sent to wallet on claim) | 67,000,000 | 1/3 |
| Staking rewards | 133,000,000 | 2/3 |
| **Total** | **200,000,000** | |

Token decimals: **9** (amounts are stored as raw units × 10⁹)

## How It Works

### Airdrop Claim & Virtual Staking

- Eligible wallets and amounts are defined in a CSV allowlist
- A **merkle tree** is built from the list; only the 32-byte root is stored on-chain
- Users claim via `claim_airdrop` by submitting their amount and merkle proof — no backend or admin signature needed
- **Claimed tokens are sent directly to the user's wallet** on claim
- A virtual staking record (`UserStake`) is created to track reward accrual
- Each wallet can only claim once (enforced by `ClaimMarker`)
- Claims are accepted during the 40-day claim window (`CLAIM_WINDOW_DAYS`)

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

**Design:** Anyone can take snapshots — the instruction is permissionless to prevent admin griefing.

- Call `snapshot()` once per day to record `total_staked` for reward calculations
- Unstakes are **blocked** until the current day's snapshot has been taken
- Claims are **not** gated by snapshots (since all allocations are pre-accounted from day 0)
- If a snapshot is missed, calling `snapshot()` on a later day backfills all missing days with the current `total_staked` value

### Reward Accumulation & Pro-Rata Distribution

- **All users earn rewards from day 0**, regardless of when they claim
- The full `AIRDROP_POOL` (67M) is treated as staked from initialization
- Rewards are calculated proportionally: `user_reward = (user_staked / daily_snapshot_total) × daily_reward`
- Rewards accumulate across all 20 days and are paid out on unstake
- `calculate_rewards(day)` lets users preview rewards for any day
- For future days, the last snapshot value is used for estimates
- When users unstake early, their portion is redistributed to remaining stakers (higher per-token reward)

### One-Way Unstake

- `unstake` is **permanent** — no re-entry
- Returns **accumulated staking rewards only** (airdrop tokens were already sent on claim)
- After the claim window (day 40+), users can still unstake but receive **0 rewards**
- `UserStake` account is closed (rent returned to user)
- `ClaimMarker` persists forever (prevents re-claiming)

### Pool Lifecycle

```
Day 0-20: Active staking period (snapshots + rewards accumulate)
  - Users claim airdrop (tokens sent to wallet immediately)
  - Anyone takes daily snapshots
  - Users can unstake anytime (receives accumulated rewards)
  - Admin can pause/unpause for emergencies

Day 0-39: Claim window (CLAIM_WINDOW_DAYS = 40)
  - Users can claim their airdrop via merkle proof
  - Claims after day 20 still earn full rewards (virtual staking from day 0)

Day 20-39: Post-staking, claims still open
  - No new snapshots (capped at 20 days)
  - Users can still claim and unstake with full accumulated rewards

Day 40+: Everything expires
  - Admin recovers all remaining tokens via recover_expired_rewards
  - Users can still unstake (0 rewards, but closes account and returns rent)
```

### Exit Windows

| Window | Period | Purpose |
|--------|--------|---------|
| **Staking** | Day 0-19 (20 days) | Snapshots taken, rewards accumulate. |
| **Claim window** | Day 0-39 (40 days) | Users claim airdrop and earn rewards from day 0. |
| **Post claim window** | Day 40+ | Admin recovers tokens. Users unstake with 0 rewards. |

### Emergency Pause

Admin can pause the pool at any time to block:
- `claim_airdrop` — new claims blocked
- `snapshot` — snapshots blocked

**Users can ALWAYS unstake** even when paused — this protects user funds.

## Architecture

### Accounts

**PoolState** (PDA: `["pool_state", mint]`)
- Admin, mint, token account references, merkle root
- `total_staked` — virtual staked amount (starts at `AIRDROP_POOL`, decreases on unstake)
- `daily_rewards[32]` — pre-computed reward curve (indices 0-19 used)
- `daily_snapshots[32]` — recorded total_staked per day
- `snapshot_count` — highest day snapshotted

**ClaimMarker** (PDA: `["claimed", pool_state, user]`)
- Permanent marker preventing re-claims (~0.001 SOL rent)
- Created on claim, never closed

**UserStake** (PDA: `["user_stake", pool_state, user]`)
- `staked_amount`, `owner`, `bump`
- Created on claim, **closed on unstake** (rent returned)

**Pool Token Account** (PDA: `["pool_token", pool_state]`)
- Self-authority token account holding pool tokens (staking rewards + unclaimed airdrop)

### Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize_pool(start_time, merkle_root, daily_rewards)` | admin | Creates pool with `total_staked = AIRDROP_POOL`, validates rewards sum |
| `claim_airdrop(amount, proof)` | user | Verifies proof, sends tokens to user, creates ClaimMarker + UserStake |
| `snapshot()` | anyone | Records daily total_staked (permissionless, backfills missing days) |
| `unstake()` | user | Exit: returns staking rewards (0 after day 40), closes UserStake |
| `pause_pool()` | admin | Emergency pause — blocks claims/snapshots |
| `unpause_pool()` | admin | Resume normal operations |
| `recover_expired_rewards()` | admin | After day 40: drains entire remaining balance |
| `calculate_rewards(day)` | none | View: logs user's reward for a specific day |

### Events

```rust
PoolInitialized { admin, token_mint, start_time }
AirdropClaimed { user, amount, claim_day }
SnapshotTaken { day, total_staked }
Unstaked { user, rewards }
PoolPausedEvent { admin }
PoolUnpausedEvent { admin }
TokensRecovered { amount }
```

## Project Structure

```
memeland-airdrop/
├── programs/memeland_airdrop/src/
│   └── lib.rs                                # Smart contract
├── target/idl/memeland_airdrop.json          # IDL
├── tests/memeland_bankrun_optimized.ts       # Test suite (bankrun)
├── scripts/
│   ├── build-merkle-tree.ts                  # CSV → merkle JSON
│   ├── initialize-pool.ts                    # Initialize + fund pool
│   ├── snapshot.ts                           # Daily snapshot caller
│   ├── claim.ts                              # Submit airdrop claim
│   ├── stats.ts                              # Pool statistics
│   ├── pause.ts                              # Pause/unpause pool
│   ├── unstake-preview.ts                    # Preview rewards before unstaking
│   ├── calculate-rewards.ts                  # Compute reward curve
│   ├── utils/rewards.ts                      # Shared reward computation
│   └── generate-keypairs.ts                  # Keypair generator
├── data/
│   ├── allowlist-example.csv                 # Example allowlist
│   └── devnet-airdrop.csv                    # Devnet test allowlist
├── keypairs/                                 # Program and admin keypairs
├── reports/                                  # Audit and review reports
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
| `anchor test` | Run test suite |
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

# Test
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

# 5. Initialize and fund (admin must have 200M $FIGHT tokens)
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
4. Contract verifies proof, sends airdrop tokens directly to user's wallet
5. A virtual staking record is created — rewards accrue from day 0
6. User can unstake anytime before day 40 to receive accumulated staking rewards
7. After day 40, user can still unstake to close their account (0 rewards)

## Admin Operations

### Daily Snapshot

The snapshot script is smart and idempotent:
- Detects the current program day
- Checks if snapshot already exists for today
- Only takes snapshot if missing
- Handles pool paused state

```bash
# Take today's snapshot (safe to run multiple times)
yarn snapshot:prod
```

Automate with cron (script handles idempotency):

```bash
# Run daily at 6 AM UTC - safe to run even if already taken
0 6 * * * cd /path/to/project && yarn snapshot:prod >> logs/snapshot.log 2>&1
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

### Recovery (After Day 40)

```typescript
// Recover all remaining tokens (drains entire balance)
await program.methods
  .recoverExpiredRewards()
  .accounts({
    admin: adminPubkey,
    poolState: poolStatePda,
    poolTokenAccount: poolTokenPda,
    adminTokenAccount: adminAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
```

## Program ID

```
AovZsuC2giiHcTZ7Rn2dz1rd89qB8pPkw1TBZRceQbqq
```

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | StartTimeInPast | Start time is in the past |
| 6001 | AirdropPoolExhausted | Airdrop pool (67M) fully claimed |
| 6002 | InvalidDailyRewards | Rewards don't sum to STAKING_POOL |
| 6003 | InvalidDailyRewardsOrder | Daily rewards must be ascending |
| 6004 | PoolPaused | Pool is paused — operations disabled |
| 6005 | PoolNotPaused | Pool is not paused |
| 6006 | AlreadyPaused | Pool is already paused |
| 6007 | NothingStaked | No staked balance to unstake |
| 6008 | InvalidStakeOwner | UserStake owner mismatch |
| 6009 | UnauthorizedAdmin | Signer is not the pool admin |
| 6010 | Unauthorized | Generic access denied |
| 6011 | InvalidMerkleProof | Proof doesn't verify |
| 6012 | InvalidDay | Day out of range |
| 6013 | SnapshotRequiredFirst | Current day's snapshot missing |
| 6014 | InvalidPoolTokenAccount | Pool token account mismatch |
| 6015 | NothingToRecover | No tokens to recover |
| 6016 | PoolNotStartedYet | Pool not started yet |
| 6017 | StakingPeriodEnded | Staking period ended — no more claims |
| 6018 | ClaimWindowStillOpen | Must wait until day 40 to recover |

## Constants

```rust
TOTAL_DAYS = 20                       // Staking/snapshot period (20 days of rewards)
CLAIM_WINDOW_DAYS = 40                // Claim window — claims, rewards, and admin ops all pivot on day 40
SECONDS_PER_DAY = 86400               // 24 hours
AIRDROP_POOL = 67M × 10⁹              // 67M tokens (9 decimals)
STAKING_POOL = 133M × 10⁹             // 133M tokens (9 decimals)
```

## Security

Key points:

- **Merkle claims**: Cryptographically verified, no admin signature needed
- **ClaimMarker**: Permanent account prevents double-claims (claim-unstake-reclaim attack blocked)
- **Snapshot protection**: Unstakes blocked until current day's snapshot is taken
- **Permissionless snapshots**: Anyone can call `snapshot()` to prevent admin griefing
- **Reward solvency**: Daily rewards sum validated to exactly STAKING_POOL; rewards can never exceed the funded amount
- **Virtual staking**: `total_staked` starts at `AIRDROP_POOL` and only decreases, ensuring consistent reward distribution. Since stakes are virtual (tokens sent to users on claim), `total_staked` represents no real token obligation
- **Full pool recovery**: After day 40, admin can drain the entire pool balance via `recover_expired_rewards` — no tokens are reserved for virtual stakes
- **Post-expiry unstake**: Users can always close their accounts (0 rewards after day 40), recovering rent
- **PDA security**: All accounts derived from program ID with centralized seeds
- **Overflow protection**: u128 intermediate math with checked operations
- **Emergency pause**: Admin can pause pool; users can always unstake (funds protected)
- **Division-by-zero guard**: Reward calculation skips days with zero snapshots

## License

ISC
