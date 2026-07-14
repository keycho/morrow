// build or drop the read-path indexes, concurrently, outside any transaction.
//
//   pnpm indexes:create   after the bulk window backfill has caught up
//   pnpm indexes:drop      before a fresh bulk load, to keep it write-bound
//
// read_indexes.sql is the single source of truth for the index set. create runs
// each statement as written; drop derives the index names from it.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, closeDb } from "./db.js";
import { log } from "./log.js";

const INDEX_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "read_indexes.sql",
);

async function statements(): Promise<string[]> {
  const text = await readFile(INDEX_FILE, "utf8");
  return text
    .split(";")
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

function indexName(createStmt: string): string | null {
  const m = createStmt.match(/if not exists\s+([a-z0-9_]+)/i);
  return m ? m[1]! : null;
}

async function create(): Promise<void> {
  const stmts = await statements();
  log.info(`creating ${stmts.length} read index(es) concurrently`);
  for (const stmt of stmts) {
    const name = indexName(stmt) ?? "(unnamed)";
    log.info(`create index ${name}`);
    // concurrently cannot run inside a transaction, so use unsafe (no begin).
    await sql.unsafe(stmt);
  }
  log.info("read indexes created");
}

async function drop(): Promise<void> {
  const stmts = await statements();
  log.info(`dropping ${stmts.length} read index(es) concurrently`);
  for (const stmt of stmts) {
    const name = indexName(stmt);
    if (!name) continue;
    log.info(`drop index ${name}`);
    await sql.unsafe(`drop index concurrently if exists ${name}`);
  }
  log.info("read indexes dropped");
}

const mode = process.argv[2];
const run = mode === "drop" ? drop : mode === "create" ? create : null;
if (!run) {
  log.error("usage: indexes.ts <create|drop>");
  process.exit(1);
}
run()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    log.error(`indexes ${mode} failed: ${String(err)}`);
    await closeDb();
    process.exit(1);
  });
