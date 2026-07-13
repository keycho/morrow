// commit publisher. every cycle, the fair value outputs become canonical
// merkle leaves; the sorted-pair keccak256 root goes on-chain through
// MorrowCommits.commit, and the full leaf set is persisted so the api can
// serve proofs for any historical observation.
//
// the publisher key comes from PUBLISHER_PRIVATE_KEY (env only, never
// logged). in mock mode, or when the publisher is not yet configured, roots
// are still built and stored so the proof pipeline works end to end; only
// the on-chain send is skipped.

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseAbi,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain as chainConfig, mockMode, ops } from "@morrow/config";
import { buildTree, canonicalLeafString, hashLeaf, type LeafInput } from "@morrow/engine";
import type { OpsAlerter } from "@morrow/telegram/ops";
import type { CycleOutcome } from "./cycle.js";
import {
  listUnconfirmedCommits,
  markCommitStatus,
  upsertCommit,
  writeHeartbeat,
  type CommitLeafRecord,
} from "./db.js";
import { log } from "./log.js";

const commitsAbi = parseAbi([
  "function commit(bytes32 merkleRoot, uint64 cycleId, uint64 observationCount)",
  "function getCommit(uint64 cycleId) view returns (bytes32 merkleRoot, uint64 observationCount, uint64 committedAt)",
]);

function isPublisherConfigured(): boolean {
  return (
    !mockMode &&
    typeof process.env.PUBLISHER_PRIVATE_KEY === "string" &&
    process.env.PUBLISHER_PRIVATE_KEY.length > 0 &&
    !chainConfig.commitsContract.includes("PLACEHOLDER") &&
    chainConfig.chainId !== 0
  );
}

let warnedUnconfigured = false;

function robinhoodChain(): Chain {
  return defineChain({
    id: chainConfig.chainId,
    name: chainConfig.name,
    nativeCurrency: { name: "ether", symbol: "eth", decimals: 18 },
    rpcUrls: { default: { http: [chainConfig.rpcUrl] } },
  });
}

function buildLeafRecords(outcome: CycleOutcome): { records: CommitLeafRecord[]; leafHashes: Hex[] } {
  // canonical order: ascending token id. the stored order is the proof order.
  const sorted = [...outcome.rows].sort((a, b) => a.tokenId - b.tokenId);
  const records: CommitLeafRecord[] = [];
  const leafHashes: Hex[] = [];
  for (const row of sorted) {
    const input: LeafInput = {
      tokenId: row.tokenId,
      cycleId: row.cycleId,
      fairValue: row.fairValue,
      confidence: row.confidence,
      timestamp: Math.floor(row.ts.getTime() / 1000),
    };
    const leaf = hashLeaf(input);
    records.push({
      tokenId: input.tokenId,
      cycleId: input.cycleId,
      // persist the canonical 8dp string, exactly what was hashed
      fairValue: canonicalLeafString(input).split("|")[2] as string,
      confidence: input.confidence,
      timestamp: input.timestamp,
      leaf,
    });
    leafHashes.push(leaf);
  }
  return { records, leafHashes };
}

async function sendCommit(
  cycleId: number,
  root: Hex,
  observationCount: number
): Promise<{ txHash: string | null; confirmed: boolean }> {
  const account = privateKeyToAccount(process.env.PUBLISHER_PRIVATE_KEY as Hex);
  const chain = robinhoodChain();
  const wallet = createWalletClient({ account, chain, transport: http(chainConfig.rpcUrl) });
  const reader = createPublicClient({ chain, transport: http(chainConfig.rpcUrl) });

  // if this cycle already landed (restart, race), confirm instead of resending
  const existing = await reader.readContract({
    address: chainConfig.commitsContract,
    abi: commitsAbi,
    functionName: "getCommit",
    args: [BigInt(cycleId)],
  });
  const existingRoot = existing[0] as Hex;
  if (existingRoot !== `0x${"0".repeat(64)}`) {
    const matches = existingRoot.toLowerCase() === root.toLowerCase();
    if (!matches) {
      log.error("cycle already committed on-chain with a different root", {
        cycleId,
        onchain: existingRoot,
        local: root,
      });
    }
    return { txHash: null, confirmed: matches };
  }

  const txHash = await wallet.writeContract({
    address: chainConfig.commitsContract,
    abi: commitsAbi,
    functionName: "commit",
    args: [root, BigInt(cycleId), BigInt(observationCount)],
  });
  const receipt = await reader.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  return { txHash, confirmed: receipt.status === "success" };
}

export async function publishCycle(outcome: CycleOutcome, alerter?: OpsAlerter): Promise<void> {
  if (outcome.rows.length === 0) {
    log.warn("no fair values this cycle, nothing to commit", { cycleId: outcome.cycleId });
    return;
  }

  const { records, leafHashes } = buildLeafRecords(outcome);
  const tree = buildTree(leafHashes);

  if (!isPublisherConfigured()) {
    // store the commit so proofs work; mark confirmed in mock mode, pending
    // when the publisher simply is not wired yet.
    const status = mockMode ? "confirmed" : "pending";
    await upsertCommit(outcome.cycleId, tree.root, records.length, records, status);
    if (!mockMode && !warnedUnconfigured) {
      warnedUnconfigured = true;
      log.warn(
        "publisher not configured (PUBLISHER_PRIVATE_KEY / MORROW_COMMITS_ADDRESS / MORROW_CHAIN_ID); storing commits as pending"
      );
    }
    await writeHeartbeat("publisher", true, {
      cycleId: outcome.cycleId,
      root: tree.root,
      observationCount: records.length,
      onchain: false,
      mockMode,
    });
    return;
  }

  await upsertCommit(outcome.cycleId, tree.root, records.length, records, "pending");
  try {
    const { txHash, confirmed } = await sendCommit(outcome.cycleId, tree.root, records.length);
    await markCommitStatus(outcome.cycleId, confirmed ? "confirmed" : "failed", txHash);
    await writeHeartbeat("publisher", confirmed, {
      cycleId: outcome.cycleId,
      root: tree.root,
      observationCount: records.length,
      txHash,
      onchain: true,
    });
    if (confirmed) {
      log.info("commit published", { cycleId: outcome.cycleId, root: tree.root, txHash });
      await alerter?.resolve("publisher-commit", "commit publishing recovered");
    } else {
      log.error("commit tx reverted", { cycleId: outcome.cycleId, txHash });
      await alerter?.alert({
        key: "publisher-commit",
        severity: "page",
        title: "commit tx reverted",
        message: `cycle ${outcome.cycleId} commit tx did not confirm`,
        detail: { cycleId: outcome.cycleId, txHash },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markCommitStatus(outcome.cycleId, "failed", null);
    await writeHeartbeat("publisher", false, { cycleId: outcome.cycleId, error: message });
    log.error("commit publish failed, will retry via reconcile", {
      cycleId: outcome.cycleId,
      message,
    });
    await alerter?.alert({
      key: "publisher-commit",
      severity: "page",
      title: "commit publish failed",
      message: `cycle ${outcome.cycleId}: ${message}`,
      detail: { cycleId: outcome.cycleId },
    });
  }
}

// publisher wallet gas runway. throttled to one rpc balance read per monitor
// interval. pages when the balance drops below the floor, estimating how many
// commits of runway remain, and resolves when it recovers.
let lastBalanceCheckMs = Number.NEGATIVE_INFINITY;

export async function checkPublisherBalance(alerter: OpsAlerter): Promise<void> {
  if (!isPublisherConfigured()) return;
  const now = Date.now();
  if (now - lastBalanceCheckMs < ops.monitorIntervalMs) return;
  lastBalanceCheckMs = now;

  const account = privateKeyToAccount(process.env.PUBLISHER_PRIVATE_KEY as Hex);
  const reader = createPublicClient({ chain: robinhoodChain(), transport: http(chainConfig.rpcUrl) });
  const balanceWei = await reader.getBalance({ address: account.address });
  const balanceEth = Number(formatEther(balanceWei));
  const runwayCommits =
    ops.gasPerCommitEth > 0 ? Math.floor(balanceEth / ops.gasPerCommitEth) : 0;

  if (balanceEth < ops.publisherBalanceFloorEth) {
    await alerter.alert({
      key: "publisher-balance",
      severity: "page",
      title: "publisher wallet low",
      message: `balance ${balanceEth.toFixed(5)} eth below floor ${ops.publisherBalanceFloorEth} eth, about ${runwayCommits} commits of gas runway left`,
      detail: { address: account.address, balanceEth, runwayCommits },
    });
  } else {
    await alerter.resolve("publisher-balance", `balance recovered to ${balanceEth.toFixed(5)} eth`);
  }
}

// reconcile pass: pending or failed commits from the last day are checked
// against the chain and either confirmed (root already there) or resent.
export async function reconcileCommits(): Promise<void> {
  if (!isPublisherConfigured()) return;
  const unconfirmed = await listUnconfirmedCommits(24);
  for (const c of unconfirmed) {
    try {
      const { txHash, confirmed } = await sendCommit(
        c.cycleId,
        c.merkleRoot as Hex,
        c.observationCount
      );
      await markCommitStatus(c.cycleId, confirmed ? "confirmed" : "failed", txHash);
      if (confirmed) {
        log.info("reconciled commit", { cycleId: c.cycleId, txHash });
      }
    } catch (err) {
      log.warn("reconcile attempt failed", {
        cycleId: c.cycleId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
