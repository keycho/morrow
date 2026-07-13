// database access for discovery: the anchor references that feed the
// plausibility gate, and the pool_discovery_runs dataset (one row per run,
// additive migration 0013). every function takes a pg pool so the cli and the
// indexer worker can pass their own; nothing here opens a connection.

import type pg from "pg";
import type { DiscoveryResult } from "./types.js";

// a queryable is either a pg pool or a pooled client. both expose query().
type Db = Pick<pg.Pool, "query">;

// latest close anchor per token as the reference price for the plausibility
// gate. missing table or query error yields an empty map (the gate is
// optional; without a reference no pool is called implausible).
export async function readAnchorReferences(db: Db): Promise<Map<number, number>> {
  const refs = new Map<number, number>();
  try {
    const res = await db.query(
      `select distinct on (token_id) token_id, price from anchors where kind = 'close' order by token_id, market_ts desc`
    );
    for (const row of res.rows) refs.set(Number(row.token_id), Number(row.price));
  } catch {
    // reference is optional; ignore failures.
  }
  return refs;
}

// append one discovery run to the dataset. the full judged set and per-token
// selection are stored as jsonb so pool liquidity arriving over time becomes a
// queryable history.
export async function storeDiscoveryRun(db: Db, result: DiscoveryResult): Promise<void> {
  await db.query(
    `insert into pool_discovery_runs (eth_usd, num_pools, results) values ($1, $2, $3)`,
    [result.ethUsd, result.judged.length, JSON.stringify(result)]
  );
}

// the most recent runs, newest first, parsed back into results. used by the
// weekly analysis to check whether a configured pool has stayed below the
// depth floor across a sustained window.
export async function recentDiscoveryResults(db: Db, limit: number): Promise<DiscoveryResult[]> {
  const res = await db.query(
    `select results from pool_discovery_runs order by run_at desc limit $1`,
    [limit]
  );
  return res.rows.map((row) => row.results as DiscoveryResult);
}

// timestamp of the last stored run, or null when the table is empty. the
// scheduler uses it to avoid re-running after a restart within the window.
export async function lastDiscoveryRunAt(db: Db): Promise<Date | null> {
  const res = await db.query(`select run_at from pool_discovery_runs order by run_at desc limit 1`);
  const row = res.rows[0];
  return row ? new Date(row.run_at) : null;
}
