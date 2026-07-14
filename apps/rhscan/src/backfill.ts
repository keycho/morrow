// windowed backfill worker: a work queue, not a for loop.
//
// we do not index full history. on startup we find the window floor (the lowest
// block within WINDOW_DAYS of now) and seed backfill_ranges only from there to
// head. workers claim ranges newest-first (order by from_block desc) so recent
// data lands within minutes. ranges are aligned to a fixed RANGE_SIZE grid so
// widening the window later re-seeds cleanly with no overlap.
//
// two watermarks are published to sync_state for the frontend:
//   window_floor    the lowest block the window covers
//   backfill_floor  the contiguous-from-head watermark: the lowest block above
//                   which every range is done. this is what "fully indexed from
//                   here up" means, and the number the ui should trust.

import { getBlockByNumber, getBlockReceipts, getHead } from "./chain.js";
import { sql, writeBlocks } from "./db.js";
import { transformBlock } from "./transform.js";
import { log } from "./log.js";
import {
  findWindowFloor,
  setSyncValue,
  WINDOW_DAYS,
  WINDOW_FLOOR_KEY,
  BACKFILL_FLOOR_KEY,
} from "./window.js";
import { ensurePartitions } from "./partitions.js";

const RANGE_SIZE = Number(process.env.RANGE_SIZE ?? 200);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const MAX_ATTEMPTS = Number(process.env.MAX_RANGE_ATTEMPTS ?? 5);
const PROGRESS_MS = Number(process.env.PROGRESS_MS ?? 5000);
const STALE_CLAIM_MIN = Number(process.env.STALE_CLAIM_MIN ?? 10);

interface Range {
  id: number;
  from_block: number;
  to_block: number;
  attempts: number;
}

interface Stats {
  gridFloor: number;
  totalRanges: number;
  totalBlocks: number;
  rangesDone: number;
  blocksDone: number;
  startedAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// align to a fixed grid so re-seeding with a different floor never overlaps.
function gridFloorOf(floor: number): number {
  return floor - (floor % RANGE_SIZE);
}

// seed pending ranges gridFloor..head. idempotent: unique(from_block) with on
// conflict do nothing means re-running never duplicates or resets progress, and
// a lower floor (a widened window) simply adds the missing lower ranges.
async function seedRanges(gridFloor: number, head: number): Promise<void> {
  log.info(
    `seeding backfill ranges ${gridFloor}..${head} step ${RANGE_SIZE}`,
  );
  await sql`
    insert into backfill_ranges (from_block, to_block, status)
    select gs as from_block,
           least(gs + ${RANGE_SIZE - 1}, ${head}) as to_block,
           'pending'
    from generate_series(${gridFloor}, ${head}, ${RANGE_SIZE}) as gs
    on conflict (from_block) do nothing
  `;
}

async function reclaimStale(): Promise<void> {
  await sql`
    update backfill_ranges
       set status = 'pending', claimed_at = null
     where status = 'claimed'
       and claimed_at < now() - (${STALE_CLAIM_MIN} || ' minutes')::interval
  `;
}

// claim the highest pending range so recent blocks land first.
async function claimRange(): Promise<Range | null> {
  const rows = await sql<Range[]>`
    update backfill_ranges
       set status = 'claimed', claimed_at = now()
     where id = (
       select id from backfill_ranges
        where status = 'pending'
        order by from_block desc
        limit 1
        for update skip locked
     )
    returning id, from_block, to_block, attempts
  `;
  return rows[0] ?? null;
}

async function processRange(range: Range): Promise<void> {
  const nums: number[] = [];
  for (let n = range.from_block; n <= range.to_block; n += 1) nums.push(n);

  const [blocks, receipts] = await Promise.all([
    Promise.all(nums.map((n) => getBlockByNumber(n))),
    Promise.all(nums.map((n) => getBlockReceipts(n))),
  ]);

  const rows = blocks.map((b, i) => transformBlock(b, receipts[i]!));
  await sql.begin((tx) => writeBlocks(tx, rows));
}

async function markDone(id: number): Promise<void> {
  await sql`update backfill_ranges set status = 'done' where id = ${id}`;
}

async function handleFailure(range: Range, err: unknown): Promise<void> {
  const attempts = range.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await sql`
      update backfill_ranges set status = 'failed', attempts = ${attempts}
       where id = ${range.id}
    `;
    log.error(
      `range ${range.from_block}-${range.to_block} failed permanently after ${attempts} attempts: ${String(
        err,
      )}`,
    );
    return;
  }
  await sql`
    update backfill_ranges
       set status = 'pending', attempts = ${attempts}, claimed_at = null
     where id = ${range.id}
  `;
  const backoff = Math.min(500 * 2 ** attempts, 20_000);
  const wait = backoff + Math.floor(Math.random() * backoff * 0.5);
  log.warn(
    `range ${range.from_block}-${range.to_block} requeued (attempt ${attempts}) in ${wait}ms: ${String(
      err,
    )}`,
  );
  await sleep(wait);
}

async function pendingOrClaimed(): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from backfill_ranges
     where status in ('pending', 'claimed')
  `;
  return rows[0]?.n ?? 0;
}

// contiguous-from-head watermark: everything above the highest not-done range is
// done, so the floor is that range's top + 1. all done means the whole window is
// contiguous, so the floor is the grid floor.
async function computeBackfillFloor(gridFloor: number): Promise<number> {
  const rows = await sql<{ m: string | null }[]>`
    select max(to_block) as m from backfill_ranges where status <> 'done'
  `;
  const m = rows[0]?.m;
  return m == null ? gridFloor : Number(m) + 1;
}

async function worker(stats: Stats, stopped: () => boolean): Promise<void> {
  for (;;) {
    if (stopped()) return;
    const range = await claimRange();
    if (!range) {
      if ((await pendingOrClaimed()) === 0) return;
      await sleep(1000);
      continue;
    }
    try {
      await processRange(range);
      await markDone(range.id);
      stats.rangesDone += 1;
      stats.blocksDone += range.to_block - range.from_block + 1;
    } catch (err) {
      await handleFailure(range, err);
    }
  }
}

function startReporter(stats: Stats): NodeJS.Timeout {
  let lastBlocks = 0;
  let lastAt = Date.now();
  return setInterval(() => {
    void reclaimStale();
    void computeBackfillFloor(stats.gridFloor).then((floor) =>
      setSyncValue(BACKFILL_FLOOR_KEY, floor),
    );
    const now = Date.now();
    const dt = (now - lastAt) / 1000;
    const recentBps = dt > 0 ? (stats.blocksDone - lastBlocks) / dt : 0;
    const overallBps =
      stats.blocksDone / Math.max(1, (now - stats.startedAt) / 1000);
    const remaining = Math.max(0, stats.totalBlocks - stats.blocksDone);
    const etaSec = overallBps > 0 ? Math.round(remaining / overallBps) : 0;
    lastBlocks = stats.blocksDone;
    lastAt = now;
    log.info(
      `backfill ${stats.rangesDone}/${stats.totalRanges} ranges, ` +
        `${stats.blocksDone}/${stats.totalBlocks} blocks, ` +
        `${recentBps.toFixed(0)} blk/s (avg ${overallBps.toFixed(0)}), ` +
        `eta ${formatEta(etaSec)}`,
    );
  }, PROGRESS_MS);
}

function formatEta(sec: number): string {
  if (sec <= 0) return "unknown";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

export async function runBackfill(stopped: () => boolean = () => false): Promise<void> {
  const head = await getHead();
  const windowFloor = await findWindowFloor(head);
  const gridFloor = gridFloorOf(windowFloor);
  const windowBlocks = head - windowFloor + 1;

  log.info(
    `window ${WINDOW_DAYS} days: floor block ${windowFloor} (grid ${gridFloor}), head ${head}, ${windowBlocks} blocks in window`,
  );
  await setSyncValue(WINDOW_FLOOR_KEY, windowFloor);

  // partitions must exist before any range is written into them.
  await ensurePartitions(gridFloor, head);

  await seedRanges(gridFloor, head);
  await reclaimStale();

  const counts = await sql<{ total: number; done: number }[]>`
    select count(*)::int as total,
           count(*) filter (where status = 'done')::int as done
      from backfill_ranges
  `;
  const totalRanges = counts[0]?.total ?? 0;
  const doneRanges = counts[0]?.done ?? 0;

  const stats: Stats = {
    gridFloor,
    totalRanges,
    totalBlocks: head - gridFloor + 1,
    rangesDone: doneRanges,
    blocksDone: doneRanges * RANGE_SIZE,
    startedAt: Date.now(),
  };

  log.info(
    `backfill starting: ${totalRanges} ranges (${doneRanges} already done), concurrency ${CONCURRENCY}`,
  );

  const reporter = startReporter(stats);
  try {
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => worker(stats, stopped)),
    );
  } finally {
    clearInterval(reporter);
  }

  await setSyncValue(BACKFILL_FLOOR_KEY, await computeBackfillFloor(gridFloor));
  log.info(
    `backfill complete: ${stats.rangesDone} ranges done this run, ${stats.blocksDone} blocks`,
  );
}
