# Code Review Report: `new_lib.rs` — Proposed Business Logic Changes

**Program ID:** `4uxX6uS3V9pyP3ei8NWZzz6RsqSddEhwosSqLD3ZbsVs`
**Date:** 2026-02-11
**Reviewer:** Claude Opus 4.6
**Scope:** Full review of `new_lib.rs` against current `lib.rs`
**Branch:** `refactor/memeland-changes`

---

## 1. Executive Summary

The proposed `new_lib.rs` fundamentally changes the business model from an **auto-staking airdrop** to a **claim-and-earn** model. Users now receive their airdrop tokens immediately upon claim while simultaneously being enrolled in a virtual staking pool for reward accrual.

**Verdict: NOT READY TO APPLY.** The new code contains **2 critical bugs**, **1 medium bug**, and **3 low-severity issues** that must be addressed. Most notably, a **token-stranding bug** makes it impossible to close the pool if any user fails to unstake before day 35, permanently locking tokens on-chain.

---

## 2. Business Model Comparison

| Aspect | Current (`lib.rs`) | Proposed (`new_lib.rs`) |
|--------|---------------------|--------------------------|
| **Claim action** | Tokens locked in pool (auto-stake) | Tokens sent directly to user wallet |
| **Rewards accumulate from** | User's `claim_day` | Day 0 (all users, retroactively) |
| **Unstake pays** | Principal + accumulated rewards | Rewards only (principal already received) |
| **Unstake after expiry** | Allowed (0 rewards, principal returned) | **BLOCKED entirely** |
| **Exit window** | Single: 15 days (day 35 total) | Dual: rewards day 35, pool close day 55 |
| **`total_staked` at init** | 0 (grows with each claim) | `AIRDROP_POOL` (67M, fixed from start) |
| **Snapshot dependency for claims** | Required (blocks if missing) | Removed |
| **Claim time limit** | Blocked after program expiry | No expiry check |
| **`UserStake.claim_day`** | Stored, used for reward calc | Removed entirely |

### New User Flow

```
Day 0:    Admin initializes pool
          total_staked = AIRDROP_POOL (67M)
          Pool funded with 200M tokens (67M airdrop + 133M staking)

Day 0+:   User claims via merkle proof
          -> 67M airdrop tokens transferred to user wallets immediately
          -> UserStake created (virtual stake record)
          -> ClaimMarker created (anti-replay)

Day 1-20: Daily snapshots record total_staked
          Rewards accrue for all virtual stakers

Day 0-35: User calls unstake
          -> Receives accumulated rewards only (days 0 to current_day)
          -> UserStake closed, rent returned

Day 35+:  Admin calls recover_expired_rewards
          -> Drains unclaimed rewards (leaves total_staked worth of tokens)

Day 55+:  Admin calls close_pool
          -> ⚠️ FAILS if pool token account has non-zero balance (see F-01)
```

### Economic Implications

**All users receive the same reward rate per token, regardless of claim timing.** A user who claims on day 19 gets identical rewards (days 0-19) as one who claimed on day 0. This works because `total_staked` includes all allocations from initialization:

```
User reward for day D = (user_staked_amount / daily_snapshot[D]) * daily_rewards[D]
```

Since `daily_snapshot[D]` starts at `AIRDROP_POOL` and only decreases as users unstake, late claimers are not penalized. Early unstakers increase the per-token reward for remaining stakers.

---

## 3. Change-by-Change Analysis

### 3.1 Constants: Dual Exit Windows

**`new_lib.rs:11-12`**
```diff
-pub const EXIT_WINDOW_DAYS: u64 = 15;
+pub const REWARD_EXIT_WINDOW_DAYS: u64 = 15;
+pub const AIRDROP_EXIT_WINDOW_DAYS: u64 = 35;
```

**Assessment: GOOD.** Separating exit windows is the correct approach for the new model.

### 3.2 Initialize: `total_staked = AIRDROP_POOL`

**`new_lib.rs:58`**
```diff
-pool.total_staked = 0;
+pool.total_staked = AIRDROP_POOL;
```

**Assessment: CORRECT.** All airdrop allocations are "virtually staked" from day 0. Snapshots will always record this as the baseline denominator for reward calculations.

### 3.3 Initialize: Refactored Daily Rewards Loop

**`new_lib.rs:68-78`**
```rust
let mut sum: u64 = daily_rewards[0];
pool.daily_rewards[0] = daily_rewards[0];
for d in 1..20usize {
    require!(daily_rewards[d] >= daily_rewards[d - 1], ErrorCode::InvalidDailyRewardsOrder);
    sum = sum.checked_add(daily_rewards[d]).unwrap();
    pool.daily_rewards[d] = daily_rewards[d];
}
```

**Assessment: CORRECT.** Functionally equivalent to the old loop. Slightly cleaner by extracting index 0 and starting the comparison loop at 1.

### 3.4 Claim: Direct Token Transfer + Remove Snapshot Gate

**`new_lib.rs:97-165`**

Key changes:
- Removed `program_expired` check
- Removed snapshot gating (`SnapshotRequiredFirst` for claims)
- Added `transfer_from_pool_pda(...)` to send tokens to user
- Added `pool_token_account`, `user_token_account`, `token_program` to `ClaimAirdrop` context
- Removed `user_stake.claim_day = current_day`
- Removed `pool.total_staked += amount` (already pre-set)

**Assessment: PARTIALLY CORRECT.** The token transfer and snapshot removal are correct for the new model. However, the removal of the expiry check creates an issue (see F-03).

### 3.5 Unstake: Rewards Only + Hard Block After Expiry

**`new_lib.rs:240-301`**

Key changes:
- Added hard block: `require!(!is_expired(..., REWARD_EXIT_WINDOW_DAYS, ...), RewardExpired)`
- Removed conditional snapshot check (now unconditional — functionally equivalent since u8 >= 0)
- Reward calculation: `calculate_user_rewards(staked_amount, current_day, ...)` — from day 0
- Transfers only `rewards` (not principal + rewards)
- Removed `principal` from `Unstaked` event

**Assessment: CONTAINS BUG (see F-01).** The hard block prevents unstake entirely after day 35, unlike the old code which allowed unstake with 0 rewards. This creates the stranded tokens problem.

### 3.6 Snapshot: No Semantic Changes

**`new_lib.rs:171-234`**

Only formatting changes. Logic is identical.

### 3.7 Reward Calculation: Start from Day 0

**`new_lib.rs:542-560`**

```diff
-fn calculate_user_rewards(staked_amount, claim_day, snapshot_count, daily_rewards, daily_snapshots)
-    for d in claim_day..snapshot_count:
-        if daily_snapshots[d] == 0 { continue; }
-        user_share = staked_amount * daily_rewards[d] / daily_snapshots[d]
+fn calculate_user_rewards(staked_amount, current_day, daily_rewards, daily_snapshots)
+    for d in 0..current_day:
+        user_share = staked_amount * daily_rewards[d] / daily_snapshots[d]  // NO zero guard!
```

**Assessment: CONTAINS BUG (see F-02).** Logic change is correct for the new model, but the removal of the `snapshot == 0` defensive guard is dangerous.

### 3.8 Helper: `transfer_from_pool_pda`

**`new_lib.rs:501-526`**

**Assessment: EXCELLENT.** Consolidates 4 identical PDA transfer blocks into one reusable function. Reduces ~60 lines of duplication. Signer seeds are identical to all previous usages.

### 3.9 Helper Renames

**`new_lib.rs:576-583`**

```diff
-pub fn exit_deadline(start_time: i64) -> i64
+pub fn exit_deadline(start_time: i64, exit_window_days: u64) -> i64

-pub fn program_expired(start_time: i64, now: i64) -> bool
+pub fn is_expired(start_time: i64, exit_window_days: u64, now: i64) -> bool
```

**Assessment: GOOD.** Parameterized design enables the dual-window model cleanly.

### 3.10 Other: terminate_pool, recover_expired_rewards, close_pool

- `terminate_pool`: Refactored to use `transfer_from_pool_pda` helper. Logic unchanged.
- `recover_expired_rewards`: Renamed from `recover_expired_tokens`. Uses `REWARD_EXIT_WINDOW_DAYS`. Logic unchanged.
- `close_pool`: Now uses `exit_deadline(start, AIRDROP_EXIT_WINDOW_DAYS)` — day 55 instead of day 35.

### 3.11 Account Structs & State

- `ClaimAirdrop` context: Added `pool_token_account`, `user_token_account`, `token_program` — properly constrained.
- `UserStake`: Removed `claim_day` field. Size changes from 49 to 41 bytes (**breaking change** for existing accounts).
- `RecoverExpiredTokens` renamed to `RecoverExpiredRewards`.
- Error codes: `ProgramExpired` → `RewardExpired`, `ExitWindowNotFinished` → `RewardExitWindowNotFinished`.

### 3.12 Stale Documentation

**`new_lib.rs:95-96`**
```rust
/// Claim airdrop via merkle proof. Tokens are auto-staked.
/// Creates a permanent ClaimMarker (prevents re-claims) and a UserStake (closed on unstake).
```

**Assessment: STALE.** Tokens are no longer auto-staked — they're sent to the user. The comment should say "Tokens are sent to user wallet".

---

## 4. Findings

### F-01 [CRITICAL] — Stranded Tokens Prevent Pool Closure

**Location:** `unstake` (`new_lib.rs:246-253`), `recover_expired_rewards` (`new_lib.rs:399-400`), `close_pool` (`new_lib.rs:452`)

**Description:** After day 35, the `unstake` instruction is completely blocked by `RewardExpired`. This means that for any user who doesn't unstake before day 35:

1. Their `staked_amount` portion of `total_staked` is **never decremented**
2. `recover_expired_rewards` can only drain `pool_balance - total_staked`, leaving `total_staked` worth of tokens in the pool
3. No other instruction can drain below `total_staked`
4. `close_pool` calls SPL `close_account`, which **requires 0 token balance** — it will **always fail** if tokens remain

**Detailed trace for a scenario where 50% of users don't unstake:**

```
Init:                   pool_balance = 200M, total_staked = 67M
All claims:             pool_balance = 133M, total_staked = 67M
50% unstake (day <35):  pool_balance = 133M - rewards_paid ≈ 70M, total_staked = 33.5M
Day 35 recovery:        admin drains 70M - 33.5M = 36.5M → pool_balance = 33.5M
Day 55 close_pool:      SPL close_account FAILS — 33.5M tokens still in account!

Result: 33.5M tokens permanently locked on-chain. No instruction can extract them.
```

**Root cause:** In the old code, users could unstake after expiry with 0 rewards (getting principal back), which drained the pool. The new code blocks unstake entirely, but doesn't provide an alternative path to drain the corresponding tokens.

**Impact:** Potentially millions of dollars in tokens permanently locked on-chain. Pool can never be fully closed.

**Recommendation:** Allow unstake after expiry with 0 rewards (matching old behavior):
```rust
// In unstake(), replace the hard block:
let rewards = if is_expired(pool.start_time, REWARD_EXIT_WINDOW_DAYS, clock.unix_timestamp) {
    0
} else {
    // Block unstaking if previous day's snapshot hasn't been taken yet
    let current_day = get_current_day(pool.start_time, clock.unix_timestamp);
    require!(pool.snapshot_count >= current_day as u8, ErrorCode::SnapshotRequiredFirst);
    calculate_user_rewards(
        user_stake.staked_amount,
        current_day,
        &pool.daily_rewards,
        &pool.daily_snapshots,
    )
};
```

This resolves F-01, and also resolves orphaned `UserStake` accounts (users can close them anytime by calling unstake with 0 rewards after day 35). Since they already received their principal on claim, they only forfeit unclaimed staking rewards — which is the intended behavior.

---

### F-02 [CRITICAL] — Division by Zero in `calculate_user_rewards`

**Location:** `new_lib.rs:550-554`

```rust
for d in 0..(current_day as usize) {
    let user_share = (staked_amount as u128)
        .checked_mul(daily_rewards[d] as u128)
        .unwrap()
        / daily_snapshots[d] as u128;  // PANICS if snapshot == 0
```

**Description:** The original code had a defensive guard `if snapshot_total == 0 { continue; }` that was removed. If `daily_snapshots[d]` is 0, the program panics with a division-by-zero.

**Risk assessment:** In normal operation, snapshots start at `AIRDROP_POOL` (67M) and only decrease, making 0 unlikely. However:
- If ALL users unstake before a day's snapshot → `total_staked` = 0 → snapshot records 0
- Edge cases during testing or unusual unstake patterns could trigger it
- Removing a zero-cost defensive guard is unnecessary risk in a financial program

**Recommendation:** Restore the guard:
```rust
for d in 0..(current_day as usize) {
    if daily_snapshots[d] == 0 { continue; }
    let user_share = (staked_amount as u128)
        .checked_mul(daily_rewards[d] as u128)
        .unwrap()
        / daily_snapshots[d] as u128;
    total_rewards = total_rewards.checked_add(user_share).unwrap();
}
```

---

### F-03 [MEDIUM] — No Expiry Check on Claims

**Location:** `new_lib.rs:106-111`

```rust
require!(pool.paused == 0, ErrorCode::PoolPaused);
require!(pool.terminated == 0, ErrorCode::PoolTerminated);
require!(clock.unix_timestamp > pool.start_time, ErrorCode::PoolNotStartedYet);
// No expiry check — users can claim at any time after start
```

**Description:** The original `program_expired` check was removed. A user could claim on day 40:
- Receives their airdrop tokens (works fine)
- Creates a UserStake account
- But cannot unstake (RewardExpired after day 35)
- Rewards are permanently lost, UserStake account orphaned

While arguably user error, the program should protect users from claiming when they can't benefit from it.

**Recommendation:** Block claims after the staking period ends:
```rust
require!(current_day < TOTAL_DAYS, ErrorCode::StakingPeriodEnded);
```

Or, if late claiming is intentional (users only want airdrop, don't care about rewards), at minimum add the expiry check to prevent claims after day 35 when the UserStake becomes unrecoverable.

---

### F-04 [LOW] — `terminate_pool` Becomes a No-Op

**Location:** `new_lib.rs:319-322`

```rust
let max_remaining_rewards = STAKING_POOL;  // 133M
let reserved = (pool.total_staked).saturating_add(max_remaining_rewards);
let drainable = pool_balance.saturating_sub(reserved);
```

**Description:** After all claims, `pool_balance ≈ 133M` and `reserved = 67M + 133M = 200M`. Since `133M < 200M`, `drainable = 0` always (saturating). The admin can never drain anything via terminate.

**Impact:** Not a security issue. The instruction still serves its purpose of setting `terminated = 1` to block new claims and snapshots. The drain functionality is just dead code.

**Recommendation:** Adjust reserve to exclude virtual `total_staked`:
```rust
let reserved = max_remaining_rewards;  // Only reserve staking rewards
```

---

### F-05 [LOW] — Stale Documentation

**Location:** `new_lib.rs:95-96`

```rust
/// Claim airdrop via merkle proof. Tokens are auto-staked.
```

**Description:** Tokens are no longer auto-staked — they're sent to the user's wallet. The docstring should reflect the new behavior.

---

### F-06 [LOW] — `total_staked` Semantic Confusion

**Location:** `PoolState.total_staked` used across multiple functions

**Description:** `total_staked` no longer represents actual tokens in the pool. It's a virtual counter of "unexited allocations." This creates confusion in:
- `recover_expired_rewards`: Reserves `total_staked` tokens, but those correspond to principal already sent to users
- `close_pool`: Checks `total_staked > 0` as if it means tokens remain
- Snapshot logs: Suggest real tokens when it's a virtual counter

**Recommendation:** Rename to `total_allocated` or `total_virtual_staked` for clarity.

---

## 5. Token Flow Accounting (New Model)

```
Pool funded with: 200M tokens (67M airdrop + 133M staking rewards)

OUTFLOWS:
  claim_airdrop:           transfers airdrop amount to user (from 67M portion)
  unstake:                 transfers rewards only to user (from 133M portion)
  terminate_pool:          drains excess to admin (effectively 0 in new model)
  recover_expired_rewards: drains pool_balance - total_staked to admin
  close_pool:              SPL close_account (requires 0 balance!)

SOLVENCY CHECK:
  Max airdrop outflow:  67M  (enforced by AIRDROP_POOL cap)
  Max rewards outflow: 133M  (enforced by daily_rewards sum == STAKING_POOL)
  Total max outflow:   200M  == Initial funding
  SOLVENT as long as pool funded with >= 200M tokens.

⚠️ STRANDED TOKENS (if not all users unstake before day 35):
  After recovery: pool_balance = total_staked (virtual, unexited users)
  These tokens represent airdrop amounts ALREADY SENT to users.
  No instruction can drain them. Pool can never close.
  See Finding F-01.
```

---

## 6. What Is Solid

| Aspect | Assessment |
|--------|------------|
| `transfer_from_pool_pda` helper | Excellent refactor, -60 lines of duplication |
| Dual exit windows (concept) | Clean separation of reward vs pool lifecycle |
| Snapshot logic | Unchanged, correct |
| Merkle proof verification | Unchanged, correct |
| PDA derivation and seeds | Unchanged, correct |
| ClaimAirdrop account constraints | Properly constrained, mirrors Unstake pattern |
| `is_expired` parameterization | Better design than hardcoded `program_expired` |
| ClaimMarker anti-replay | Still intact and effective |
| Arithmetic safety | All checked/saturating operations preserved |
| Daily rewards validation | Ascending order + sum check intact |

---

## 7. Impact on Existing Infrastructure

### 7.1 IDL Changes (Breaking)

| Change | Impact |
|--------|--------|
| `UserStake` loses `claim_day` field (49 → 41 bytes) | Account layout break |
| `ClaimAirdrop` gains `pool_token_account`, `user_token_account`, `token_program` | Client must pass 3 additional accounts |
| `recover_expired_tokens` → `recover_expired_rewards` | Instruction name change |
| `Unstaked` event loses `principal` field | Event parsing change |
| Error codes renamed (`ProgramExpired` → `RewardExpired`, etc.) | Error handling change |

### 7.2 Scripts Requiring Updates

| Script | Required Change |
|--------|----------------|
| `scripts/claim.ts` | Pass `poolTokenAccount`, `userTokenAccount`, `tokenProgram` |
| `scripts/stats.ts` | Remove `claim_day` references, update event parsing |
| `scripts/unstake-preview.ts` | Update reward calculation (no `claim_day`, start from day 0) |
| `scripts/calculate-rewards.ts` | Update for new formula |

### 7.3 Tests

The entire test suite (`tests/memeland_bankrun_optimized.ts`) must be rewritten:
- Verify token transfers during claim (check user balance after)
- Verify rewards-only unstake (no principal in payout)
- Test dual exit windows (day 35 reward expiry, day 55 pool close)
- Test new error codes
- Verify claims work without prior snapshot
- Test late-claim and late-unstake edge cases

### 7.4 Deployment

**This is a breaking change.** Must be deployed as a fresh program:
- `UserStake` account size changed
- `PoolState.total_staked` semantics changed
- Cannot upgrade in-place with existing accounts

---

## 8. Findings Summary

| ID | Severity | Description | Fix Effort |
|----|----------|-------------|------------|
| F-01 | **CRITICAL** | Stranded tokens prevent pool closure. After day 35, no instruction can drain remaining `total_staked` tokens. SPL `close_account` fails on non-zero balance. Pool permanently stuck. | ~15 lines |
| F-02 | **CRITICAL** | Division by zero in `calculate_user_rewards`. Removed `snapshot == 0` guard. | ~2 lines |
| F-03 | **MEDIUM** | No expiry check on claims. Users can claim after day 35, receive tokens but never collect rewards. UserStake orphaned. | ~2 lines |
| F-04 | **LOW** | `terminate_pool` always drains 0 tokens. Functionally a no-op for draining. | ~1 line |
| F-05 | **LOW** | Stale docstring: "Tokens are auto-staked" but they're now sent to user. | ~1 line |
| F-06 | **LOW** | `total_staked` is now virtual but treated as real in several places. | Rename |

---

## 9. Recommendations

### Must Fix Before Applying

1. **F-01 (CRITICAL):** Allow unstake after reward expiry with 0 rewards. This is the same pattern the old code used — it protects against stranded tokens, allows users to close their accounts, and lets `total_staked` reach 0 so `close_pool` works. This single fix also resolves orphaned UserStake accounts.

2. **F-02 (CRITICAL):** Restore the `if daily_snapshots[d] == 0 { continue; }` guard in `calculate_user_rewards`. Zero-cost defensive programming.

3. **F-03 (MEDIUM):** Add `require!(current_day < TOTAL_DAYS, ErrorCode::StakingPeriodEnded)` to `claim_airdrop` to prevent claims after the staking period ends.

### Should Fix

4. **F-04:** Adjust `terminate_pool` reserve: `let reserved = max_remaining_rewards;`
5. **F-05:** Update docstring on `claim_airdrop`
6. **F-06:** Consider renaming `total_staked` to `total_allocated`

### Before Deployment

7. Rewrite the full test suite for the new business model
8. Update all TypeScript scripts for new IDL
9. Deploy as a fresh program (breaking account layout changes)
10. Replace `INIT_AUTHORITY` pubkey (existing TODO on line 20)
11. Fund pool with exactly 200M tokens (67M + 133M)

---

## 10. Conclusion

The architectural shift from "auto-stake" to "claim-and-earn" is a valid business model change. The core idea is sound: users receive airdrop tokens immediately while earning staking rewards through a virtual staking mechanism. The `transfer_from_pool_pda` refactor and parameterized `is_expired` helper are genuine improvements.

However, **2 critical bugs must be fixed before applying these changes.** The most severe — stranded tokens preventing pool closure — could permanently lock millions of tokens on-chain. The fix is straightforward: allow unstake after reward expiry with 0 rewards (matching the old code's behavior).

The critical division-by-zero is a 2-line fix restoring a defensive guard. The medium-severity claim expiry issue is a 2-line addition.

**Total fix effort: ~20 lines of code changes.** Once these are applied and tests updated, the new model is ready for deployment.
