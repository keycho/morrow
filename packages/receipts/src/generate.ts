// receipt generator. orchestrates: build the data for a reported week, render
// the markdown and svg, rasterize the png (best effort), and upsert the row.
// generation only; nothing is posted anywhere.

import pg from "pg";
import { buildReceiptData, makePool } from "./data.js";
import { buildMarkdown, buildSvg } from "./render.js";
import { svgToPng } from "./rasterize.js";
import { lastCompletedWeek } from "./week.js";
import type { ReceiptData } from "./types.js";

export { lastCompletedWeek } from "./week.js";
export type { ReceiptData, TokenReceipt } from "./types.js";

async function receiptExists(pool: pg.Pool, weekStart: string): Promise<boolean> {
  const res = await pool.query(`select 1 from receipts where week_start = $1 limit 1`, [weekStart]);
  return (res.rowCount ?? 0) > 0;
}

async function storeReceipt(
  pool: pg.Pool,
  data: ReceiptData,
  markdown: string,
  svg: string,
  pngBase64: string | null
): Promise<void> {
  const summary = {
    weekStart: data.weekStart,
    weekEnd: data.weekEnd,
    cyclesCommitted: data.cyclesCommitted,
    latestCommitTx: data.latestCommitTx,
    tokens: data.tokens.map((t) => ({
      symbol: t.symbol,
      samples: t.samples,
      meanAbsErrorPct: t.meanAbsErrorPct,
      bestCall: t.bestCall,
    })),
  };
  await pool.query(
    `insert into receipts (week_start, week_end, markdown, svg, png_base64, summary)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (week_start) do update set
       week_end = excluded.week_end,
       generated_at = now(),
       markdown = excluded.markdown,
       svg = excluded.svg,
       png_base64 = excluded.png_base64,
       summary = excluded.summary`,
    [data.weekStart, data.weekEnd, markdown, svg, pngBase64, JSON.stringify(summary)]
  );
}

export interface GenerateResult {
  weekStart: string;
  weekEnd: string;
  hadPng: boolean;
  cyclesCommitted: number;
}

// generate (and store) the receipt for a reported week. if weekStart is
// omitted, uses the most recently completed week relative to `now`.
export async function generateWeeklyReceipt(opts?: {
  pool?: pg.Pool;
  now?: { year: number; month: number; day: number };
  generatedAt?: string;
  force?: boolean;
}): Promise<GenerateResult | null> {
  const pool = opts?.pool ?? makePool();
  const ownsPool = !opts?.pool;
  try {
    const now = opts?.now;
    const { weekStart, weekEnd } = now
      ? lastCompletedWeek(now.year, now.month, now.day)
      : (() => {
          throw new Error("generateWeeklyReceipt requires opts.now (year, month, day)");
        })();

    if (!opts?.force && (await receiptExists(pool, weekStart))) {
      return null; // already generated
    }

    const generatedAt = opts?.generatedAt ?? weekEnd + "T00:00:00.000Z";
    const data = await buildReceiptData(pool, weekStart, weekEnd, generatedAt);
    const markdown = buildMarkdown(data);
    const svg = buildSvg(data);
    const png = await svgToPng(svg);
    await storeReceipt(pool, data, markdown, svg, png ? png.toString("base64") : null);

    return {
      weekStart,
      weekEnd,
      hadPng: png !== null,
      cyclesCommitted: data.cyclesCommitted,
    };
  } finally {
    if (ownsPool) await pool.end();
  }
}
