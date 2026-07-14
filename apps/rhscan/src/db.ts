// postgres.js connection and insert helpers.
//
// DATABASE_URL is a secret (supabase), env only. writes go through
// insertBatch, which does multi-row `insert ... on conflict do nothing` so every
// write path is idempotent and backfill and tail can overlap safely. inserts
// are chunked to stay under postgres' 65535 bind-parameter limit, so a busy
// 200-block range still writes correctly even when a single table has tens of
// thousands of rows.

import postgres from "postgres";
import { log } from "./log.js";
import { COLUMNS, type BlockRows } from "./transform.js";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set, see .env.example");
}

// backfill runs CONCURRENCY workers, each of which needs a connection while it
// writes its range, so the pool is sized off CONCURRENCY with headroom for the
// tail and token workers.
const DB_MAX = Number(
  process.env.DB_POOL_MAX ?? Number(process.env.CONCURRENCY ?? 50) + 6,
);

export const sql = postgres(url, {
  max: DB_MAX,
  idle_timeout: 30,
  connect_timeout: 15,
  // bigint columns come back as strings; we never do math on them in-process.
  onnotice: () => {},
});

export type Executor = postgres.Sql | postgres.TransactionSql;

const MAX_BIND_PARAMS = 60_000;

// multi-row insert with on conflict do nothing, chunked so params stay under the
// wire protocol limit. columns is the exact key set present on every row.
export async function insertBatch(
  exec: Executor,
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  const perRow = columns.length;
  const chunkSize = Math.max(1, Math.floor(MAX_BIND_PARAMS / perRow));
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    // exec(...) is the same object used for the tagged template below.
    await exec`insert into ${exec(table)} ${exec(
      chunk as Record<string, unknown>[],
      ...(columns as string[]),
    )} on conflict do nothing`;
  }
}

// write a set of already-transformed blocks in one transaction, one chunked
// insert per table. used by backfill (a whole range), tail (a small batch) and
// the cold-path resolver. every insert is on conflict do nothing, so overlap
// between workers and re-processing after a crash are both safe.
//
// when cold is true, every row gets cold = true so the pruner leaves it alone.
// on conflict do nothing means re-caching a block that is already indexed
// (cold = false) never flips it to cold, and vice versa.
export async function writeBlocks(
  exec: Executor,
  blocks: readonly BlockRows[],
  opts: { cold?: boolean } = {},
): Promise<void> {
  if (blocks.length === 0) return;
  const cold = opts.cold ?? false;
  const flat = <K extends keyof BlockRows>(k: K) =>
    blocks.flatMap((b) => b[k] as Record<string, unknown>[]);

  // blocks, transactions and their children carry the cold flag; contracts is
  // never pruned (keyed by address, not block) so it has no cold column.
  const write = async (
    table: string,
    cols: readonly string[],
    rows: Record<string, unknown>[],
    coldable: boolean,
  ) => {
    if (coldable && cold) {
      await insertBatch(
        exec,
        table,
        [...cols, "cold"],
        rows.map((r) => ({ ...r, cold: true })),
      );
    } else {
      await insertBatch(exec, table, cols, rows);
    }
  };

  await write("blocks", COLUMNS.blocks, blocks.map((b) => b.block), true);
  await write("transactions", COLUMNS.transactions, flat("transactions"), true);
  await write("logs", COLUMNS.logs, flat("logs"), true);
  await write("token_transfers", COLUMNS.token_transfers, flat("tokenTransfers"), true);
  await write(
    "address_transactions",
    COLUMNS.address_transactions,
    flat("addressTxns"),
    true,
  );
  await write("contracts", COLUMNS.contracts, flat("contracts"), false);
}

export async function closeDb(): Promise<void> {
  try {
    await sql.end({ timeout: 5 });
  } catch (err) {
    log.warn(`error closing db: ${String(err)}`);
  }
}
