// pruner: roll the window forward so disk stays steady-state.
//
// a rolling window has to actually roll or the disk grows forever. on a schedule
// (default daily) we recompute the window floor from the current time and delete
// every row below it across the block-keyed tables, in block-number batches
// inside transactions so the tail worker is never locked out. cold rows (rpc
// lookups cached back in) are left in place. tokens and contracts are never
// pruned: they are small, keyed by address not block, and useful forever.
//
// vacuum (not full) runs after each batch group. postgres does not return the
// freed disk to the os, it reuses it for new rows, which is exactly what we want
// for a steady-state window.

import { getHead } from "./chain.js";
import { sql } from "./db.js";
import { log } from "./log.js";
import { findWindowFloor, setSyncValue, WINDOW_FLOOR_KEY } from "./window.js";

const PRUNE_INTERVAL_HOURS = Number(process.env.PRUNE_INTERVAL_HOURS ?? 24);
const PRUNE_BATCH = Number(process.env.PRUNE_BATCH ?? 5000);
const MIN_WINDOW_DAYS = 7;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// read WINDOW_DAYS from the raw env, not the defaulted value, so a missing or
// absurd env var refuses rather than silently wiping the database.
function guardWindowDays(): number | null {
  const raw = process.env.WINDOW_DAYS;
  if (raw == null || raw.trim() === "") {
    log.error("pruner refuses to run: WINDOW_DAYS is not set");
    return null;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_WINDOW_DAYS) {
    log.error(
      `pruner refuses to run: WINDOW_DAYS='${raw}' is absurd (must be at least ${MIN_WINDOW_DAYS})`,
    );
    return null;
  }
  return n;
}

async function lowestBlock(): Promise<number | null> {
  const rows = await sql<{ n: string | null }[]>`select min(number) as n from blocks`;
  return rows[0]?.n == null ? null : Number(rows[0].n);
}

// delete one block-number batch [lo, hi) across every block-keyed table, cold
// rows excluded, children before parents, in a single transaction.
async function pruneBatch(lo: number, hi: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from address_transactions where block_number >= ${lo} and block_number < ${hi} and not cold`;
    await tx`delete from token_transfers where block_number >= ${lo} and block_number < ${hi} and not cold`;
    await tx`delete from logs where block_number >= ${lo} and block_number < ${hi} and not cold`;
    await tx`delete from transactions where block_number >= ${lo} and block_number < ${hi} and not cold`;
    await tx`delete from blocks where number >= ${lo} and number < ${hi} and not cold`;
  });
}

async function vacuum(): Promise<void> {
  await sql.unsafe(
    "vacuum blocks, transactions, logs, token_transfers, address_transactions",
  );
}

export async function pruneOnce(): Promise<void> {
  const windowDays = guardWindowDays();
  if (windowDays == null) return;

  const head = await getHead();
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86_400;
  const floor = await findWindowFloor(head, cutoff);
  await setSyncValue(WINDOW_FLOOR_KEY, floor);

  const lowest = await lowestBlock();
  if (lowest == null || lowest >= floor) {
    log.info(`prune: nothing below window floor ${floor}`);
    return;
  }

  log.info(`prune: removing blocks ${lowest}..${floor - 1} (window floor ${floor})`);
  let removed = 0;
  for (let lo = lowest; lo < floor; lo += PRUNE_BATCH) {
    const hi = Math.min(lo + PRUNE_BATCH, floor);
    await pruneBatch(lo, hi);
    await vacuum();
    removed += hi - lo;
  }

  // tidy the work queue: drop ranges wholly below the floor so a future window
  // widening re-seeds them cleanly instead of finding stale done rows.
  await sql`delete from backfill_ranges where to_block < ${floor}`;

  log.info(`prune: done, cleared up to ${removed} block slots below ${floor}`);
}

export async function runPrune(stopped: () => boolean = () => false): Promise<void> {
  log.info(`pruner started, interval ${PRUNE_INTERVAL_HOURS}h`);
  const intervalMs = PRUNE_INTERVAL_HOURS * 3_600_000;
  for (;;) {
    if (stopped()) break;
    try {
      await pruneOnce();
    } catch (err) {
      log.error(`prune run failed: ${String(err)}`);
    }
    // sleep in short slices so shutdown is responsive.
    const wakeAt = Date.now() + intervalMs;
    while (!stopped() && Date.now() < wakeAt) await sleep(1000);
  }
  log.info("pruner stopped");
}
