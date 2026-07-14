// client-side chain reads for the explorer. the verify control recomputes the
// leaf hash and folds the merkle proof in the browser, then checks the root
// against the deployed MorrowCommits contract over rpc; the api is never in
// the trust path. the explorer's committed-root count also reads the contract
// directly (commitCount / latestCycleId), never a server number.

"use client";

import {
  createPublicClient,
  http,
  defineChain,
  concat,
  keccak256,
  stringToHex,
  getAddress,
  type Hex,
  type Address,
} from "viem";
import { RPC_URL, CHAIN_ID, COMMITS_ADDRESS } from "./constants";

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "robinhood chain",
  nativeCurrency: { name: "ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC_URL),
});

// only the read surface the dashboard needs. mirrors MorrowCommits.sol.
export const MORROW_COMMITS_ABI = [
  {
    type: "function",
    name: "getCommit",
    stateMutability: "view",
    inputs: [{ name: "cycleId", type: "uint64" }],
    outputs: [
      { name: "merkleRoot", type: "bytes32" },
      { name: "observationCount", type: "uint64" },
      { name: "committedAt", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "verify",
    stateMutability: "view",
    inputs: [
      { name: "leaf", type: "bytes32" },
      { name: "proof", type: "bytes32[]" },
      { name: "cycleId", type: "uint64" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "commitCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "latestCycleId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
] as const;

const ZERO_ROOT = "0x0000000000000000000000000000000000000000000000000000000000000000";

// resolve the contract address to read against. prefer the deployment's own
// configured address; fall back to the address the api reports inside a proof
// payload. returns null when neither is available (the ui then says so plainly).
export function resolveCommitsAddress(fallback?: string | null): Address | null {
  const raw = (COMMITS_ADDRESS || fallback || "").trim();
  if (!raw) return null;
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
}

// --- pure client-side merkle math (identical to packages/engine/src/merkle.ts) ---

// rebuild the canonical leaf string from the structured fields, so verification
// never depends on the api's own canonicalString.
export function canonicalLeafString(fields: {
  tokenId: number;
  cycleId: number;
  fairValue: string; // fixed 8-decimal string
  confidence: number;
  timestamp: number;
}): string {
  return `${fields.tokenId}|${fields.cycleId}|${fields.fairValue}|${fields.confidence}|${fields.timestamp}`;
}

export function hashLeafString(canonical: string): Hex {
  return keccak256(stringToHex(canonical));
}

// sorted-pair keccak256 fold; odd nodes carry no sibling in the proof.
export function foldProof(leaf: Hex, proof: Hex[]): Hex {
  let node = leaf;
  for (const sibling of proof) {
    const [lo, hi] =
      node.toLowerCase() <= sibling.toLowerCase() ? [node, sibling] : [sibling, node];
    node = keccak256(concat([lo, hi]));
  }
  return node;
}

// --- rpc reads ---

export interface OnchainCommit {
  merkleRoot: Hex;
  observationCount: number;
  committedAt: number;
  exists: boolean;
}

// read the committed root for a cycle straight from the contract. a zero root
// means the cycle was never committed on chain.
export async function readOnchainCommit(
  address: Address,
  cycleId: number
): Promise<OnchainCommit> {
  const [merkleRoot, observationCount, committedAt] = (await publicClient.readContract({
    address,
    abi: MORROW_COMMITS_ABI,
    functionName: "getCommit",
    args: [BigInt(cycleId)],
  })) as [Hex, bigint, bigint];
  return {
    merkleRoot,
    observationCount: Number(observationCount),
    committedAt: Number(committedAt),
    exists: merkleRoot.toLowerCase() !== ZERO_ROOT,
  };
}

// second, independent check: let the contract fold the proof itself and return
// a bool. reverts on an unknown cycle, which we surface as "not on chain".
export async function readOnchainVerify(
  address: Address,
  leaf: Hex,
  proof: Hex[],
  cycleId: number
): Promise<boolean> {
  return (await publicClient.readContract({
    address,
    abi: MORROW_COMMITS_ABI,
    functionName: "verify",
    args: [leaf, proof as readonly Hex[], BigInt(cycleId)],
  })) as boolean;
}

export interface ContractStats {
  commitCount: number;
  latestCycleId: number;
}

// the explorer's committed-root count, read from the contract, not the api.
export async function readContractStats(address: Address): Promise<ContractStats> {
  const [commitCount, latestCycleId] = (await Promise.all([
    publicClient.readContract({
      address,
      abi: MORROW_COMMITS_ABI,
      functionName: "commitCount",
    }),
    publicClient.readContract({
      address,
      abi: MORROW_COMMITS_ABI,
      functionName: "latestCycleId",
    }),
  ])) as [bigint, bigint];
  return { commitCount: Number(commitCount), latestCycleId: Number(latestCycleId) };
}
