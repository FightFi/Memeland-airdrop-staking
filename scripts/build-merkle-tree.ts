/**
 * build-merkle-tree.ts
 *
 * Reads a CSV of (wallet, amount) and outputs a JSON file containing:
 * - merkleRoot: the 32-byte root as a number array (pass directly to initialize_pool)
 * - claims: { [wallet]: { amount, amountRaw, proof } }
 *
 * Usage:
 *   npx ts-node scripts/build-merkle-tree.ts <input.csv> [output.json]
 *
 * CSV format (header required):
 *   wallet,amount
 *   7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV,1000000.000000
 *
 * Amount is in human-readable tokens (9 decimals). The script converts to raw lamports.
 *
 * The hashing scheme matches the on-chain contract:
 *   leaf = keccak256(wallet_pubkey_bytes || amount_le_u64_bytes)
 *   node = keccak256(min(left, right) || max(left, right))
 */

import * as fs from "fs";
import * as path from "path";
import { keccak256 } from "js-sha3";
import { PublicKey } from "@solana/web3.js";

// ── Config ──────────────────────────────────────────────────────────────────

const TOKEN_DECIMALS = 9;

// ── Merkle tree ─────────────────────────────────────────────────────────────

function hashPair(a: Buffer, b: Buffer): Buffer {
  const [left, right] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(keccak256.arrayBuffer(Buffer.concat([left, right])));
}

function computeLeaf(walletPubkey: PublicKey, amountRaw: bigint): Buffer {
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amountRaw);
  return Buffer.from(
    keccak256.arrayBuffer(Buffer.concat([walletPubkey.toBuffer(), amountBuf]))
  );
}

interface MerkleTree {
  layers: Buffer[][];
  root: Buffer;
}

function buildTree(leaves: Buffer[]): MerkleTree {
  if (leaves.length === 0) throw new Error("Empty leaf set");

  // Sort leaves for deterministic tree
  const sorted = [...leaves].sort(Buffer.compare);
  const layers: Buffer[][] = [sorted];

  let current = sorted;
  while (current.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashPair(current[i], current[i + 1]));
      } else {
        // Odd node: promote to next level
        next.push(current[i]);
      }
    }
    layers.push(next);
    current = next;
  }

  return { layers, root: current[0] };
}

function getProof(tree: MerkleTree, leaf: Buffer): Buffer[] {
  const proof: Buffer[] = [];
  let idx = tree.layers[0].findIndex((l) => l.equals(leaf));
  if (idx === -1) throw new Error("Leaf not found in tree");

  for (const layer of tree.layers.slice(0, -1)) {
    const pairIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (pairIdx < layer.length) {
      proof.push(layer[pairIdx]);
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}

// ── CSV parsing ─────────────────────────────────────────────────────────────

interface AllowlistEntry {
  wallet: string;
  amount: string;
  amountRaw: bigint;
}

function parseCSV(filePath: string): AllowlistEntry[] {
  const content = fs.readFileSync(filePath, "utf-8").trim();
  const lines = content.split("\n");

  if (lines.length < 2) {
    throw new Error("CSV must have a header row and at least one data row");
  }

  const header = lines[0].toLowerCase().replace(/\r/g, "");
  if (!header.includes("wallet") || !header.includes("amount")) {
    throw new Error('CSV header must contain "wallet" and "amount" columns');
  }

  const entries: AllowlistEntry[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/g, "").trim();
    if (!line) continue;

    const parts = line.split(",");
    if (parts.length < 2) {
      throw new Error(`Line ${i + 1}: expected wallet,amount`);
    }

    const wallet = parts[0].trim();
    const amount = parts[1].trim();

    // Validate wallet is a valid Solana pubkey
    try {
      new PublicKey(wallet);
    } catch {
      throw new Error(`Line ${i + 1}: invalid Solana wallet address "${wallet}"`);
    }

    // Check duplicates
    if (seen.has(wallet)) {
      throw new Error(`Line ${i + 1}: duplicate wallet "${wallet}"`);
    }
    seen.add(wallet);

    // Convert human amount to raw (multiply by 10^decimals)
    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      throw new Error(`Line ${i + 1}: invalid amount "${amount}"`);
    }
    const amountRaw = BigInt(Math.round(amountFloat * 10 ** TOKEN_DECIMALS));

    entries.push({ wallet, amount, amountRaw });
  }

  return entries;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx ts-node scripts/build-merkle-tree.ts <input.csv> [output.json]");
    console.error("Example: npx ts-node scripts/build-merkle-tree.ts data/devnet-airdrop.csv data/devnet-airdrop-merkle.json");
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  const outputPath = args[1]
    ? path.resolve(args[1])
    : inputPath.replace(/\.csv$/i, "-merkle.json");

  console.log(`Reading allowlist from: ${inputPath}`);
  const entries = parseCSV(inputPath);
  console.log(`Parsed ${entries.length} entries`);

  // Build leaves
  const leafMap = new Map<string, { leaf: Buffer; entry: AllowlistEntry }>();
  const leaves: Buffer[] = [];

  for (const entry of entries) {
    const pubkey = new PublicKey(entry.wallet);
    const leaf = computeLeaf(pubkey, entry.amountRaw);
    leafMap.set(entry.wallet, { leaf, entry });
    leaves.push(leaf);
  }

  // Build tree
  const tree = buildTree(leaves);
  console.log(`Merkle root: ${tree.root.toString("hex")}`);
  console.log(`Merkle root (array): [${Array.from(tree.root).join(", ")}]`);

  // Build output
  const claims: Record<string, {
    amount: string;
    amountRaw: string;
    proof: number[][];
  }> = {};

  let totalAmount = BigInt(0);

  for (const entry of entries) {
    const { leaf } = leafMap.get(entry.wallet)!;
    const proof = getProof(tree, leaf);

    claims[entry.wallet] = {
      amount: entry.amount,
      amountRaw: entry.amountRaw.toString(),
      proof: proof.map((p) => Array.from(p)),
    };

    totalAmount += entry.amountRaw;
  }

  const output = {
    merkleRoot: Array.from(tree.root),
    totalEntries: entries.length,
    totalAmount: totalAmount.toString(),
    totalAmountHuman: (Number(totalAmount) / 10 ** TOKEN_DECIMALS).toFixed(TOKEN_DECIMALS),
    claims,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nOutput written to: ${outputPath}`);
  console.log(`Total entries: ${entries.length}`);
  console.log(`Total amount: ${output.totalAmountHuman} tokens`);
  console.log(`\nTo use in initialize_pool, pass merkleRoot as the second argument:`);
  console.log(`  .initializePool(new BN(startTime), [${Array.from(tree.root).join(", ")}])`);
}

main();
