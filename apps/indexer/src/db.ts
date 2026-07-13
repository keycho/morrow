// postgres access for the indexer. supabase is plain postgres; we use the
// connection string from DATABASE_URL (a secret, env only). every write path
// is a small typed helper so the main loop stays readable.

import pg from "pg";
import { tokens } from "@fletch/config";
import { log } from "./log.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. see .env.example.");
  }
  pool = new Pool({
    connectionString: url,
    max: 5,
    // supabase pooled connections dislike long idle sessions
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => {
    // a dropped idle client must not crash the worker
    log.error("pg pool error", { message: err.message });
  });
  return pool;
}

export async function upsertTokensFromConfig(): Promise<void> {
  const client = await db().connect();
  try {
    for (const t of tokens) {
      await client.query(
        `insert into tokens (id, symbol, name, pool_address, base_decimals, quote_decimals, active, updated_at)
         values ($1, $2, $3, $4, $5, $6, true, now())
         on conflict (id) do update set
           symbol = excluded.symbol,
           name = excluded.name,
           pool_address = excluded.pool_address,
           base_decimals = excluded.base_decimals,
           quote_decimals = excluded.quote_decimals,
           active = true,
           updated_at = now()`,
        [t.id, t.symbol, t.name, t.pool, t.baseDecimals, t.quoteDecimals]
      );
    }
  } finally {
    client.release();
  }
}

export interface ObservationRow {
  tokenId: number;
  blockNumber: bigint;
  ts: Date;
  poolSpot: number;
  depthQuote2pct: number;
  volumeDelta: number;
  source: "pool" | "mock";
}

export async function insertObservations(rows: ObservationRow[]): Promise<void> {
  if (rows.length === 0) return;
  const client = await db().connect();
  try {
    for (const r of rows) {
      await client.query(
        `insert into observations (token_id, block_number, ts, pool_spot, depth_quote_2pct, volume_delta, source)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [r.tokenId, r.blockNumber.toString(), r.ts, r.poolSpot, r.depthQuote2pct, r.volumeDelta, r.source]
      );
    }
  } finally {
    client.release();
  }
}

export interface ProxyTickRow {
  source: string;
  symbol: string;
  ts: Date;
  value: number;
  stale: boolean;
  latencyMs: number;
}

export async function insertProxyTicks(rows: ProxyTickRow[]): Promise<void> {
  if (rows.length === 0) return;
  const client = await db().connect();
  try {
    for (const r of rows) {
      await client.query(
        `insert into proxy_ticks (source, symbol, ts, value, stale, latency_ms)
         values ($1, $2, $3, $4, $5, $6)`,
        [r.source, r.symbol, r.ts, r.value, r.stale, r.latencyMs]
      );
    }
  } finally {
    client.release();
  }
}

export async function writeHeartbeat(
  service: string,
  ok: boolean,
  detail: Record<string, unknown>
): Promise<void> {
  await db().query(
    `insert into heartbeats (service, ok, detail) values ($1, $2, $3)`,
    [service, ok, JSON.stringify(detail)]
  );
}

export async function pruneOldHeartbeats(): Promise<void> {
  await db().query(`delete from heartbeats where ts < now() - interval '14 days'`);
}

// --- reads used by the engine cycle (wired in a later phase) ---------------

export interface ObservationForEngine {
  ts: Date;
  poolSpot: number;
  depthQuote2pct: number;
}

export async function recentObservations(
  tokenId: number,
  windowSeconds: number
): Promise<ObservationForEngine[]> {
  const res = await db().query(
    `select ts, pool_spot, depth_quote_2pct
     from observations
     where token_id = $1 and ts > now() - ($2 || ' seconds')::interval
     order by ts asc`,
    [tokenId, String(windowSeconds)]
  );
  return res.rows.map((row) => ({
    ts: new Date(row.ts),
    poolSpot: Number(row.pool_spot),
    depthQuote2pct: Number(row.depth_quote_2pct),
  }));
}

export interface ProxyLatest {
  source: string;
  ts: Date;
  value: number;
}

export async function latestProxyTick(source: string): Promise<ProxyLatest | null> {
  const res = await db().query(
    `select source, ts, value from proxy_ticks where source = $1 order by ts desc limit 1`,
    [source]
  );
  const row = res.rows[0];
  if (!row) return null;
  return { source: row.source, ts: new Date(row.ts), value: Number(row.value) };
}

// proxy value at or just before a moment (used to snapshot the close).
export async function proxyTickAt(source: string, at: Date): Promise<ProxyLatest | null> {
  const res = await db().query(
    `select source, ts, value from proxy_ticks where source = $1 and ts <= $2 order by ts desc limit 1`,
    [source, at]
  );
  const row = res.rows[0];
  if (!row) return null;
  return { source: row.source, ts: new Date(row.ts), value: Number(row.value) };
}

export interface AnchorRow {
  price: number;
  marketTs: Date;
}

export async function latestAnchor(tokenId: number, kind: "close" | "open"): Promise<AnchorRow | null> {
  const res = await db().query(
    `select price, market_ts from anchors where token_id = $1 and kind = $2 order by market_ts desc limit 1`,
    [tokenId, kind]
  );
  const row = res.rows[0];
  if (!row) return null;
  return { price: Number(row.price), marketTs: new Date(row.market_ts) };
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
