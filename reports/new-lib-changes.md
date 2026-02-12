# new_lib.rs — Detailed Change Description

## Overview

This document describes all changes applied to `programs/memeland_airdrop/src/new_lib.rs` relative to the last committed version. The changes adapt the on-chain logic to the new "claim-and-earn" business model where airdrop tokens are sent directly to users on claim (instead of being auto-staked), and `total_staked` becomes a virtual accounting value with no real token obligation.

---

## 1. `claim_airdrop` — Block claims after staking period (F-03)

**Lines affected:** ~113–117

Added a `require!` that rejects claims after day 20:

```rust
require!(current_day < TOTAL_DAYS, ErrorCode::StakingPeriodEnded);
```

**Rationale:** Without this guard, a user could claim their airdrop on day 25+ and create a virtual stake that would distort snapshots and reward distribution for all other stakers. The docstring was also updated from "Tokens are auto-staked" to "Tokens are sent directly to user wallet".

---

## 2. `unstake` — Allow post-expiration unstake with 0 rewards (F-01)

**Lines affected:** ~238–295

**Before:** A hard `require!(!is_expired(...))` completely **blocked** unstaking after day 35 (reward exit window). Users who missed the window lost access to closing their stake account permanently.

**After:** Replaced the hard block with conditional reward logic:

```rust
let rewards = if expired {
    0  // After reward window: user can still close stake but receives 0 rewards
} else {
    // Before window: verify snapshot and calculate rewards normally
    let current_day = get_current_day(pool.start_time, clock.unix_timestamp);
    require!(pool.snapshot_count >= current_day as u8, ErrorCode::SnapshotRequiredFirst);
    calculate_user_rewards(...)
};
```

The token transfer is also wrapped in `if rewards > 0` to skip a zero-amount SPL transfer.

**Rationale:** In the new model, airdrop tokens were already sent to the user on claim. Unstake only returns staking rewards. If a user misses the reward window, they forfeit rewards but can still close their account (recovering rent). The snapshot check is also skipped for expired unstakes since reward calculation is not needed.

---

## 3. `terminate_pool` — Fix reserve calculation (F-04)

**Lines affected:** ~320–326

**Before:**
```rust
let reserved = (pool.total_staked).saturating_add(max_remaining_rewards);
let drainable = pool_balance.saturating_sub(reserved);
```
Reserved `total_staked + STAKING_POOL`, which was excessive because `total_staked` is virtual — airdrop tokens were already sent to users on claim. This over-reservation could prevent the admin from draining any surplus.

**After:**
```rust
let drainable = pool_balance.saturating_sub(max_remaining_rewards);
```
Only reserves `STAKING_POOL` (133M) to cover pending reward payouts. No longer reserves `total_staked` since there is no real obligation to return principal from the pool.

---

## 4. `recover_expired_rewards` — Drain entire pool balance (F-01)

**Lines affected:** ~383–415

**Before:**
```rust
let amount = pool_balance.saturating_sub(pool.total_staked);
require!(amount > 0, ErrorCode::NothingToRecover);
```
Protected `total_staked` worth of tokens as if they were real funds owed to users.

**After:**
```rust
let pool_balance = ctx.accounts.pool_token_account.amount;
require!(pool_balance > 0, ErrorCode::NothingToRecover);
let amount = pool_balance;
```
Drains the **entire** pool balance. Since `total_staked` is virtual (airdrop tokens were sent directly to users on claim), there is no real token obligation in the pool. After the reward exit window (day 35+), all remaining tokens are surplus.

The docstring was updated to explain: "total_staked represents no real token obligation — the entire balance can be drained."

---

## 5. `calculate_user_rewards` — Guard against division by zero (F-02)

**Lines affected:** ~553–564

**Before:**
```rust
/ daily_snapshots[d] as u128;
```
No protection if `daily_snapshots[d] == 0`, causing a **panic from division by zero**.

**After:**
```rust
let snapshot_total = daily_snapshots[d];
if snapshot_total == 0 {
    continue;
}
// ... / snapshot_total as u128;
```

**Rationale:** If a day has a snapshot value of 0 (theoretical edge case, e.g., pool initialized before any claims), the program would crash. Now it cleanly skips that day with zero contribution to rewards.

---

## 6. `Unstake` context — Updated docstring

**Line:** ~710

```rust
// Before: "User's token account to receive principal + rewards"
// After:  "User's token account to receive staking rewards"
```

Reflects that unstake only sends rewards. The airdrop (principal) was already sent to the user's wallet on claim.

---

## 7. Error codes — Removed and added

**Removed:**
```rust
#[msg("Reward has expired - unstakes are no longer accepted")]
RewardExpired,
```
No longer used because post-expiration unstaking is now allowed (with 0 rewards).

**Added:**
```rust
#[msg("Staking period has ended - claims are no longer accepted")]
StakingPeriodEnded,
```
New error code to block claims after day 20 (end of staking period).

---

## Impact Summary

| Fix | Severity | What it resolves |
|-----|----------|------------------|
| F-01 (unstake) | **High** | Users are no longer permanently locked out after day 35 |
| F-01 (recover) | **High** | Admin can recover all remaining tokens (virtual stakes carry no real obligation) |
| F-02 | **Medium** | Prevents panic from division by zero in reward calculation |
| F-03 | **Medium** | Prevents claims after the staking period ends (day 20+) |
| F-04 | **Medium** | `terminate_pool` no longer over-reserves tokens for virtual stakes |
| F-05 | **Low** | Docstrings and error codes consistent with the new claim-and-earn model |
