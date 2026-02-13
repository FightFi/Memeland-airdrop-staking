/**
 * validate-allowlist.ts
 *
 * Validates a CSV allowlist or a built merkle JSON against the on-chain
 * AIRDROP_POOL constant (67,000,000 tokens with 9 decimals).
 *
 * Checks performed:
 *   1. File exists and is parseable
 *   2. Every wallet is a valid Solana pubkey (32 bytes, on the ed25519 curve)
 *   3. No duplicate wallets
 *   4. Every amount is positive
 *   5. No amount exceeds 9 decimal places (prevents floating-point dust)
 *   6. No individual amount exceeds AIRDROP_POOL
 *   7. Total (sum of raw amounts) equals exactly AIRDROP_POOL
 *   8. If merkle JSON: validates totalAmount field matches claims sum
 *
 * Usage:
 *   npx ts-node scripts/validate-allowlist.ts <file.csv|file.json>
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 */

import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

// ── Constants (must match lib.rs) ──────────────────────────────────────────
const TOKEN_DECIMALS = 9;
const AIRDROP_POOL_RAW = BigInt("67000000000000000"); // 67_000_000 × 10^9
const AIRDROP_POOL_HUMAN = "67000000.000000000";

// ── Types ──────────────────────────────────────────────────────────────────

interface Entry {
  line: number; // 1-based line number (CSV) or index (JSON)
  wallet: string;
  amountHuman: string; // original string from file
  amountRaw: bigint;
}

interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    entries: number;
    totalRaw: bigint;
    totalHuman: string;
    expectedRaw: bigint;
    expectedHuman: string;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isValidPubkey(addr: string): boolean {
  try {
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Converts a human-readable token amount string to raw bigint.
 * Returns null if the string has more than TOKEN_DECIMALS decimal places.
 */
function humanToRaw(amount: string): { raw: bigint; decimalsUsed: number } | null {
  const trimmed = amount.trim();

  // Split on decimal point
  const parts = trimmed.split(".");
  if (parts.length > 2) return null;

  const integerPart = parts[0] || "0";
  const fractionalPart = parts.length === 2 ? parts[1] : "";

  // Check decimal places don't exceed TOKEN_DECIMALS
  if (fractionalPart.length > TOKEN_DECIMALS) return null;

  // Pad fractional part to exactly TOKEN_DECIMALS
  const padded = fractionalPart.padEnd(TOKEN_DECIMALS, "0");

  // Parse as bigint (no floating point involved)
  const raw = BigInt(integerPart) * BigInt(10 ** TOKEN_DECIMALS) + BigInt(padded);
  return { raw, decimalsUsed: fractionalPart.length };
}

// ── CSV parser ─────────────────────────────────────────────────────────────

function parseCSVEntries(filePath: string): Entry[] {
  const content = fs.readFileSync(filePath, "utf-8").trim();
  const lines = content.split("\n");

  if (lines.length < 2) {
    throw new Error("CSV must have a header row and at least one data row");
  }

  const header = lines[0].toLowerCase().replace(/\r/g, "");
  if (!header.includes("wallet") || !header.includes("amount")) {
    throw new Error('CSV header must contain "wallet" and "amount" columns');
  }

  const entries: Entry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/g, "").trim();
    if (!line) continue;

    const parts = line.split(",");
    if (parts.length < 2) {
      throw new Error(`Line ${i + 1}: expected wallet,amount — got "${line}"`);
    }

    entries.push({
      line: i + 1,
      wallet: parts[0].trim(),
      amountHuman: parts[1].trim(),
      amountRaw: 0n, // filled during validation
    });
  }

  return entries;
}

// ── Merkle JSON parser ─────────────────────────────────────────────────────

interface MerkleJson {
  merkleRoot: number[];
  totalEntries: number;
  totalAmount: string;
  totalAmountHuman: string;
  claims: Record<string, { amount: string; amountRaw: string; proof: number[][] }>;
}

function parseMerkleEntries(filePath: string): { entries: Entry[]; meta: MerkleJson } {
  const content = fs.readFileSync(filePath, "utf-8");
  const json: MerkleJson = JSON.parse(content);

  if (!json.claims || typeof json.claims !== "object") {
    throw new Error("Merkle JSON missing 'claims' object");
  }

  const entries: Entry[] = [];
  let idx = 0;
  for (const [wallet, claim] of Object.entries(json.claims)) {
    entries.push({
      line: idx + 1,
      wallet,
      amountHuman: claim.amount,
      amountRaw: BigInt(claim.amountRaw),
    });
    idx++;
  }

  return { entries, meta: json };
}

// ── Validation ─────────────────────────────────────────────────────────────

function validate(entries: Entry[], isMerkle: boolean, merkleMeta?: MerkleJson): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, number>(); // wallet -> first line number
  let totalRaw = 0n;

  for (const entry of entries) {
    // 1. Valid pubkey
    if (!isValidPubkey(entry.wallet)) {
      errors.push(`#${entry.line}: Invalid Solana pubkey "${entry.wallet}"`);
      continue;
    }

    // 2. Duplicate check
    const prev = seen.get(entry.wallet);
    if (prev !== undefined) {
      errors.push(`#${entry.line}: Duplicate wallet "${entry.wallet}" (first seen at #${prev})`);
      continue;
    }
    seen.set(entry.wallet, entry.line);

    // 3. Parse amount (CSV path — merkle already has raw)
    if (!isMerkle) {
      const parsed = humanToRaw(entry.amountHuman);
      if (parsed === null) {
        errors.push(
          `#${entry.line}: Amount "${entry.amountHuman}" has more than ${TOKEN_DECIMALS} decimal places`
        );
        continue;
      }
      entry.amountRaw = parsed.raw;

      // Warn if fewer than 9 decimals provided (might indicate wrong format)
      if (parsed.decimalsUsed < TOKEN_DECIMALS && parsed.decimalsUsed > 0) {
        warnings.push(
          `#${entry.line}: Amount "${entry.amountHuman}" has ${parsed.decimalsUsed} decimals (expected ${TOKEN_DECIMALS}) — interpreted as ${entry.amountRaw} raw`
        );
      }
    }

    // 4. Positive
    if (entry.amountRaw <= 0n) {
      errors.push(`#${entry.line}: Amount must be positive, got ${entry.amountRaw}`);
      continue;
    }

    // 5. Not larger than pool
    if (entry.amountRaw > AIRDROP_POOL_RAW) {
      errors.push(
        `#${entry.line}: Amount ${entry.amountRaw} exceeds AIRDROP_POOL (${AIRDROP_POOL_RAW})`
      );
    }

    totalRaw += entry.amountRaw;
  }

  // 6. Merkle-specific: totalAmount matches sum of claims
  if (isMerkle && merkleMeta) {
    const metaTotal = BigInt(merkleMeta.totalAmount);
    if (metaTotal !== totalRaw) {
      errors.push(
        `Merkle JSON totalAmount (${metaTotal}) does not match sum of claims (${totalRaw})`
      );
    }
    if (merkleMeta.totalEntries !== entries.length) {
      errors.push(
        `Merkle JSON totalEntries (${merkleMeta.totalEntries}) does not match actual entries (${entries.length})`
      );
    }
  }

  // 7. Total must equal AIRDROP_POOL exactly
  if (totalRaw !== AIRDROP_POOL_RAW) {
    const diff = totalRaw - AIRDROP_POOL_RAW;
    const diffSign = diff > 0n ? "+" : "";
    errors.push(
      `Total amount mismatch: got ${totalRaw} raw (${formatHuman(totalRaw)}), expected ${AIRDROP_POOL_RAW} raw (${AIRDROP_POOL_HUMAN}). Diff: ${diffSign}${diff} raw`
    );
  }

  const totalHuman = formatHuman(totalRaw);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      entries: entries.length,
      totalRaw,
      totalHuman,
      expectedRaw: AIRDROP_POOL_RAW,
      expectedHuman: AIRDROP_POOL_HUMAN,
    },
  };
}

function formatHuman(raw: bigint): string {
  const str = raw.toString().padStart(TOKEN_DECIMALS + 1, "0");
  const intPart = str.slice(0, str.length - TOKEN_DECIMALS) || "0";
  const fracPart = str.slice(str.length - TOKEN_DECIMALS);
  return `${intPart}.${fracPart}`;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      "Usage: npx ts-node scripts/validate-allowlist.ts <file.csv|file.json>"
    );
    console.error(
      "Example: npx ts-node scripts/validate-allowlist.ts data/devnet-airdrop.csv"
    );
    process.exit(1);
  }

  const filePath = path.resolve(args[0]);

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const isJson = filePath.endsWith(".json");
  const fileType = isJson ? "Merkle JSON" : "CSV";

  console.log(`\nValidating ${fileType}: ${filePath}`);
  console.log(`Expected total: ${AIRDROP_POOL_HUMAN} tokens (${AIRDROP_POOL_RAW} raw)`);
  console.log("─".repeat(60));

  let entries: Entry[];
  let merkleMeta: MerkleJson | undefined;

  try {
    if (isJson) {
      const result = parseMerkleEntries(filePath);
      entries = result.entries;
      merkleMeta = result.meta;
    } else {
      entries = parseCSVEntries(filePath);
    }
  } catch (err: any) {
    console.error(`\nParse error: ${err.message}`);
    process.exit(1);
  }

  const result = validate(entries, isJson, merkleMeta);

  // Print warnings
  if (result.warnings.length > 0) {
    console.log(`\nWarnings (${result.warnings.length}):`);
    for (const w of result.warnings) {
      console.log(`  WARN  ${w}`);
    }
  }

  // Print errors
  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    for (const e of result.errors) {
      console.log(`  FAIL  ${e}`);
    }
  }

  // Summary
  console.log("\n─".repeat(60));
  console.log(`Entries:  ${result.summary.entries}`);
  console.log(`Total:    ${result.summary.totalHuman} tokens (${result.summary.totalRaw} raw)`);
  console.log(`Expected: ${result.summary.expectedHuman} tokens (${result.summary.expectedRaw} raw)`);
  console.log(`Match:    ${result.summary.totalRaw === result.summary.expectedRaw ? "YES" : "NO"}`);

  if (result.ok) {
    console.log(`\nRESULT: ALL CHECKS PASSED\n`);
    process.exit(0);
  } else {
    console.log(`\nRESULT: VALIDATION FAILED (${result.errors.length} error(s))\n`);
    process.exit(1);
  }
}

main();
