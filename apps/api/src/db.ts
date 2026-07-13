// read-side postgres access for the api. every query is a typed helper.
// DATABASE_URL comes from env only.

import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. see .env.example.");
  pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", () => {
    // dropped idle clients must not crash the api
  });
  return pool;
}

export interface FairValueApiRow {
  tokenId: number;
  symbol: string;
  name: string;
  cycleId: number;
  ts: string;
  fairValue: number;
  confidence: number;
  bandLow: number;
  bandHigh: number;
  regime: string;
  suspect: boolean;
  corporateAction: boolean;
  anchorStale: boolean;
  anchorPrice: number | null;
  drift: number | null;
  onchainTwap: number | null;
  onchainSpot: number | null;
  depthQuote: number | null;
}

function mapFairValue(row: Record<string, unknown>): FairValueApiRow {
  return {
    tokenId: Number(row.token_id),
    symbol: String(row.symbol),
    name: String(row.name),
    cycleId: Number(row.cycle_id),
    ts: new Date(row.ts as string).toISOString(),
    fairValue: Number(row.fair_value),
    confidence: Number(row.confidence),
    bandLow: Number(row.band_low),
    bandHigh: Number(row.band_high),
    regime: String(row.regime),
    suspect: Boolean(row.suspect),
    corporateAction: Boolean(row.corporate_action),
    anchorStale: Boolean(row.anchor_stale),
    anchorPrice: row.anchor_price === null ? null : Number(row.anchor_price),
    drift: row.drift === null ? null : Number(row.drift),
    onchainTwap: row.onchain_twap === null ? null : Number(row.onchain_twap),
    onchainSpot: row.onchain_spot === null ? null : Number(row.onchain_spot),
    depthQuote: row.depth_quote === null ? null : Number(row.depth_quote),
  };
}

export async function latestFairValues(): Promise<FairValueApiRow[]> {
  const res = await db().query(
    `select distinct on (fv.token_id)
       fv.*, t.symbol, t.name
     from fair_values fv
     join tokens t on t.id = fv.token_id
     where t.active
     order by fv.token_id, fv.cycle_id desc`
  );
  return res.rows.map(mapFairValue);
}

export async function latestFairValueFor(tokenId: number): Promise<FairValueApiRow | null> {
  const res = await db().query(
    `select fv.*, t.symbol, t.name
     from fair_values fv
     join tokens t on t.id = fv.token_id
     where fv.token_id = $1
     order by fv.cycle_id desc
     limit 1`,
    [tokenId]
  );
  const row = res.rows[0];
  return row ? mapFairValue(row) : null;
}

export async function fairValueHistory(
  tokenId: number,
  from: Date,
  to: Date,
  limit: number,
  offset: number
): Promise<FairValueApiRow[]> {
  const res = await db().query(
    `select fv.*, t.symbol, t.name
     from fair_values fv
     join tokens t on t.id = fv.token_id
     where fv.token_id = $1 and fv.ts >= $2 and fv.ts <= $3
     order by fv.ts asc
     limit $4 offset $5`,
    [tokenId, from, to, limit, offset]
  );
  return res.rows.map(mapFairValue);
}

export async function fairValueHistoryCount(tokenId: number, from: Date, to: Date): Promise<number> {
  const res = await db().query(
    `select count(*)::int as n from fair_values where token_id = $1 and ts >= $2 and ts <= $3`,
    [tokenId, from, to]
  );
  return Number(res.rows[0]?.n ?? 0);
}

export interface CommitApiRow {
  cycleId: number;
  merkleRoot: string;
  observationCount: number;
  txHash: string | null;
  status: string;
  committedAt: string | null;
  createdAt: string;
}

function mapCommit(row: Record<string, unknown>): CommitApiRow {
  return {
    cycleId: Number(row.cycle_id),
    merkleRoot: String(row.merkle_root),
    observationCount: Number(row.observation_count),
    txHash: row.tx_hash === null ? null : String(row.tx_hash),
    status: String(row.status),
    committedAt: row.committed_at === null ? null : new Date(row.committed_at as string).toISOString(),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export async function listCommits(limit: number, offset: number): Promise<CommitApiRow[]> {
  const res = await db().query(
    `select cycle_id, merkle_root, observation_count, tx_hash, status, committed_at, created_at
     from commits
     order by cycle_id desc
     limit $1 offset $2`,
    [limit, offset]
  );
  return res.rows.map(mapCommit);
}

export interface CommitLeafRecord {
  tokenId: number;
  cycleId: number;
  fairValue: string;
  confidence: number;
  timestamp: number;
  leaf: string;
}

export interface CommitWithLeaves extends CommitApiRow {
  leaves: CommitLeafRecord[];
}

export async function commitByCycle(cycleId: number): Promise<CommitWithLeaves | null> {
  const res = await db().query(
    `select cycle_id, merkle_root, observation_count, tx_hash, status, committed_at, created_at, leaves
     from commits
     where cycle_id = $1`,
    [cycleId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return { ...mapCommit(row), leaves: row.leaves as CommitLeafRecord[] };
}

export interface AccuracySample {
  marketTs: string;
  openPrice: number;
  predictedFairValue: number;
  predictedAt: string;
  confidence: number;
  errorPct: number;
}

// realized error: last published off-hours fair value before each official
// open print, versus that print.
export async function accuracySamples(tokenId: number, limit: number): Promise<AccuracySample[]> {
  const res = await db().query(
    `select a.market_ts, a.price as open_price, fv.fair_value, fv.confidence, fv.ts as predicted_at
     from anchors a
     join lateral (
       select fair_value, confidence, ts
       from fair_values
       where token_id = a.token_id
         and ts <= a.market_ts
         and ts > a.market_ts - interval '12 hours'
         and regime <> 'market_open'
       order by ts desc
       limit 1
     ) fv on true
     where a.token_id = $1 and a.kind = 'open'
     order by a.market_ts desc
     limit $2`,
    [tokenId, limit]
  );
  return res.rows.map((row) => {
    const open = Number(row.open_price);
    const predicted = Number(row.fair_value);
    return {
      marketTs: new Date(row.market_ts).toISOString(),
      openPrice: open,
      predictedFairValue: predicted,
      predictedAt: new Date(row.predicted_at).toISOString(),
      confidence: Number(row.confidence),
      errorPct: open > 0 ? (predicted / open - 1) * 100 : 0,
    };
  });
}

export interface HeartbeatRow {
  service: string;
  ts: string;
  ok: boolean;
  detail: Record<string, unknown>;
}

export async function latestHeartbeats(): Promise<HeartbeatRow[]> {
  const res = await db().query(
    `select distinct on (service) service, ts, ok, detail
     from heartbeats
     order by service, ts desc`
  );
  return res.rows.map((row) => ({
    service: String(row.service),
    ts: new Date(row.ts).toISOString(),
    ok: Boolean(row.ok),
    detail: (row.detail ?? {}) as Record<string, unknown>,
  }));
}

export async function newestFairValueTs(): Promise<string | null> {
  const res = await db().query(`select max(ts) as ts from fair_values`);
  const ts = res.rows[0]?.ts;
  return ts ? new Date(ts).toISOString() : null;
}

export async function lastProxyTickPerSource(): Promise<{ source: string; ts: string }[]> {
  const res = await db().query(
    `select distinct on (source) source, ts from proxy_ticks order by source, ts desc`
  );
  return res.rows.map((row) => ({ source: String(row.source), ts: new Date(row.ts).toISOString() }));
}

// --- keys and admin ----------------------------------------------------------

export async function keyTierByHash(keyHash: string): Promise<string | null> {
  const res = await db().query(
    `update keys set last_used_at = now() where key_hash = $1 and active returning tier`,
    [keyHash]
  );
  const row = res.rows[0];
  return row ? String(row.tier) : null;
}

export async function insertKey(keyHash: string, label: string): Promise<void> {
  await db().query(`insert into keys (key_hash, label) values ($1, $2)`, [keyHash, label]);
}

export async function insertAnchor(
  tokenId: number,
  kind: "close" | "open",
  price: number,
  marketTs: Date,
  source: string
): Promise<void> {
  await db().query(
    `insert into anchors (token_id, kind, price, market_ts, source)
     values ($1, $2, $3, $4, $5)
     on conflict (token_id, kind, market_ts) do update set price = excluded.price, source = excluded.source`,
    [tokenId, kind, price, marketTs, source]
  );
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
