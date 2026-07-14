// backtest results. the latest `pnpm backtest` run: does morrow's off-hours
// number beat "the stock opens where it closed", per token and pooled. this is
// the evidence surface for the docs page. read-only; the numbers are produced
// offline by scripts/backtest and stored in backtest_runs / backtest_results.

import type { FastifyInstance } from "fastify";
import { disclaimer } from "@morrow/config";
import { query } from "../db.js";

interface PredictorMetrics {
  predictor: "naive" | "drift" | "morrow";
  n: number;
  maePct: number;
  medianAePct: number;
  rmsePct: number;
  meanErrorPct: number;
  worstPct: number;
  p50AbsPct: number;
  p90AbsPct: number;
  hitRate: number | null;
  winRateVsNaive: number | null;
}

interface ScopeBlock {
  scope: string;
  naive: PredictorMetrics | null;
  drift: PredictorMetrics | null;
  morrow: PredictorMetrics | null;
}

function num(v: unknown): number {
  return Number(v);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function mapMetrics(row: Record<string, unknown>): PredictorMetrics {
  return {
    predictor: row.predictor as "naive" | "drift" | "morrow",
    n: num(row.n),
    maePct: num(row.mae_pct),
    medianAePct: num(row.median_ae_pct),
    rmsePct: num(row.rmse_pct),
    meanErrorPct: num(row.mean_error_pct),
    worstPct: num(row.worst_pct),
    p50AbsPct: num(row.p50_abs_pct),
    p90AbsPct: num(row.p90_abs_pct),
    hitRate: numOrNull(row.hit_rate),
    winRateVsNaive: numOrNull(row.win_rate_vs_naive),
  };
}

export function registerBacktestRoutes(app: FastifyInstance): void {
  app.get("/v1/backtest", async () => {
    const runRes = await query(
      `select id, run_at, source, method, history_from, history_to, sessions
       from backtest_runs order by run_at desc limit 1`
    );
    if (runRes.rows.length === 0) {
      return { data: null, disclaimer };
    }
    const run = runRes.rows[0]!;
    const res = await query(
      `select scope, predictor, n, mae_pct, median_ae_pct, rmse_pct, mean_error_pct,
              worst_pct, p50_abs_pct, p90_abs_pct, hit_rate, win_rate_vs_naive
       from backtest_results where run_id = $1`,
      [run.id]
    );

    const byScope = new Map<string, ScopeBlock>();
    for (const raw of res.rows) {
      const row = raw as Record<string, unknown>;
      const scope = String(row.scope);
      let block = byScope.get(scope);
      if (!block) {
        block = { scope, naive: null, drift: null, morrow: null };
        byScope.set(scope, block);
      }
      const m = mapMetrics(row);
      block[m.predictor] = m;
    }

    const pooled = byScope.get("pooled") ?? null;
    const tokenScopes = [...byScope.values()]
      .filter((b) => b.scope !== "pooled")
      .sort((a, b) => a.scope.localeCompare(b.scope));

    return {
      data: {
        run: {
          runAt: new Date(run.run_at as string).toISOString(),
          source: String(run.source),
          method: String(run.method),
          historyFrom: run.history_from ? String(run.history_from) : null,
          historyTo: run.history_to ? String(run.history_to) : null,
          sessions: Number(run.sessions),
        },
        pooled,
        tokens: tokenScopes,
      },
      disclaimer,
    };
  });
}
