// tail worker: follow the head, handle reorgs.
//
// orbit blocks are fast, so on catch-up we process a batch of blocks per poll
// rather than one at a time. before writing, every block's parent_hash is
// checked against the previous block's hash. a mismatch means a reorg: we walk
// back to the last block whose stored hash still matches the chain, delete every
// row above it across all tables, rewind, and resume. an unhandled reorg is
// silently corrupt data forever, which is worse than being slow.

import { getBlockByNumber, getBlockReceipts, getHead } from "./chain.js";
import { sql, writeBlocks, type Executor } from "./db.js";
import { transformBlock } from "./transform.js";
import { log } from "./log.js";
import { ensurePartitions } from "./partitions.js";

const POLL_MS = Number(process.env.POLL_MS ?? 1000);
const TAIL_BATCH = Number(process.env.TAIL_BATCH ?? 100);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function storedHash(n: number): Promise<string | null> {
  if (n < 0) return null;
  const rows = await sql<{ hash: string }[]>`
    select hash from blocks where number = ${n}
  `;
  return rows[0]?.hash ?? null;
}

async function getLast(): Promise<number> {
  const rows = await sql<{ last_indexed_block: string }[]>`
    select last_indexed_block from sync_state where worker = 'tail'
  `;
  return Number(rows[0]!.last_indexed_block);
}

async function setLast(exec: Executor, n: number): Promise<void> {
  await exec`
    update sync_state set last_indexed_block = ${n}, updated_at = now()
     where worker = 'tail'
  `;
}

async function initSyncState(): Promise<void> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from sync_state where worker = 'tail'
  `;
  if ((rows[0]?.n ?? 0) > 0) return;
  // tail begins at the current head; backfill fills history below it.
  const head = await getHead();
  await sql`
    insert into sync_state (worker, last_indexed_block, updated_at)
    values ('tail', ${head}, now())
    on conflict (worker) do nothing
  `;
  log.info(`tail initialized at head ${head}`);
}

// delete every window row for blocks above n across all tables, rewind
// sync_state, and invalidate balances for any token whose transfers were rolled
// back so it re-hydrates from scratch (reversing incremental deltas exactly is
// not worth it; re-hydration is authoritative). cold_* rows are untouched.
async function deleteAbove(n: number): Promise<void> {
  await sql.begin(async (tx) => {
    // tokens touched by the rolled-back range, captured before the delete.
    const affected = await tx<{ token_address: string }[]>`
      select distinct token_address from token_transfers where block_number > ${n}
    `;
    await tx`delete from address_transactions where block_number > ${n}`;
    await tx`delete from token_transfers where block_number > ${n}`;
    await tx`delete from logs where block_number > ${n}`;
    await tx`delete from tx_locations where block_number > ${n}`;
    await tx`delete from transactions where block_number > ${n}`;
    await tx`delete from block_locations where block_number > ${n}`;
    await tx`delete from contracts where creation_block > ${n}`;
    await tx`delete from blocks where number > ${n}`;

    if (affected.length > 0) {
      // drop hydration state so these tokens re-hydrate from scratch (delete
      // token_hydration removes the hydrated_at_block that gates incremental
      // deltas, and eager enqueue will re-queue them).
      const addrs = affected.map((a) => a.token_address);
      await tx`delete from token_balances where token_address in ${tx(addrs)}`;
      await tx`delete from token_hydration where token_address in ${tx(addrs)}`;
    }
    await setLast(tx, n);
  });
}

// walk back from `startFrom` to the last block whose stored hash still matches
// the canonical chain, delete everything above it, and return the new head.
async function handleReorg(startFrom: number): Promise<number> {
  log.warn(`reorg detected at block ${startFrom + 1}, walking back`);
  let n = startFrom;
  while (n >= 0) {
    const stored = await storedHash(n);
    if (stored == null) {
      n -= 1;
      continue;
    }
    const chain = await getBlockByNumber(n);
    if (stored === chain.hash.toLowerCase()) break;
    n -= 1;
  }
  const ancestor = Math.max(n, -1);
  await deleteAbove(ancestor);
  log.warn(`reorg resolved, rewound to block ${ancestor}`);
  return ancestor;
}

// fetch, validate and write [from..to]. returns 'reorg' if a parent-hash
// mismatch was found (nothing written), otherwise 'ok'.
async function processBatch(
  from: number,
  to: number,
  last: number,
): Promise<"ok" | "reorg"> {
  const nums: number[] = [];
  for (let n = from; n <= to; n += 1) nums.push(n);

  // make sure partitions exist for this range before writing into them.
  await ensurePartitions(from, to);

  const [blocks, receipts] = await Promise.all([
    Promise.all(nums.map((n) => getBlockByNumber(n))),
    Promise.all(nums.map((n) => getBlockReceipts(n))),
  ]);

  // validate the chain links before writing anything.
  let prevHash = await storedHash(last);
  for (const b of blocks) {
    const parent = b.parentHash.toLowerCase();
    if (prevHash != null && parent !== prevHash) return "reorg";
    prevHash = b.hash.toLowerCase();
  }

  const rows = blocks.map((b, i) => transformBlock(b, receipts[i]!));
  await sql.begin(async (tx) => {
    await writeBlocks(tx, rows);
    await setLast(tx, to);
  });
  return "ok";
}

export async function runTail(stopped: () => boolean = () => false): Promise<void> {
  await initSyncState();
  log.info(`tail started, poll ${POLL_MS}ms, batch ${TAIL_BATCH}`);

  while (!stopped()) {
    try {
      const head = await getHead();
      let last = await getLast();

      if (head <= last) {
        await sleep(POLL_MS);
        continue;
      }

      // process at most one batch per iteration so reorg checks stay tight.
      const from = last + 1;
      const to = Math.min(head, from + TAIL_BATCH - 1);
      const result = await processBatch(from, to, last);
      if (result === "reorg") {
        last = await handleReorg(last);
        continue;
      }
      // if we are caught up, wait for the next block; otherwise keep draining.
      if (to >= head) await sleep(POLL_MS);
    } catch (err) {
      log.error(`tail iteration error, retrying: ${String(err)}`);
      await sleep(POLL_MS);
    }
  }
  log.info("tail stopped");
}
