// entrypoint. reads MODE and starts the right workers.
//
//   backfill  fill genesis..head via the work queue, then exit
//   tail      follow the head with reorg handling (runs forever)
//   tokens    resolve token metadata (runs forever)
//   both      backfill + tail + tokens together (default)
//
// migrations run first so a single railway process is self-contained.

import { migrate } from "./migrate.js";
import { runBackfill } from "./backfill.js";
import { runTail } from "./tail.js";
import { runTokens } from "./tokens.js";
import { closeDb } from "./db.js";
import { log } from "./log.js";

let stopping = false;
const stopped = () => stopping;

function shutdown(sig: string): void {
  if (stopping) return;
  stopping = true;
  log.info(`received ${sig}, shutting down`);
  // safety net if a worker is wedged in a long await.
  setTimeout(() => {
    log.warn("forced exit after shutdown timeout");
    process.exit(0);
  }, 20_000).unref();
}

process.on("SIGINT", () => shutdown("sigint"));
process.on("SIGTERM", () => shutdown("sigterm"));

async function main(): Promise<void> {
  const mode = (process.env.MODE ?? "both").toLowerCase();
  log.info(`rhscan starting in mode ${mode}`);

  await migrate();

  const tasks: Promise<void>[] = [];
  if (mode === "backfill" || mode === "both") tasks.push(runBackfill(stopped));
  if (mode === "tail" || mode === "both") tasks.push(runTail(stopped));
  if (mode === "tokens" || mode === "both") tasks.push(runTokens(stopped));

  if (tasks.length === 0) {
    throw new Error(`unknown MODE '${mode}', expected backfill|tail|both|tokens`);
  }

  await Promise.all(tasks);
}

main()
  .then(async () => {
    await closeDb();
    log.info("rhscan exited cleanly");
    process.exit(0);
  })
  .catch(async (err) => {
    log.error(`fatal: ${String(err)}`);
    await closeDb();
    process.exit(1);
  });
