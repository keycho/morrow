// tiny migration runner. no framework.
//
// applies every migrations/NNNN_*.sql in numeric order, once, inside a
// transaction, and records applied files in schema_migrations. safe to run on
// every boot.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, closeDb } from "./db.js";
import { log } from "./log.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export async function migrate(): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    (await sql<{ name: string }[]>`select name from schema_migrations`).map(
      (r) => r.name,
    ),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    log.info(`applying migration ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
  }
  log.info(`migrations up to date, ${files.length} file(s) present`);
}

// allow `tsx src/migrate.ts` as a standalone step.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      log.error(`migration failed: ${String(err)}`);
      process.exit(1);
    });
}
