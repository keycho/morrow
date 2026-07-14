// rolling-window helpers, shared by backfill, prune and resolve.
//
// the explorer indexes only a recent window and falls back to live rpc for
// anything older. this is a deliberate product decision, not a limitation. the
// window floor is the lowest block whose timestamp is within WINDOW_DAYS of now.
// backfill_floor is the contiguous-from-head watermark: the lowest block above
// which every range is done, and the number the ui should trust as "fully
// indexed from here up".

import { getBlockHeaderTimestamp } from "./chain.js";
import { sql, type Executor } from "./db.js";

export const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 90);

const DAY_SECONDS = 86_400;

// sync_state pseudo-workers used to publish scalars the frontend reads.
export const WINDOW_FLOOR_KEY = "window_floor";
export const BACKFILL_FLOOR_KEY = "backfill_floor";

export function windowCutoffSec(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) - WINDOW_DAYS * DAY_SECONDS;
}

// binary search for the lowest block whose timestamp is at or above the cutoff.
// about log2(head) header reads, so ~24 calls against an 8.9m-block chain.
export async function findWindowFloor(
  head: number,
  cutoffSec = windowCutoffSec(),
): Promise<number> {
  let lo = 0;
  let hi = head;
  let ans = head;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ts = await getBlockHeaderTimestamp(mid);
    if (ts >= cutoffSec) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

export async function setSyncValue(
  worker: string,
  block: number,
  exec: Executor = sql,
): Promise<void> {
  await exec`
    insert into sync_state (worker, last_indexed_block, updated_at)
    values (${worker}, ${block}, now())
    on conflict (worker) do update
      set last_indexed_block = excluded.last_indexed_block, updated_at = now()
  `;
}

export async function getSyncValue(worker: string): Promise<number | null> {
  const rows = await sql<{ last_indexed_block: string }[]>`
    select last_indexed_block from sync_state where worker = ${worker}
  `;
  return rows[0] ? Number(rows[0].last_indexed_block) : null;
}
