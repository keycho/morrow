// pruner: roll the window forward by dropping partitions.
//
// deleting tens of gb a day out of a live heap is a losing game (autovacuum
// never keeps up, indexes bloat, vacuum does not return space to the os). with
// range partitioning the pruner just drops whole partitions once they are
// entirely below the window floor: instant, reclaims disk immediately, zero
// vacuum work.
//
// refuses to run if WINDOW_DAYS is unset or under 7, read from the raw env so a
// missing var can never wipe the window. never touches cold_* tables, tokens,
// contracts, or token_balances.

import { getHead } from "./chain.js";
import { sql } from "./db.js";
import { log } from "./log.js";
import { dropPartitionsBelow } from "./partitions.js";
import { findWindowFloor, setSyncValue, WINDOW_FLOOR_KEY } from "./window.js";

const PRUNE_INTERVAL_HOURS = Number(process.env.PRUNE_INTERVAL_HOURS ?? 24);
const MIN_WINDOW_DAYS = 7;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

export async function pruneOnce(): Promise<void> {
  const windowDays = guardWindowDays();
  if (windowDays == null) return;

  const head = await getHead();
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86_400;
  const floor = await findWindowFloor(head, cutoff);
  await setSyncValue(WINDOW_FLOOR_KEY, floor);

  const dropped = await dropPartitionsBelow(floor);
  // tidy the work queue so a future widening re-seeds cleanly.
  await sql`delete from backfill_ranges where to_block < ${floor}`;

  if (dropped > 0) {
    log.info(`prune: dropped ${dropped} partition(s) below window floor ${floor}`);
  } else {
    log.info(`prune: no partitions fully below window floor ${floor}`);
  }
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
    const wakeAt = Date.now() + intervalMs;
    while (!stopped() && Date.now() < wakeAt) await sleep(1000);
  }
  log.info("pruner stopped");
}
