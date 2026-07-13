// merkle commitment scheme. mirrors the solana production pattern: every
// cycle, all fair value outputs become canonical leaves, the sorted-pair
// keccak256 tree is built, and the root goes on-chain. anyone can later
// verify any published price against the committed root.
//
// canonical leaf string:  tokenId|cycleId|fairValue|confidence|timestamp
//   tokenId     integer
//   cycleId     integer
//   fairValue   fixed 8-decimal string, e.g. "249.12345678"
//   confidence  integer 0-100
//   timestamp   unix seconds, integer
// leaf hash = keccak256(utf8 bytes of the canonical string).
//
// interior nodes hash the sorted pair (lexicographic byte order), which is
// exactly what MorrowCommits.verify expects on-chain. an odd node at any
// level is promoted unchanged.

import { concat, keccak256, stringToHex, type Hex } from "viem";

export interface LeafInput {
  tokenId: number;
  cycleId: number;
  fairValue: number;
  confidence: number;
  timestamp: number; // unix seconds
}

export function canonicalLeafString(input: LeafInput): string {
  if (!Number.isInteger(input.tokenId)) throw new Error("tokenId must be an integer");
  if (!Number.isInteger(input.cycleId)) throw new Error("cycleId must be an integer");
  if (!Number.isInteger(input.confidence)) throw new Error("confidence must be an integer");
  if (!Number.isInteger(input.timestamp)) throw new Error("timestamp must be unix seconds");
  if (!Number.isFinite(input.fairValue) || input.fairValue < 0) {
    throw new Error("fairValue must be a finite non-negative number");
  }
  const fv = input.fairValue.toFixed(8);
  return `${input.tokenId}|${input.cycleId}|${fv}|${input.confidence}|${input.timestamp}`;
}

export function hashLeaf(input: LeafInput): Hex {
  return keccak256(stringToHex(canonicalLeafString(input)));
}

function hashPair(a: Hex, b: Hex): Hex {
  const [lo, hi] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([lo, hi]));
}

export interface MerkleTree {
  leaves: Hex[];
  // levels[0] is the leaf level, last level has the single root.
  levels: Hex[][];
  root: Hex;
}

export function buildTree(leaves: Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error("cannot build a tree from zero leaves");
  const levels: Hex[][] = [leaves.slice()];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 < prev.length) {
        next.push(hashPair(prev[i]!, prev[i + 1]!));
      } else {
        // odd node promoted unchanged
        next.push(prev[i]!);
      }
    }
    levels.push(next);
  }
  return { leaves: levels[0]!, levels, root: levels[levels.length - 1]![0]! };
}

export function proofForIndex(tree: MerkleTree, index: number): Hex[] {
  if (index < 0 || index >= tree.leaves.length) {
    throw new Error(`leaf index ${index} out of range`);
  }
  const proof: Hex[] = [];
  let idx = index;
  for (let level = 0; level < tree.levels.length - 1; level++) {
    const nodes = tree.levels[level]!;
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sibling < nodes.length) {
      proof.push(nodes[sibling]!);
    }
    // promoted odd nodes carry no sibling at this level
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed = hashPair(computed, sibling);
  }
  return computed.toLowerCase() === root.toLowerCase();
}
