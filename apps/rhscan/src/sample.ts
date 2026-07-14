// pnpm sample: measure the shape of the chain over its whole life, not a
// photograph of one afternoon near the head.
//
// takes 200 blocks spread evenly from block 1 to head, decodes each with the
// real transform.ts, buckets by decile of block height, and prints density and
// implied gb/day per decile. storage bytes are modeled from per-row costs
// measured on day 2 (heap plus read indexes), so the gb/day here is directly
// comparable to the day-2 estimate.

import { getBlockByNumber, getBlockReceipts, getHead } from "./chain.js";
import { transformBlock } from "./transform.js";
import { log } from "./log.js";

const SAMPLES = Number(process.env.SAMPLES ?? 200);
const DECILES = 10;
const CHUNK = 10;

// per-row stored bytes (heap + read indexes), measured on the day-2 sample:
// pg_total_relation_size(table) / rows. used to model storage from row counts.
const ROW_BYTES = {
  block: 400,
  tx: 950,
  log: 530,
  transfer: 376,
  addrRow: 392,
};

interface BlockMetrics {
  number: number;
  timestamp: number;
  txns: number;
  logs: number;
  transfers: number;
  addrRows: number;
  calldataBytes: number;
}

function storageBytes(m: {
  txns: number;
  logs: number;
  transfers: number;
  addrRows: number;
}): number {
  return (
    ROW_BYTES.block +
    ROW_BYTES.tx * m.txns +
    ROW_BYTES.log * m.logs +
    ROW_BYTES.transfer * m.transfers +
    ROW_BYTES.addrRow * m.addrRows
  );
}

async function measureBlock(n: number): Promise<BlockMetrics> {
  const [block, receipts] = await Promise.all([
    getBlockByNumber(n),
    getBlockReceipts(n),
  ]);
  const rows = transformBlock(block, receipts);
  const timestamp = Number(BigInt(block.timestamp));
  const calldataBytes = block.transactions.reduce(
    (sum, t) => sum + (t.input.length - 2) / 2,
    0,
  );
  return {
    number: n,
    timestamp,
    txns: block.transactions.length,
    logs: rows.logs.length,
    transfers: rows.tokenTransfers.length,
    addrRows: rows.addressTxns.length,
    calldataBytes,
  };
}

function fmtDate(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

function pad(s: string | number, n: number): string {
  return String(s).padStart(n);
}

async function main() {
  const head = await getHead();
  log.info(`sampling ${SAMPLES} blocks from 1 to ${head}`);

  const targets: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const n = 1 + Math.round((i * (head - 1)) / (SAMPLES - 1));
    targets.push(n);
  }

  const metrics: BlockMetrics[] = [];
  for (let i = 0; i < targets.length; i += CHUNK) {
    const slice = targets.slice(i, i + CHUNK);
    const got = await Promise.all(slice.map((n) => measureBlock(n)));
    metrics.push(...got);
    log.info(`sampled ${metrics.length}/${SAMPLES}`);
  }

  // bucket by decile of position (evenly spaced == decile of height).
  const perDecile = Math.floor(SAMPLES / DECILES);

  console.log(
    "\ndecile | block range           | date range            |  txns |  logs | xfers |  bytes | blk_s | GB/day",
  );
  console.log(
    "-------|-----------------------|-----------------------|-------|-------|-------|--------|-------|-------",
  );

  const totals = { txns: 0, logs: 0, transfers: 0, bytes: 0 };
  for (let d = 0; d < DECILES; d += 1) {
    const group = metrics.slice(d * perDecile, (d + 1) * perDecile);
    if (group.length === 0) continue;
    const n = group.length;
    const avgTx = group.reduce((s, m) => s + m.txns, 0) / n;
    const avgLogs = group.reduce((s, m) => s + m.logs, 0) / n;
    const avgXfer = group.reduce((s, m) => s + m.transfers, 0) / n;
    const avgAddr = group.reduce((s, m) => s + m.addrRows, 0) / n;
    const avgCalldata = group.reduce((s, m) => s + m.calldataBytes, 0) / n;
    const avgBytes = storageBytes({
      txns: avgTx,
      logs: avgLogs,
      transfers: avgXfer,
      addrRows: avgAddr,
    });
    const lo = group[0]!;
    const hi = group[group.length - 1]!;
    // block time from the decile span, not consecutive blocks: the chain's
    // timestamp resolution is 1 second, so sub-second block times only resolve
    // across a wide block range.
    const spanBlocks = hi.number - lo.number;
    const spanSec = hi.timestamp - lo.timestamp;
    const avgBlockTime = spanBlocks > 0 ? spanSec / spanBlocks : 0;
    const blocksPerDay = avgBlockTime > 0 ? 86400 / avgBlockTime : 0;
    const gbPerDay = (avgBytes * blocksPerDay) / 1e9;

    totals.txns += avgTx;
    totals.logs += avgLogs;
    totals.transfers += avgXfer;
    totals.bytes += avgBytes;

    console.log(
      `  ${pad(d + 1, 2)}   | ${pad(lo.number, 9)}-${pad(hi.number, 9)} | ` +
        `${fmtDate(lo.timestamp)} ${fmtDate(hi.timestamp)} | ` +
        `${pad(avgTx.toFixed(1), 5)} | ${pad(avgLogs.toFixed(1), 5)} | ` +
        `${pad(avgXfer.toFixed(1), 5)} | ${pad((avgBytes / 1024).toFixed(1) + "k", 6)} | ` +
        `${pad(avgBlockTime.toFixed(3), 5)} | ${pad(gbPerDay.toFixed(1), 6)} ` +
        `(calldata ${(avgCalldata / 1024).toFixed(1)}k)`,
    );
  }

  const meanBytes = totals.bytes / DECILES;
  console.log(
    `\nlifetime mean: ${(totals.txns / DECILES).toFixed(1)} txns/block, ` +
      `${(totals.logs / DECILES).toFixed(1)} logs/block, ` +
      `${(totals.transfers / DECILES).toFixed(1)} transfers/block, ` +
      `${(meanBytes / 1024).toFixed(1)}k bytes/block`,
  );
}

main().catch((e) => {
  log.error(String(e));
  process.exit(1);
});
