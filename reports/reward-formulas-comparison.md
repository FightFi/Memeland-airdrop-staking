# Reward Curve Comparison — Memeland Staking

## Pool Configuration

| Concept | Amount | Share |
|---------|--------|-------|
| **Total Pool** | 200,000,000 tokens | 100% |
| Claims (airdrop) | 66,666,667 tokens | 1/3 |
| **Rewards (staking)** | **133,333,333 tokens** | **2/3** |
| Staking period | 20 days | — |
| Token decimals | 9 | — |

> All reward figures in this document are calculated against the **133.33M token** reward pool.

---

## The 3 Formulas

All share the same general form:

```
R(d) = R₁ × e^(K × (d - 1))
```

Where `R₁` is computed so that the sum across all 20 days equals exactly 133,333,333 tokens.

| Formula | K | Name | D20/D1 Ratio | Philosophy |
|---------|---|------|-------------|------------|
| **F1** | 0.05 | Moderate (current) | 2.59x | Smooth growth, gradual incentive |
| **F2** | 0.10 | Aggressive | 6.69x | Steep growth, penalizes early exit |
| **F3** | 0.15 | Ultra-Aggressive | 17.29x | Explosive growth, maximum end-of-period retention |

---

## Daily Reward Comparison (in tokens)

| Day | F1 Moderate (K=0.05) | F2 Aggressive (K=0.10) | F3 Ultra-Aggressive (K=0.15) |
|-----|----------------------|------------------------|------------------------------|
| 1 | 3,978,270 | 2,194,918 | 1,130,654 |
| 2 | 4,182,224 | 2,425,748 | 1,313,596 |
| 3 | 4,396,628 | 2,680,818 | 1,526,205 |
| 4 | 4,622,014 | 2,962,625 | 1,773,283 |
| 5 | 4,858,933 | 3,274,011 | 2,060,260 |
| 6 | 5,107,971 | 3,618,171 | 2,393,134 |
| 7 | 5,369,739 | 3,998,684 | 2,780,549 |
| 8 | 5,644,883 | 4,419,534 | 3,230,969 |
| 9 | 5,934,075 | 4,885,149 | 3,754,014 |
| 10 | 6,238,030 | 5,399,435 | 4,361,006 |
| 11 | 6,557,498 | 5,966,825 | 5,066,248 |
| 12 | 6,893,268 | 6,592,326 | 5,886,452 |
| 13 | 7,246,178 | 7,281,568 | 6,840,210 |
| 14 | 7,617,109 | 8,040,777 | 7,948,643 |
| 15 | 8,006,992 | 8,876,824 | 9,231,973 |
| 16 | 8,416,811 | 9,837,364 | 10,726,289 |
| 17 | 8,847,606 | 10,871,015 | 12,462,052 |
| 18 | 9,300,477 | 12,013,546 | 14,479,025 |
| 19 | 9,776,586 | 13,278,155 | 16,825,253 |
| 20 | 10,277,708 | 14,676,627 | 19,544,431 |

---

## Distribution by Phase

| Phase | F1 Moderate | F2 Aggressive | F3 Ultra-Aggressive |
|-------|-------------|---------------|---------------------|
| **Days 1-5** | 22.0M (16.5%) | 13.5M (10.2%) | 7.8M (5.9%) |
| **Days 6-10** | 28.3M (21.2%) | 22.3M (16.7%) | 16.5M (12.4%) |
| **Days 11-15** | 36.3M (27.2%) | 36.8M (27.6%) | 35.0M (26.2%) |
| **Days 16-20** | 46.6M (35.0%) | 60.7M (45.5%) | 74.0M (55.5%) |

### Reward concentration in the last 5 days

```
F1 Moderate        |████████████████████████████████████                                     | 35.0%
F2 Aggressive      |█████████████████████████████████████████████▌                            | 45.5%
F3 Ultra-Aggressive|███████████████████████████████████████████████████████▌                  | 55.5%
                    0%        10%        20%        30%        40%        50%        60%
                                    % of pool in the LAST 5 days
```

---

## Cost of Leaving Early

**Percentage of rewards you LOSE if you exit on day X** (having staked since day 1):

| Exit on day... | F1 Moderate | F2 Aggressive | F3 Ultra-Aggressive |
|----------------|-------------|---------------|---------------------|
| Day 3 | 94.0% | 96.1% | 97.8% |
| Day 5 | 83.5% | 89.8% | 94.1% |
| Day 7 | 72.2% | 82.5% | 89.6% |
| Day 10 | 62.2% | 73.1% | 81.8% |
| Day 13 | 44.3% | 56.1% | 66.6% |
| Day 15 | 35.0% | 45.5% | 55.5% |
| Day 17 | 23.9% | 33.3% | 43.6% |
| Day 20 (final) | 0% | 0% | 0% |

### Concrete example: user with 100,000 staked tokens (1% of pool)

Assuming the user holds 1% of total staked amount throughout the entire period:

| Scenario | F1 Moderate | F2 Aggressive | F3 Ultra-Aggressive |
|----------|-------------|---------------|---------------------|
| Exit day 5 | +220,069 | +135,381 | +78,040 |
| Exit day 10 | +503,071 | +358,890 | +241,700 |
| Exit day 15 | +866,497 | +727,578 | +592,362 |
| **Stay 20 days** | **+1,333,333** | **+1,333,333** | **+1,333,333** |

> The total reward at day 20 is identical across all 3 formulas (1.33% of 133.33M). The difference lies in **how much you earn if you leave before the end**.

---

## Cumulative Rewards by Day (% of total)

| Day | F1 Moderate | F2 Aggressive | F3 Ultra-Aggressive |
|-----|-------------|---------------|---------------------|
| 1 | 3.0% | 1.6% | 0.8% |
| 2 | 6.1% | 3.5% | 1.8% |
| 3 | 9.4% | 5.5% | 3.0% |
| 4 | 12.9% | 7.7% | 4.3% |
| 5 | 16.5% | 10.2% | 5.9% |
| 6 | 20.4% | 12.9% | 7.7% |
| 7 | 24.4% | 15.9% | 9.8% |
| 8 | 28.7% | 19.2% | 12.2% |
| 9 | 33.1% | 22.9% | 15.0% |
| 10 | 37.8% | 26.9% | 18.2% |
| 11 | 42.7% | 31.4% | 22.0% |
| 12 | 47.9% | 36.3% | 26.5% |
| 13 | 53.3% | 41.8% | 31.6% |
| 14 | 59.0% | 47.8% | 37.5% |
| 15 | 65.0% | 54.5% | 44.5% |
| 16 | 71.3% | 61.8% | 52.5% |
| 17 | 77.9% | 70.0% | 61.9% |
| 18 | 84.9% | 79.0% | 72.7% |
| 19 | 92.3% | 89.0% | 85.4% |
| 20 | 100.0% | 100.0% | 100.0% |

---

## Retention Analysis

### Breakeven point: when the staker "really wins"

On which day does the user accumulate at least 50% of their total rewards:

| Formula | Day reaching 50% | Interpretation |
|---------|------------------|----------------|
| F1 Moderate | Day ~13 | Half the rewards earned in the first half of the period |
| F2 Aggressive | Day ~15 | Most rewards are concentrated in the last 5 days |
| F3 Ultra-Aggressive | Day ~16 | More than half the rewards are in the last 4 days |

### Retention index (last day / first day reward ratio)

| Formula | Day 1 | Day 20 | Ratio | Retention strength |
|---------|-------|--------|-------|--------------------|
| F1 | 3.98M | 10.28M | 2.59x | Low |
| F2 | 2.19M | 14.68M | 6.69x | Medium-High |
| F3 | 1.13M | 19.54M | 17.29x | Very High |

---

## Key Metrics Comparison

| Metric | F1 Moderate | F2 Aggressive | F3 Ultra-Aggressive |
|--------|-------------|---------------|---------------------|
| **K (growth factor)** | 0.05 | 0.10 | 0.15 |
| **Day 1 reward** | 3.98M | 2.19M | 1.13M |
| **Day 10 reward** | 6.24M | 5.40M | 4.36M |
| **Day 20 reward** | 10.28M | 14.68M | 19.54M |
| **D20/D1 ratio** | 2.59x | 6.69x | 17.29x |
| **% in last 5 days** | 35.0% | 45.5% | 55.5% |
| **% in last 10 days** | 62.2% | 73.1% | 81.8% |
| **Day to reach 50%** | ~13 | ~15 | ~16 |
| **Lost if exit day 10** | 62.2% | 73.1% | 81.8% |

---

## Pros and Cons

### F1 — Moderate (K=0.05)
**Pros:**
- Meaningful rewards from day 1 (3.98M)
- Predictable curve, easy to communicate
- Lower risk of users feeling "shortchanged" early on

**Cons:**
- Weak incentive to stay until the end
- Exiting on day 10 only forfeits 62% — tempting to take early profits

---

### F2 — Aggressive (K=0.10)
**Pros:**
- Good balance between immediate reward and retention
- Day 1 still offers 2.19M (meaningful reward)
- Exiting on day 10 forfeits 73% — strong incentive to stay
- 45.5% of pool in last 5 days creates end-of-period urgency

**Cons:**
- Day 1 reward is ~45% lower than F1
- May frustrate impatient users during the first week

---

### F3 — Ultra-Aggressive (K=0.15)
**Pros:**
- Maximum retention incentive
- Exiting on day 10 forfeits 82% — very costly to leave
- 55.5% of pool in last 5 days: most value is at the end
- Day 20 pays 19.54M — "jackpot" effect at close

**Cons:**
- Day 1 reward is only 1.13M — may discourage early adopters
- Perception that "staking isn't worth it" during the first week
- Higher risk of early abandonment due to frustration with low rewards
- If many leave early, remaining stakers earn more (concentration effect)

---

## Implementation

All 3 formulas are **compatible with the current smart contract** with no code changes. The on-chain program only validates:

1. `daily_rewards[d] >= daily_rewards[d-1]` (monotonically increasing)
2. `sum(daily_rewards) == STAKING_POOL` (exact sum)

Both conditions are satisfied for any value of K > 0.

### Required Changes

**`scripts/utils/rewards.ts`** — only change the K value:

```typescript
// F1 Moderate (current):
const K = 0.05;

// F2 Aggressive:
const K = 0.10;

// F3 Ultra-Aggressive:
const K = 0.15;
```

**`scripts/utils/rewards.ts`** — update STAKING_POOL for the new pool:

```typescript
// Current (100M):
export const STAKING_POOL = new BN("100000000000000000");

// New (133.33M for rewards with 200M pool):
export const STAKING_POOL = new BN("133333333000000000");
```

**`lib.rs`** — update the staking pool constant:

```rust
// Current:
pub const STAKING_POOL: u64 = 100_000_000_000_000_000;

// New:
pub const STAKING_POOL: u64 = 133_333_333_000_000_000;
```

No changes are required to the on-chain calculation logic (`calculate_user_rewards`), snapshots, claims, or unstakes.

---

## Executive Summary

| | F1 Moderate | F2 Aggressive | F3 Ultra-Aggressive |
|-|-------------|---------------|---------------------|
| **Best for** | Conservative community, immediate trust | Retention/satisfaction balance | Maximum hold, crypto-native audience |
| **Main risk** | Low retention | Moderate frustration first week | Mass early abandonment |
| **Day 1 reward** | 3.98M | 2.19M | 1.13M |
| **Day 20 reward** | 10.28M | 14.68M | 19.54M |
| **% last 5 days** | 35% | 45.5% | 55.5% |
| **Recommended if...** | Smooth onboarding is the priority | Retention is needed without sacrificing UX | Maximum FOMO for staying is the goal |

---

*Generated for a 200M token pool (1/3 claims, 2/3 rewards) with a 20-day staking period.*
