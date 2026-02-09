import BN from "bn.js";

// Must match the on-chain constant
export const STAKING_POOL = new BN("133000000000000000"); // 133M with 9 decimals

/**
 * Computes the 20-day exponential reward curve off-chain.
 * Uses K=0.15 growth factor, matching the on-chain validation.
 * The sum of all rewards equals exactly STAKING_POOL.
 */
export function computeDailyRewards(): BN[] {
  const K = 0.15;
  const SCALE = 1e15; // Scale factor for precision in BigInt math

  const expValues = Array.from({ length: 20 }, (_, d) => Math.exp(K * d));
  const totalExp = expValues.reduce((a, b) => a + b, 0);

  // Calculate scaled proportions (convert to integers for BigInt math)
  const scaledProportions = expValues.map(v => BigInt(Math.round((v / totalExp) * SCALE)));
  const totalScaled = scaledProportions.reduce((a, b) => a + b, 0n);

  const stakingPool = BigInt(STAKING_POOL.toString());

  // Calculate rewards: stakingPool * proportion / totalScaled
  const rewards = scaledProportions.map(p =>
    new BN((stakingPool * p / totalScaled).toString())
  );

  // Adjust last element so sum is exactly STAKING_POOL
  const currentSum = rewards.reduce((a, b) => a.add(b), new BN(0));
  const diff = STAKING_POOL.sub(currentSum);
  rewards[19] = rewards[19].add(diff);

  return rewards;
}
