# Memeland $FIGHT Airdrop & 20-Day Exponential Staking Program

A Solana smart contract that distributes 150,000,000 $FIGHT tokens through a combined airdrop and staking mechanism over 20 days.

## Token Distribution

| Pool | Amount | Share |
|------|--------|-------|
| Airdrop (pre-staked) | 50,000,000 | 1/3 |
| Staking rewards | 100,000,000 | 2/3 |
| **Total** | **150,000,000** | |

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
7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV,1000000.000000
BLDpSMCi4FUYcY3sMfZRjcMTSqRTkGFB5gVH8GhnBi3P,2500000.000000
```

A build script computes the merkle tree and outputs a JSON file with the root and per-user proofs:

```bash
yarn build-merkle data/allowlist.csv
```

This produces a JSON file containing:
- `merkleRoot` — pass to `initialize_pool` at launch
- `claims[wallet].proof` — each user submits this when calling `claim_airdrop`

The contract verifies on-chain that `keccak256(wallet + amount)` hashes up to the stored root via the proof. Users cannot claim amounts they weren't assigned, and they cannot claim without a valid proof.

### Exponential Emission Curve
Daily staking rewards follow an exponential curve over 20 days:

```
R(d) = R₁ × e^(k × (d - 1))    where k ≈ 0.05
```

- Day 1: ~3.5M tokens
- Day 20: ~9.1M tokens (~2.6x day 1)
- Last 5 days emit ~35%+ of total staking rewards
- Rewards are pre-computed on-chain during pool initialization

### Daily Snapshots
- An admin calls `snapshot()` once per day between **12:00–12:05 AM UTC**
- Each snapshot records the current `total_staked` for that day
- This determines how the day's reward pool is split among stakers
- Up to 20 snapshots (one per day of the program)

### Reward Accumulation & Pro-Rata Distribution
- Rewards are **not distributed daily** — they accumulate
- For each day, a user's share is: `(user_staked / daily_snapshot_total) × daily_reward`
- On unstake, all accumulated rewards across all completed days are paid out at once
- `calculate_rewards(day)` lets users preview their reward for any given day
- For future days (not yet snapshotted), the last known snapshot total is used

### One-Way Unstake
- Calling `unstake` is **permanent** — there is no re-entry
- On unstake, users receive their original staked tokens plus all accumulated rewards
- Unstaked users cannot re-claim or re-stake
- Unstaking is blocked during the snapshot window (12:00–12:05 AM UTC)

### Terminate Pool
- Admin can call `terminate_pool` to permanently stop the program
- Blocked claims: no new airdrops can be claimed after termination
- Existing stakers can still unstake and receive their principal + accrued rewards
- Remaining pool tokens are transferred to the admin

## Architecture

### Accounts

**PoolState** (zero-copy, PDA seeded by `["pool_state", mint]`)
- Stores admin, mint, token account references, merkle root
- Pre-computed `daily_rewards[32]` array (indices 0–19 used)
- `daily_snapshots[32]` array recording total_staked per day

**UserStake** (PDA seeded by `["user_stake", pool_state, user]`)
- Tracks staked amount, claim day (day user joined)
- Flags: `has_claimed_airdrop`, `has_unstaked`

**Pool Token Account** (PDA seeded by `["pool_token", pool_state]`)
- PDA-authority token account holding all pool tokens (150M)

### Instructions

| Instruction | Signer(s) | Description |
|-------------|-----------|-------------|
| `initialize_pool(start_time, merkle_root)` | admin | Creates pool, stores merkle root, pre-computes exponential curve |
| `claim_airdrop(amount, proof)` | user | Verifies merkle proof, claims airdrop, auto-stakes tokens |
| `snapshot()` | admin | Records daily total_staked (12:00–12:05 AM UTC only) |
| `unstake()` | user | Permanent exit: returns stake + all accumulated rewards |
| `terminate_pool()` | admin | Stops claims, transfers remaining tokens to admin |
| `calculate_rewards(day)` | none | View function: logs user's reward for a specific day |

## Project Structure

```
memeland-airdrop/
├── programs/memeland_airdrop/src/lib.rs   # Smart contract
├── target/idl/memeland_airdrop.json       # IDL (manually maintained)
├── tests/memeland_airdrop.ts              # Test suite (22 tests)
├── scripts/
│   ├── build-merkle-tree.ts               # CSV → merkle root + proofs JSON
│   ├── initialize-pool.ts                 # Initialize pool + fund 150M tokens
│   ├── snapshot.ts                        # Daily snapshot caller
│   └── generate-keypairs.ts               # Keypair generator for devnet
├── data/
│   ├── allowlist-example.csv              # Example allowlist (8 wallets)
│   └── allowlist-example-merkle.json      # Generated merkle output
├── .env.local                             # Local validator config
├── .env.testnet                           # Devnet config
├── .env.prod                              # Mainnet config
└── Anchor.toml                            # Anchor configuration
```

## Scripts

| Command | Description |
|---------|-------------|
| `yarn build-merkle <csv>` | Build merkle tree from allowlist CSV |
| `yarn generate-keypairs` | Generate admin + token-mint keypairs for devnet |
| `yarn init-pool:devnet` | Initialize pool + fund 150M on devnet |
| `yarn init-pool:prod` | Initialize pool + fund 150M on mainnet |
| `yarn snapshot:devnet` | Take daily snapshot on devnet |
| `yarn snapshot:prod` | Take daily snapshot on mainnet |
| `anchor test --skip-build` | Run test suite (22 tests) |
| `anchor build --no-idl` | Build the program |

## Environment Variables

All `.env` files support these variables:

| Variable | Description |
|----------|-------------|
| `ANCHOR_PROVIDER_URL` | Solana RPC endpoint |
| `ANCHOR_WALLET` | Path to admin keypair JSON |
| `PROGRAM_ID` | Deployed program address |
| `TOKEN_MINT` | $FIGHT token mint address |
| `MERKLE_JSON` | Path to merkle tree JSON |
| `START_TIME` | (optional) Unix timestamp for pool start, defaults to now |

The mainnet $FIGHT token mint is `8f62NyJGo7He5uWeveTA2JJQf4xzf8aqxkmzxRQ3mxfU`.

## Prerequisites

- Rust (1.84+ for SBF target)
- [Solana CLI](https://docs.solanalabs.com/cli/install) (v2+)
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) (0.30.1)
- Node.js 18+ and Yarn

## Build

```bash
anchor build --no-idl
```

> The `--no-idl` flag is required because IDL auto-generation has a compatibility issue with the current proc-macro2 version. The IDL at `target/idl/memeland_airdrop.json` is maintained manually.

## Build Merkle Tree

1. Create your allowlist CSV (see `data/allowlist-example.csv` for format):

```csv
wallet,amount
7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV,1000000.000000
```

2. Generate the merkle tree:

```bash
yarn build-merkle data/allowlist.csv                    # outputs data/allowlist-merkle.json
yarn build-merkle data/allowlist.csv data/output.json   # custom output path
```

3. The output JSON contains:
   - `merkleRoot` — array of 32 bytes, pass to `initialize_pool`
   - `claims[wallet].proof` — array of 32-byte arrays, user submits with `claim_airdrop`
   - `claims[wallet].amountRaw` — raw token amount in lamports

The script validates wallet addresses, rejects duplicates, and converts human-readable amounts (6 decimals) to raw lamports.

## Test

Run the full test suite against a local validator:

```bash
anchor test --skip-build
```

This starts a local Solana validator, deploys the program, and runs all 22 tests covering:
- Pool initialization and exponential curve verification
- Pool funding (150M tokens)
- Airdrop claiming (auto-stake, double-claim prevention, merkle proof verification)
- Daily snapshots (admin-only, time-window enforcement)
- Unstaking (permanent exit, principal + accumulated rewards)
- Exponential curve validation (day 20 > day 1, last-5-day concentration, monotonicity)
- Terminate pool (admin terminate, double-terminate rejection, claims blocked)
- Multi-user pro-rata rewards (3:1 stake ratio → 3:1 reward ratio)
- calculate_rewards view function (valid day, invalid day rejection)

To rebuild and test:

```bash
source ~/.nvm/nvm.sh && nvm use 20 && PATH="$HOME/.cargo/bin:$PATH" anchor test --skip-build
```
```bash
anchor build --no-idl && anchor test --skip-build
```

## Deploy & Initialize

### Devnet

1. Generate keypairs:

```bash
yarn generate-keypairs
```

2. Fund the admin wallet via faucet:

```bash
solana airdrop 2 <ADMIN_PUBKEY> --url devnet
```

3. Create a devnet $FIGHT token, mint 150M to the admin wallet, and set `TOKEN_MINT` in `.env.testnet`.

4. Build your allowlist and generate the merkle tree:

```bash
yarn build-merkle data/allowlist.csv
```

5. Deploy the program:

```bash
anchor deploy --provider.cluster devnet --provider.wallet ./keypairs/admin.json
```

6. Initialize pool and fund with 150M tokens:

```bash
yarn init-pool:devnet
```

This single command reads the merkle root from the JSON, calls `initialize_pool`, and transfers 150M tokens from the admin's ATA to the pool.

### Mainnet

1. Set `ANCHOR_WALLET` in `.env.prod` to your admin keypair path
2. Ensure the admin wallet has enough SOL for rent + tx fees
3. Ensure the admin wallet holds 150M $FIGHT tokens
4. Build the merkle tree from your production allowlist
5. Deploy:

```bash
anchor deploy --provider.cluster mainnet --provider.wallet /path/to/admin.json
```

6. Initialize and fund:

```bash
yarn init-pool:prod
```

> The `initialize_pool` instruction requires ~400k+ compute units due to on-chain exponential computation. The script automatically sets a 1M CU budget.

## Claiming (User Flow)

1. User connects wallet to your frontend
2. Frontend looks up the user's entry in the merkle JSON (`claims[wallet]`)
3. Frontend calls `claim_airdrop(amountRaw, proof)` — only the user signs
4. Contract verifies the proof against the on-chain merkle root
5. Tokens are auto-staked and begin earning rewards immediately

No backend, no admin signature, no centralized dependency after launch.

## Admin Operations

### Daily Snapshot

Call `snapshot()` once per day between 12:00–12:05 AM UTC:

```bash
yarn snapshot:prod
```

This records the current total staked amount for reward calculations. Automate with cron:

```bash
# Run at midnight UTC every day
0 0 * * * cd /path/to/memeland-airdrop && yarn snapshot:prod >> logs/snapshot.log 2>&1
```

### Termination

Call `terminate_pool()` to permanently end the program. Existing stakers retain their principal and accrued rewards. Remaining tokens are returned to the admin.

## Program ID

```
Abp5pKfeUysdsxZULSDSRxkG2v66gLPn6c1Yu1Zuk9jT
```

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | ProgramEnded | Current time is past the 20-day window |
| 6001 | AlreadyClaimed | Wallet has already claimed the airdrop |
| 6002 | PermanentlyExited | User has unstaked and cannot interact further |
| 6003 | AirdropPoolExhausted | Airdrop pool (50M) has been fully claimed |
| 6004 | NothingStaked | User has no staked balance to unstake |
| 6005 | Unauthorized | Admin key mismatch or invalid signer |
| 6006 | InvalidMerkleProof | Merkle proof does not verify against stored root |
| 6007 | PoolTerminated | Pool has been terminated by admin |
| 6008 | AlreadyTerminated | Pool is already terminated |
| 6009 | AllSnapshotsTaken | All 20 daily snapshots have been recorded |
| 6010 | SnapshotTooEarly | Day has not yet elapsed since last snapshot |
| 6011 | OutsideSnapshotWindow | Not within 12:00–12:05 AM UTC window |
| 6012 | UnstakeBlockedDuringSnapshot | Cannot unstake during snapshot window |
| 6013 | InvalidDay | Day parameter is out of range (must be 0–19) |
