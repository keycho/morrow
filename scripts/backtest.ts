// pnpm backtest — does morrow's off-hours number actually predict the next
// open better than "the stock opens where it closed"? nobody had checked. this
// replays the fair value model over every past session boundary and scores it.
//
// history source: yahoo finance v8 chart, daily open/close, ~2 years per
// symbol. finnhub was the first choice (it is already the anchor source) but
// its historical candle endpoint is premium-only on our tier ("you don't have
// access to this resource"), so it cannot backfill. yahoo is free, keyless,
// and gives multi-year daily open and close for both the stock tokens and the
// ES=F / NQ=F / ETH-USD proxies the drift model already uses.
//
// reconstruction, and its honest limit: the live model measures drift intraday
// (proxy value captured at the 16:00 et close, compared to the proxy value near
// the 09:30 et open). multi-year intraday data is not available free, so this
// backtest approximates the overnight proxy move with daily bars:
//   drift proxy return = proxyOpen(t+1) / proxyClose(t) - 1
// for ES/NQ this brackets the overnight window from the daily bars; index
// futures print their session open in the early evening, so the daily bar can
// understate the full move to 09:30, biasing reconstructed drift toward zero.
// where drift is ~0 the full model collapses to naive by construction, and
// there is no onchain pool history to backtest, so the "morrow" predictor here
// equals "drift" (the onchain blend is untestable historically). the live
// /v1/accuracy endpoint is the production-fidelity forward test; it uses the
// real intraday baselines and accumulates as the feed runs. this script is the
// historical estimate, with the caveat stated plainly.
//
// three predictors, scored per token and pooled:
//   naive  -> predicted open = last close
//   drift  -> close * (1 + reconstructed proxy drift)
//   morrow -> the full engine (computeFairValue) as configured
//
// results are written to backtest_runs / backtest_results when DATABASE_URL is
// set and reachable; they are always printed. this reads nothing the live
// pipeline writes and writes nothing the live pipeline reads.

import pg from "pg";
import { tokens, proxiesForToken, model } from "@morrow/config";
import {
  blendedDrift,
  computeFairValue,
  scoreMetrics,
  type Metrics,
  type ProxyInput,
} from "@morrow/engine";

const NOW = Date.now();
const YEARS = process.env.BACKTEST_RANGE ?? "2y";

interface Bar {
  open: number;
  close: number;
}
type Series = Map<string, Bar>; // et calendar date (yyyy-mm-dd) -> bar

const etDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function etDate(unixSeconds: number): string {
  return etDateFmt.format(new Date(unixSeconds * 1000));
}

const seriesCache = new Map<string, Series>();

async function fetchSeries(ticker: string): Promise<Series> {
  const cached = seriesCache.get(ticker);
  if (cached) return cached;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?range=${YEARS}&interval=1d`;
  const res = await fetch(url, {
    headers: { "user-agent": "morrow-indexer/0.1", accept: "application/json" },
  });
  if (!res.ok) throw new Error(`yahoo ${res.status} for ${ticker}`);
  const body = (await res.json()) as {
    chart: {
      result: {
        timestamp: number[];
        indicators: { quote: { open: (number | null)[]; close: (number | null)[] }[] };
      }[];
    };
  };
  const r = body.chart.result[0];
  if (!r) throw new Error(`yahoo returned no result for ${ticker}`);
  const q = r.indicators.quote[0];
  if (!q) throw new Error(`yahoo returned no quote series for ${ticker}`);
  const series: Series = new Map();
  for (let i = 0; i < r.timestamp.length; i++) {
    const open = q.open[i];
    const close = q.close[i];
    const ts = r.timestamp[i];
    if (ts == null || open == null || close == null || !Number.isFinite(open) || !Number.isFinite(close)) {
      continue;
    }
    series.set(etDate(ts), { open, close });
  }
  seriesCache.set(ticker, series);
  return series;
}

// pull the yahoo ticker out of a proxy source url, e.g. ".../chart/ES=F?range".
function proxyTicker(url: string): string {
  const m = url.match(/\/chart\/([^?]+)/);
  if (!m) throw new Error(`cannot parse proxy ticker from ${url}`);
  return decodeURIComponent(m[1]!);
}

interface SessionError {
  gap: number; // actual overnight gap, open(t+1)/close(t) - 1
  drift: number; // reconstructed drift (predicted gap for drift/morrow)
  naive: number; // signed pct error of the naive prediction
  driftE: number;
  morrowE: number;
}

interface ScopeMetrics {
  naive: Metrics;
  drift: Metrics;
  morrow: Metrics;
}

async function backtestToken(symbol: string): Promise<SessionError[]> {
  const stock = await fetchSeries(symbol.toUpperCase());
  const proxyCfgs = proxiesForToken(symbol);
  const proxySeries = new Map<string, Series>();
  for (const p of proxyCfgs) {
    proxySeries.set(p.name, await fetchSeries(proxyTicker(p.url)));
  }

  const dates = [...stock.keys()].sort();
  const out: SessionError[] = [];

  for (let i = 0; i < dates.length - 1; i++) {
    const dt = dates[i]!;
    const dn = dates[i + 1]!;
    const closeT = stock.get(dt)!.close;
    const openN = stock.get(dn)!.open;
    if (closeT <= 0 || openN <= 0) continue;

    const proxyInputs: ProxyInput[] = proxyCfgs.map((p) => {
      const s = proxySeries.get(p.name)!;
      const pc = s.get(dt);
      const cv = s.get(dn);
      return {
        name: p.name,
        weight: p.weight,
        closeValue: pc ? pc.close : null,
        currentValue: cv ? cv.open : null,
        currentTsMs: NOW,
        stalenessMs: 30 * 86_400_000,
      };
    });

    const drift = blendedDrift(proxyInputs, NOW, model.maxDriftAbs).drift;

    const morrow = computeFairValue(
      {
        nowMs: NOW,
        regime: "after_hours",
        anchorPrice: closeT,
        anchorStale: false,
        observations: [],
        proxies: proxyInputs,
      },
      model
    );
    const morrowPred = morrow.ok ? morrow.fairValue : closeT * (1 + drift);

    const gap = openN / closeT - 1;
    out.push({
      gap,
      drift,
      naive: closeT / openN - 1,
      driftE: (closeT * (1 + drift)) / openN - 1,
      morrowE: morrowPred / openN - 1,
    });
  }

  return out;
}

function scope(symbol: string, rows: SessionError[]): ScopeMetrics {
  const actualGap = rows.map((r) => r.gap);
  const naiveAbs = rows.map((r) => Math.abs(r.naive));
  return {
    naive: scoreMetrics(
      rows.map((r) => r.naive),
      null,
      actualGap,
      null
    ),
    drift: scoreMetrics(
      rows.map((r) => r.driftE),
      rows.map((r) => r.drift),
      actualGap,
      naiveAbs
    ),
    morrow: scoreMetrics(
      rows.map((r) => r.morrowE),
      rows.map((r) => r.drift),
      actualGap,
      naiveAbs
    ),
  };
}

function pct(x: number | null, digits = 3): string {
  if (x === null) return "-";
  return x.toFixed(digits);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printScope(name: string, m: ScopeMetrics): void {
  console.log(`\n${name}  (n=${m.naive.n} sessions)`);
  console.log(
    "  " +
      pad("predictor", 9) +
      pad("mae%", 9) +
      pad("median%", 9) +
      pad("rmse%", 9) +
      pad("bias%", 9) +
      pad("worst%", 9) +
      pad("hit", 7) +
      "beats-naive"
  );
  for (const p of ["naive", "drift", "morrow"] as const) {
    const x = m[p];
    console.log(
      "  " +
        pad(p, 9) +
        pad(pct(x.maePct), 9) +
        pad(pct(x.medianAePct), 9) +
        pad(pct(x.rmsePct), 9) +
        pad(pct(x.meanErrorPct), 9) +
        pad(pct(x.worstPct), 9) +
        pad(x.hitRate === null ? "-" : `${(x.hitRate * 100).toFixed(1)}%`, 7) +
        (x.winRateVsNaive === null ? "-" : `${(x.winRateVsNaive * 100).toFixed(1)}%`)
    );
  }
}

async function writeDb(
  allDates: string[],
  perToken: { symbol: string; m: ScopeMetrics }[],
  pooled: ScopeMetrics,
  method: string
): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("\nDATABASE_URL not set; results not persisted (printed only).");
    return false;
  }
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 8000, max: 2 });
  try {
    const from = allDates[0] ?? null;
    const to = allDates[allDates.length - 1] ?? null;
    const run = await pool.query<{ id: string }>(
      `insert into backtest_runs (source, method, history_from, history_to, sessions, notes)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      ["yahoo-daily", method, from, to, pooled.naive.n, "off-hours next-open prediction backtest"]
    );
    const runId = run.rows[0]!.id;
    const rows: { scope: string; m: ScopeMetrics }[] = [
      { scope: "pooled", m: pooled },
      ...perToken.map((t) => ({ scope: t.symbol, m: t.m })),
    ];
    for (const { scope: sc, m } of rows) {
      for (const p of ["naive", "drift", "morrow"] as const) {
        const x = m[p];
        await pool.query(
          `insert into backtest_results
             (run_id, scope, predictor, n, mae_pct, median_ae_pct, rmse_pct, mean_error_pct,
              worst_pct, p50_abs_pct, p90_abs_pct, hit_rate, win_rate_vs_naive)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict (run_id, scope, predictor) do nothing`,
          [
            runId,
            sc,
            p,
            x.n,
            x.maePct,
            x.medianAePct,
            x.rmsePct,
            x.meanErrorPct,
            x.worstPct,
            x.p50AbsPct,
            x.p90AbsPct,
            x.hitRate,
            x.winRateVsNaive,
          ]
        );
      }
    }
    console.log(`\npersisted run ${runId} to backtest_runs / backtest_results.`);
    return true;
  } catch (err) {
    console.log(`\ncould not persist to database: ${err instanceof Error ? err.message : String(err)}`);
    console.log("results above are still valid; rerun with a reachable DATABASE_URL to store them.");
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  console.log(`morrow backtest — off-hours next-open prediction`);
  console.log(`history: yahoo daily, range ${YEARS}, ${tokens.length} tokens\n`);

  const perToken: { symbol: string; rows: SessionError[]; m: ScopeMetrics }[] = [];
  const allRows: SessionError[] = [];
  const allDatesSet = new Set<string>();

  for (const t of tokens) {
    try {
      const rows = await backtestToken(t.symbol);
      const s = await fetchSeries(t.symbol.toUpperCase());
      for (const d of s.keys()) allDatesSet.add(d);
      perToken.push({ symbol: t.symbol, rows, m: scope(t.symbol, rows) });
      allRows.push(...rows);
      console.log(`  ${pad(t.symbol, 6)} ${rows.length} sessions`);
    } catch (err) {
      console.log(`  ${pad(t.symbol, 6)} skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (allRows.length === 0) {
    console.log("\nno sessions scored. is the history source reachable?");
    process.exit(1);
  }

  const pooled = scope("pooled", allRows);
  for (const t of perToken) printScope(t.symbol, t.m);
  printScope("POOLED", pooled);

  // plain-language verdict.
  const nvMae = pooled.naive.maePct;
  const moMae = pooled.morrow.maePct;
  const improvement = ((nvMae - moMae) / nvMae) * 100;
  const meanAbsDrift =
    (allRows.reduce((a, r) => a + Math.abs(r.drift), 0) / allRows.length) * 100;
  const driftCalls = allRows.filter((r) => r.drift !== 0).length;

  console.log(`\n${"=".repeat(70)}`);
  console.log("verdict (pooled):");
  console.log(`  naive  mae ${nvMae.toFixed(3)}%   morrow mae ${moMae.toFixed(3)}%`);
  if (moMae < nvMae) {
    console.log(`  morrow beats naive by ${improvement.toFixed(1)}% (lower mae).`);
  } else {
    console.log(`  morrow does NOT beat naive: it is ${Math.abs(improvement).toFixed(1)}% worse.`);
  }
  console.log(
    `  drift makes a directional call on ${driftCalls}/${allRows.length} sessions; ` +
      `mean |drift| ${meanAbsDrift.toFixed(3)}%.`
  );
  console.log(
    `  morrow beats naive on ${((pooled.morrow.winRateVsNaive ?? 0) * 100).toFixed(1)}% of individual sessions ` +
      `(directional hit rate ${pooled.morrow.hitRate === null ? "-" : (pooled.morrow.hitRate * 100).toFixed(1) + "%"}).`
  );
  console.log(
    `  note: 'morrow' equals 'drift' historically because there is no onchain pool history to backtest;`
  );
  console.log(
    `  the onchain blend is only testable forward via /v1/accuracy on the live feed.`
  );
  console.log("=".repeat(70));

  const method =
    "next-open predicted from prior close; drift reconstructed from daily proxy open(t+1)/close(t); morrow=drift (no onchain history)";
  await writeDb([...allDatesSet].sort(), perToken.map((t) => ({ symbol: t.symbol, m: t.m })), pooled, method);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
