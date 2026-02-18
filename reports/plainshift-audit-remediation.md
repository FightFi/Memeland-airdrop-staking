# Plainshift Audit Remediation Report

**Audit:** Plainshift Fight Airdrop Audit
**Audit Date:** February 14–15, 2026
**Remediation Date:** February 15, 2026
**Commit Under Audit:** `83c588b45f66c8d1a84f56ac032094c581abc3dc`
**Target:** `programs/memeland_airdrop/src/lib.rs`

---

## Summary

All 9 findings (0 high, 2 medium, 2 low, 5 informational) from the Plainshift audit have been resolved. This document details each finding and the corresponding code change.

| ID   | Severity      | Title                                                         | Status   |
|------|---------------|---------------------------------------------------------------|----------|
| M-1  | Medium        | Token mint decimals not validated at pool initialization      | Resolved |
| M-2  | Medium        | Merkle allowlist total not enforced on-chain                  | Resolved |
| L-1  | Low           | Claim start-time boundary excludes exact start timestamp      | Resolved |
| L-2  | Low           | Zero-amount claims can create non-exitable user stake accounts| Resolved |
| I-1  | Informational | Merkle proof length is unbounded in claim path                | Resolved |
| I-2  | Informational | Error naming implies staking-period end while check uses claim window | Resolved |
| I-3  | Informational | Snapshot gating comment does not match claim behavior         | Resolved |
| I-4  | Informational | NothingToRecover message is inconsistent with recovery logic  | Resolved |
| I-5  | Informational | Misconfigured far-future start time can lock funded vault     | Resolved |

---

## Finding Details

### [M-1] Token mint decimals not validated at pool initialization

**Severity:** Medium
**Category:** Missing Validation

**Problem:** `initialize_pool()` accepted any SPL mint without validating `token_mint.decimals == 9`. Pool constants (`AIRDROP_POOL`, `STAKING_POOL`) assume 9-decimal tokens, so using a different mint breaks economic semantics.

**Fix:** Added a `require!` check at the top of `initialize_pool()`:

```rust
require!(
    ctx.accounts.token_mint.decimals == 9,
    ErrorCode::InvalidMintDecimals
);
```

**New error code:**
```rust
#[msg("Invalid mint decimals - expected 9")]
InvalidMintDecimals,
```

**Files changed:** `programs/memeland_airdrop/src/lib.rs`

---

### [M-2] Merkle allowlist total not enforced on-chain

**Severity:** Medium
**Category:** Configuration Error

**Problem:** The invariant `sum(allowlist) == AIRDROP_POOL` was only validated in off-chain scripts, not by the on-chain program. If deployment skipped the validation script, the Merkle root would be accepted regardless.

**Fix:** Added `allowlist_total_raw: u64` as a new parameter to `initialize_pool()`. The program enforces equality with `AIRDROP_POOL` and stores the value in `PoolState`:

```rust
pub fn initialize_pool(
    ctx: Context<InitializePool>,
    start_time: i64,
    merkle_root: [u8; 32],
    allowlist_total_raw: u64,       // NEW
    daily_rewards: [u64; 20],
) -> Result<()> {
    // ...
    require!(allowlist_total_raw == AIRDROP_POOL, ErrorCode::InvalidAllowlistTotal);
    pool.allowlist_total_raw = allowlist_total_raw;
    pool.total_staked = allowlist_total_raw;
```

**New error code:**
```rust
#[msg("Allowlist total does not match expected airdrop pool")]
InvalidAllowlistTotal,
```

**New state field:**
```rust
pub allowlist_total_raw: u64,   // 8 bytes added to PoolState
```

**Files changed:** `programs/memeland_airdrop/src/lib.rs`, `scripts/initialize-pool.ts`, `tests/memeland_bankrun_optimized.ts`

---

### [L-1] Claim start-time boundary excludes exact start timestamp

**Severity:** Low
**Category:** Edge Case

**Problem:** `claim_airdrop()` used strict `>` comparison (`clock.unix_timestamp > pool.start_time`), causing transactions at the exact start timestamp to fail.

**Fix:** Changed to inclusive comparison:

```rust
// Before
require!(clock.unix_timestamp > pool.start_time, ErrorCode::PoolNotStartedYet);

// After
require!(clock.unix_timestamp >= pool.start_time, ErrorCode::PoolNotStartedYet);
```

**Files changed:** `programs/memeland_airdrop/src/lib.rs`

---

### [L-2] Zero-amount claims can create non-exitable user stake accounts

**Severity:** Low
**Category:** Input Validation

**Problem:** `claim_airdrop()` did not reject `amount == 0`. A zero-amount Merkle leaf could create `UserStake` with `staked_amount = 0`, which `unstake()` then rejects via `require!(user_stake.staked_amount > 0, ...)`.

**Fix:** Added zero-amount guard at the top of `claim_airdrop()`:

```rust
require!(amount > 0, ErrorCode::InvalidClaimAmount);
```

**New error code:**
```rust
#[msg("Claim amount must be greater than zero")]
InvalidClaimAmount,
```

**Files changed:** `programs/memeland_airdrop/src/lib.rs`

---

### [I-1] Merkle proof length is unbounded in claim path

**Severity:** Informational
**Category:** Input Validation

**Problem:** `claim_airdrop()` accepted `proof: Vec<[u8; 32]>` with no depth bound, allowing oversized proof vectors to waste compute.

**Fix:** Added max depth check (20 levels supports > 1M leaves):

```rust
require!(proof.len() <= 20, ErrorCode::ProofTooLong);
```

**New error code:**
```rust
#[msg("Merkle proof exceeds maximum depth")]
ProofTooLong,
```

**Files changed:** `programs/memeland_airdrop/src/lib.rs`

---

### [I-2] Error naming implies staking-period end while check uses claim window

**Severity:** Informational
**Category:** Code Quality

**Problem:** `claim_airdrop()` enforced `current_day < CLAIM_WINDOW_DAYS` but returned `StakingPeriodEnded`. Staking period (`TOTAL_DAYS = 20`) and claim window (`CLAIM_WINDOW_DAYS = 40`) are distinct concepts.

**Fix:** Renamed error variant and updated message:

```rust
// Before
#[msg("Staking period has ended - claims are no longer accepted")]
StakingPeriodEnded,

// After
#[msg("Claim window has ended - claims are no longer accepted")]
ClaimWindowEnded,
```

**Files changed:** `programs/memeland_airdrop/src/lib.rs`, `scripts/claim.ts`, `tests/memeland_bankrun_optimized.ts`

---

### [I-3] Snapshot gating comment does not match claim behavior

**Severity:** Informational
**Category:** Code Quality

**Problem:** The `snapshot()` doc comment stated "Claims/unstakes are blocked until the previous day's snapshot is taken," but only `unstake()` enforces snapshot freshness — `claim_airdrop()` does not.

**Fix:** Updated comment to match actual behavior:

```rust
// Before
/// Claims/unstakes are blocked until the previous day's snapshot is taken.

// After
/// Unstakes are blocked until the previous day's snapshot is taken.
```

**Files changed:** `programs/memeland_airdrop/src/lib.rs`

---

### [I-4] NothingToRecover message is inconsistent with recovery logic

**Severity:** Informational
**Category:** Code Quality

**Problem:** `NothingToRecover` error message said "pool balance equals staked amount," but the logic simply checks `pool_balance > 0` and drains the full balance.

**Fix:** Updated error message to match implemented semantics:

```rust
// Before
#[msg("No tokens to recover - pool balance equals staked amount")]

// After
#[msg("No tokens to recover - pool balance is zero")]
```

**Files changed:** `programs/memeland_airdrop/src/lib.rs`

---

### [I-5] Misconfigured far-future start time can lock funded vault

**Severity:** Informational
**Category:** Configuration Error

**Problem:** `initialize_pool()` stores `start_time` immutably. If funded with a far-future timestamp (e.g., unit mismatch), tokens are locked until the claim window ends — there was no way to cancel.

**Fix:** Added `cancel_pool_before_start` instruction that allows admin to recover all funded tokens before the pool starts:

```rust
pub fn cancel_pool_before_start(ctx: Context<CancelPoolBeforeStart>) -> Result<()> {
    let clock = Clock::get()?;
    require!(clock.unix_timestamp < pool.start_time, ErrorCode::PoolAlreadyStarted);
    // transfer vault balance back to admin via PDA signer
    ...
}
```

**New accounts struct:** `CancelPoolBeforeStart` (admin-only, mirrors `RecoverExpiredRewards` structure)

**New error code:**
```rust
#[msg("Pool has already started - cannot cancel")]
PoolAlreadyStarted,
```

**Files changed:** `programs/memeland_airdrop/src/lib.rs`

---

## Build Verification

The program compiles successfully after all changes:

```
anchor build
   Compiling memeland_airdrop v0.1.0
    Finished `release` profile [optimized] target(s)
```

## State Layout Change

`PoolState` gained one new field (`allowlist_total_raw: u64`, 8 bytes). This is a **breaking change** for any existing deployed pools — new deployments only.
