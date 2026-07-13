// receipt data layer. builds a ReceiptData for a reported week from the
// database: per-token accuracy of the pre-open fair value versus the actual
// open print, and the week's on-chain commit totals.

import pg from "pg";
import { chain, tokens } from "@fletch/config";
import type { ReceiptData, TokenReceipt } from "./types.js";

const { Pool } = pg;

export function makePool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return new Pool({ connectionString: url, max: 3 });
}

interface AccuracyRow {
  marketTs: Date;
  openPrice: number;
  predicted: number;
}

// open prints in [weekStart, weekEnd] joined to the last pre-open off-hours
// fair value. the window bounds are dates; opens fall at 09:30 et within.
async function tokenAccuracy(
  pool: pg.Pool,
  tokenId: number,
  weekStart: string,
  weekEnd: string
): Promise<AccuracyRow[]> {
  const res = await pool.query(
    `select a.market_ts, a.price as open_price, fv.fair_value as predicted
     from anchors a
     join lateral (
       select fair_value
       from fair_values
       where token_id = a.token_id
         and ts <= a.market_ts
         and ts > a.market_ts - interval '12 hours'
         and regime <> 'market_open'
       order by ts desc
       limit 1
     ) fv on true
     where a.token_id = $1 and a.kind = 'open'
       and a.market_ts >= $2::date and a.market_ts < ($3::date + interval '1 day')
     order by a.market_ts asc`,
    [tokenId, weekStart, weekEnd]
  );
  return res.rows.map((r) => ({
    marketTs: new Date(r.market_ts),
    openPrice: Number(r.open_price),
    predicted: Number(r.predicted),
  }));
}

function summarizeToken(symbol: string, name: string, rows: AccuracyRow[]): TokenReceipt {
  if (rows.length === 0) {
    return { symbol, name, samples: 0, meanAbsErrorPct: null, bestCall: null };
  }
  const errs = rows.map((r) => ({
    date: r.marketTs.toISOString().slice(0, 10),
    predicted: r.predicted,
    actual: r.openPrice,
    errorPct: r.openPrice > 0 ? (r.predicted / r.openPrice - 1) * 100 : 0,
  }));
  const meanAbs = errs.reduce((a, e) => a + Math.abs(e.errorPct), 0) / errs.length;
  const best = errs.reduce((a, b) => (Math.abs(b.errorPct) < Math.abs(a.errorPct) ? b : a));
  return { symbol, name, samples: errs.length, meanAbsErrorPct: meanAbs, bestCall: best };
}

async function weekCommits(
  pool: pg.Pool,
  weekStart: string,
  weekEnd: string
): Promise<{ count: number; latestTx: string | null; latestCycle: number | null }> {
  const res = await pool.query(
    `select cycle_id, tx_hash
     from commits
     where status = 'confirmed'
       and committed_at >= $1::date and committed_at < ($2::date + interval '1 day')
     order by cycle_id desc`,
    [weekStart, weekEnd]
  );
  const count = res.rowCount ?? 0;
  const latest = res.rows[0];
  return {
    count,
    latestTx: latest?.tx_hash ?? null,
    latestCycle: latest ? Number(latest.cycle_id) : null,
  };
}

export async function buildReceiptData(
  pool: pg.Pool,
  weekStart: string,
  weekEnd: string,
  generatedAt: string
): Promise<ReceiptData> {
  const tokenReceipts: TokenReceipt[] = [];
  for (const t of tokens) {
    const rows = await tokenAccuracy(pool, t.id, weekStart, weekEnd);
    tokenReceipts.push(summarizeToken(t.symbol, t.name, rows));
  }
  const commits = await weekCommits(pool, weekStart, weekEnd);
  return {
    weekStart,
    weekEnd,
    generatedAt,
    explorerBaseUrl: chain.explorerBaseUrl,
    tokens: tokenReceipts,
    cyclesCommitted: commits.count,
    latestCommitTx: commits.latestTx,
    latestCommitCycle: commits.latestCycle,
  };
}
