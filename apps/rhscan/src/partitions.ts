// partition management for the range-partitioned window tables.
//
// partitions are PARTITION_SIZE blocks wide, deterministically named
// <parent>_p<idx> where idx = floor(block / PARTITION_SIZE). a maintenance job
// creates partitions ahead of the head so the tail never writes into a missing
// range, and the pruner drops whole partitions once they are entirely below the
// window floor: instant, and disk goes straight back to the os.

import { sql } from "./db.js";
import { getHead } from "./chain.js";
import { log } from "./log.js";

export const PARTITION_SIZE = Number(process.env.PARTITION_SIZE ?? 500_000);
const AHEAD_PARTITIONS = Number(process.env.AHEAD_PARTITIONS ?? 2);
const MAINTAIN_INTERVAL_MS = Number(process.env.PARTITION_MAINTAIN_MS ?? 60_000);

export const PARTITIONED_TABLES = [
  "blocks",
  "transactions",
  "logs",
  "token_transfers",
  "address_transactions",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function partitionIndex(block: number): number {
  return Math.floor(block / PARTITION_SIZE);
}

// create partitions for every index covering [fromBlock, toBlock], idempotent.
export async function ensurePartitions(
  fromBlock: number,
  toBlock: number,
): Promise<void> {
  const lo = partitionIndex(Math.max(0, fromBlock));
  const hi = partitionIndex(Math.max(0, toBlock));
  for (let idx = lo; idx <= hi; idx += 1) {
    const from = idx * PARTITION_SIZE;
    const to = (idx + 1) * PARTITION_SIZE;
    for (const parent of PARTITIONED_TABLES) {
      await sql.unsafe(
        `create table if not exists ${parent}_p${idx}
           partition of ${parent} for values from (${from}) to (${to})`,
      );
    }
  }
}

// drop every partition whose whole range is strictly below the floor.
export async function dropPartitionsBelow(floor: number): Promise<number> {
  let dropped = 0;
  for (const parent of PARTITIONED_TABLES) {
    const children = await sql<{ relname: string }[]>`
      select c.relname
        from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        join pg_class p on p.oid = i.inhparent
       where p.relname = ${parent}
    `;
    for (const { relname } of children) {
      const m = relname.match(/_p(\d+)$/);
      if (!m) continue;
      const idx = Number(m[1]);
      const upper = (idx + 1) * PARTITION_SIZE;
      if (upper <= floor) {
        await sql.unsafe(`drop table if exists ${relname}`);
        dropped += 1;
      }
    }
  }
  return dropped;
}

// keep partitions present around the head and AHEAD_PARTITIONS beyond it, so the
// tail never writes into a missing range. backfill and tail also create their
// own ranges directly; this is the always-on safety net near the head.
export async function ensureAhead(): Promise<void> {
  const head = await getHead();
  await ensurePartitions(
    Math.max(0, head - PARTITION_SIZE),
    head + AHEAD_PARTITIONS * PARTITION_SIZE,
  );
}

export async function runPartitionMaintainer(
  stopped: () => boolean = () => false,
): Promise<void> {
  log.info(
    `partition maintainer started, size ${PARTITION_SIZE}, ${AHEAD_PARTITIONS} ahead`,
  );
  while (!stopped()) {
    try {
      await ensureAhead();
    } catch (err) {
      log.error(`partition maintenance failed: ${String(err)}`);
    }
    const wakeAt = Date.now() + MAINTAIN_INTERVAL_MS;
    while (!stopped() && Date.now() < wakeAt) await sleep(1000);
  }
  log.info("partition maintainer stopped");
}
