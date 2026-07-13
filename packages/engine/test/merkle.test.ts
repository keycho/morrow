import { describe, expect, it } from "vitest";
import {
  buildTree,
  canonicalLeafString,
  cycleIdFor,
  hashLeaf,
  proofForIndex,
  verifyProof,
  type LeafInput,
} from "../src/index.js";

function leaf(tokenId: number, cycleId = 2_950_000): LeafInput {
  return {
    tokenId,
    cycleId,
    fairValue: 100 + tokenId * 7.13,
    confidence: 80 + tokenId,
    timestamp: 1_770_000_000 + tokenId,
  };
}

describe("canonical leaves", () => {
  it("pins the canonical string format", () => {
    expect(
      canonicalLeafString({
        tokenId: 1,
        cycleId: 2_950_000,
        fairValue: 249.12345678,
        confidence: 87,
        timestamp: 1_770_000_000,
      })
    ).toBe("1|2950000|249.12345678|87|1770000000");
  });

  it("always renders eight decimals", () => {
    expect(canonicalLeafString(leaf(0)).split("|")[2]).toBe("100.00000000");
  });

  it("hashes deterministically and distinctly", () => {
    const a = hashLeaf(leaf(1));
    const b = hashLeaf(leaf(1));
    const c = hashLeaf(leaf(2));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects non-integer fields", () => {
    expect(() => canonicalLeafString({ ...leaf(1), confidence: 87.5 })).toThrow();
    expect(() => canonicalLeafString({ ...leaf(1), timestamp: 1.5 })).toThrow();
  });
});

describe("merkle tree", () => {
  it("round-trips proofs for every leaf at sizes 1 through 8", () => {
    for (let n = 1; n <= 8; n++) {
      const leaves = Array.from({ length: n }, (_, i) => hashLeaf(leaf(i + 1)));
      const tree = buildTree(leaves);
      for (let i = 0; i < n; i++) {
        const proof = proofForIndex(tree, i);
        expect(verifyProof(leaves[i]!, proof, tree.root)).toBe(true);
      }
    }
  });

  it("rejects a tampered leaf", () => {
    const leaves = Array.from({ length: 5 }, (_, i) => hashLeaf(leaf(i + 1)));
    const tree = buildTree(leaves);
    const proof = proofForIndex(tree, 2);
    const tampered = hashLeaf({ ...leaf(3), fairValue: 999.99 });
    expect(verifyProof(tampered, proof, tree.root)).toBe(false);
  });

  it("rejects a proof against the wrong root", () => {
    const treeA = buildTree([hashLeaf(leaf(1)), hashLeaf(leaf(2))]);
    const treeB = buildTree([hashLeaf(leaf(3)), hashLeaf(leaf(4))]);
    const proof = proofForIndex(treeA, 0);
    expect(verifyProof(hashLeaf(leaf(1)), proof, treeB.root)).toBe(false);
  });

  it("is order-sensitive at the root", () => {
    const a = buildTree([hashLeaf(leaf(1)), hashLeaf(leaf(2)), hashLeaf(leaf(3))]);
    const b = buildTree([hashLeaf(leaf(3)), hashLeaf(leaf(2)), hashLeaf(leaf(1))]);
    // sorted-pair hashing makes single pairs order-free, but the tree shape
    // over three leaves differs, so roots differ
    expect(a.root).not.toBe(b.root);
  });

  it("refuses an empty tree", () => {
    expect(() => buildTree([])).toThrow();
  });
});

describe("cycle arithmetic", () => {
  it("buckets unix time into cycles", () => {
    expect(cycleIdFor(0, 600)).toBe(0);
    expect(cycleIdFor(599_999, 600)).toBe(0);
    expect(cycleIdFor(600_000, 600)).toBe(1);
    expect(cycleIdFor(1_770_000_000_000, 600)).toBe(2_950_000);
  });
});
