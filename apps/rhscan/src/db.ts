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
// insert per table. used by both backfill (a whole range) and tail (a small
// batch). every insert is on conflict do nothing, so overlap between workers
// and re-processing after a crash are both safe.
export async function writeBlocks(
  exec: Executor,
  blocks: readonly BlockRows[],
): Promise<void> {
  if (blocks.length === 0) return;
  const flat = <K extends keyof BlockRows>(k: K) =>
    blocks.flatMap((b) => b[k] as Record<string, unknown>[]);

  await insertBatch(exec, "blocks", COLUMNS.blocks, blocks.map((b) => b.block));
  await insertBatch(exec, "transactions", COLUMNS.transactions, flat("transactions"));
  await insertBatch(exec, "logs", COLUMNS.logs, flat("logs"));
  await insertBatch(
    exec,
    "token_transfers",
    COLUMNS.token_transfers,
    flat("tokenTransfers"),
  );
  await insertBatch(
    exec,
    "address_transactions",
    COLUMNS.address_transactions,
    flat("addressTxns"),
  );
  await insertBatch(exec, "contracts", COLUMNS.contracts, flat("contracts"));
}

export async function closeDb(): Promise<void> {
  try {
    await sql.end({ timeout: 5 });
  } catch (err) {
    log.warn(`error closing db: ${String(err)}`);
  }
}
