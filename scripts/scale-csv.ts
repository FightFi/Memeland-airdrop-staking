/**
 * scale-csv.ts
 *
 * Reads a CSV (wallet,amount) and scales all amounts proportionally
 * so the total equals exactly TARGET_TOTAL (67,000,000 tokens).
 *
 * Usage:
 *   npx ts-node scripts/scale-csv.ts <input.csv> [output.csv]
 */

import * as fs from "fs";
import * as path from "path";

const TOKEN_DECIMALS = 9;
const TARGET_TOTAL_RAW = BigInt("67000000000000000"); // 67M × 10^9

function parseAmountToRaw(amount: string): bigint {
  const parts = amount.split(".");
  const intPart = parts[0] || "0";
  const fracPart = parts.length === 2 ? parts[1] : "";
  if (fracPart.length > TOKEN_DECIMALS) {
    throw new Error(`Amount "${amount}" has more than ${TOKEN_DECIMALS} decimals`);
  }
  const padded = fracPart.padEnd(TOKEN_DECIMALS, "0");
  return BigInt(intPart) * BigInt(10 ** TOKEN_DECIMALS) + BigInt(padded);
}

function rawToHuman(raw: bigint): string {
  const str = raw.toString().padStart(TOKEN_DECIMALS + 1, "0");
  const intPart = str.slice(0, str.length - TOKEN_DECIMALS);
  const fracPart = str.slice(str.length - TOKEN_DECIMALS);
  return `${intPart}.${fracPart}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx ts-node scripts/scale-csv.ts <input.csv> [output.csv]");
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = args[1]
    ? path.resolve(args[1])
    : inputPath.replace(/\.csv$/i, "-scaled.csv");

  const content = fs.readFileSync(inputPath, "utf-8").trim();
  const lines = content.split("\n");

  const entries: { wallet: string; amountRaw: bigint }[] = [];
  let totalRaw = BigInt(0);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/g, "").trim();
    if (!line) continue;
    const [wallet, amount] = line.split(",");
    const amountRaw = parseAmountToRaw(amount.trim());
    entries.push({ wallet: wallet.trim(), amountRaw });
    totalRaw += amountRaw;
  }

  console.log(`Parsed ${entries.length} entries`);
  console.log(`Original total: ${rawToHuman(totalRaw)} tokens (${totalRaw} raw)`);
  console.log(`Target total:   ${rawToHuman(TARGET_TOTAL_RAW)} tokens`);
  console.log(`Scale factor:   ${Number(TARGET_TOTAL_RAW) / Number(totalRaw)}`);

  // Scale each amount proportionally: scaled = (amount * TARGET) / total
  const scaled: { wallet: string; amountRaw: bigint }[] = [];
  let scaledSum = BigInt(0);

  for (const entry of entries) {
    const newAmount = (entry.amountRaw * TARGET_TOTAL_RAW) / totalRaw;
    scaled.push({ wallet: entry.wallet, amountRaw: newAmount });
    scaledSum += newAmount;
  }

  // Distribute rounding remainder to the largest holder
  const remainder = TARGET_TOTAL_RAW - scaledSum;
  if (remainder !== BigInt(0)) {
    // Find largest holder
    let maxIdx = 0;
    for (let i = 1; i < scaled.length; i++) {
      if (scaled[i].amountRaw > scaled[maxIdx].amountRaw) maxIdx = i;
    }
    scaled[maxIdx].amountRaw += remainder;
    console.log(`Rounding remainder: ${remainder} raw (added to ${scaled[maxIdx].wallet})`);
  }

  // Verify
  let verifySum = BigInt(0);
  for (const s of scaled) verifySum += s.amountRaw;
  if (verifySum !== TARGET_TOTAL_RAW) {
    throw new Error(`Sum mismatch after scaling: ${verifySum} !== ${TARGET_TOTAL_RAW}`);
  }

  // Write output CSV
  const csvLines = ["wallet,amount"];
  for (const s of scaled) {
    csvLines.push(`${s.wallet},${rawToHuman(s.amountRaw)}`);
  }
  fs.writeFileSync(outputPath, csvLines.join("\n") + "\n");

  console.log(`\nScaled total: ${rawToHuman(TARGET_TOTAL_RAW)} tokens — matches target exactly`);
  console.log(`Output written to: ${outputPath}`);
  console.log(`\nNow run: yarn build-merkle ${outputPath}`);
}

main();
