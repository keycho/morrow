"use client";

// the evidence section for the docs page. reads /v1/backtest and states plainly
// whether morrow beats the naive "opens where it closed" baseline, per token
// and pooled. every number is live from the latest stored backtest run; when no
// run exists it says so rather than inventing a result.

import { usePolled, type BacktestPayload, type BacktestScope } from "@/lib/api";

function pct(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v.toFixed(digits)}%`;
}

function improvement(scope: BacktestScope): number | null {
  if (!scope.naive || !scope.morrow || scope.naive.maePct === 0) return null;
  return ((scope.naive.maePct - scope.morrow.maePct) / scope.naive.maePct) * 100;
}

function Verdict({ pooled }: { pooled: BacktestScope }) {
  const imp = improvement(pooled);
  const beats = imp !== null && imp > 0;
  const naiveMae = pooled.naive?.maePct ?? null;
  const morrowMae = pooled.morrow?.maePct ?? null;
  const hit = pooled.morrow?.hitRate ?? null;
  const win = pooled.morrow?.winRateVsNaive ?? null;
  const sessions = pooled.morrow?.n ?? pooled.naive?.n ?? 0;

  return (
    <div className="panel raised" style={{ borderLeft: "3px solid var(--forest)" }}>
      <div style={{ fontSize: 15, marginBottom: 8 }}>
        {imp === null ? (
          "backtest inconclusive."
        ) : beats ? (
          <>
            over {sessions.toLocaleString("en-US")} past session boundaries, morrow beats the naive
            baseline by <strong>{Math.abs(imp).toFixed(1)}%</strong> on mean absolute error
            ({pct(naiveMae, 3)} to {pct(morrowMae, 3)}).
          </>
        ) : (
          <>
            over {sessions.toLocaleString("en-US")} past session boundaries, morrow does not beat the
            naive baseline: it is <strong>{Math.abs(imp).toFixed(1)}% worse</strong> on mean absolute
            error ({pct(naiveMae, 3)} to {pct(morrowMae, 3)}).
          </>
        )}
      </div>
      <div className="dim" style={{ fontSize: 13 }}>
        it gets the direction of the overnight move right {hit === null ? "-" : `${(hit * 100).toFixed(1)}%`} of
        the time, and wins on {win === null ? "-" : `${(win * 100).toFixed(1)}%`} of individual sessions. naive
        means the predicted open equals the last close, which is exactly what morrow outputs when drift is zero.
      </div>
    </div>
  );
}

function Row({ s }: { s: BacktestScope }) {
  const imp = improvement(s);
  return (
    <tr>
      <td className="symbol-link">{s.scope}</td>
      <td className="num dim">{pct(s.naive?.maePct, 3)}</td>
      <td className="num pos">{pct(s.morrow?.maePct, 3)}</td>
      <td className="num">
        {imp === null ? "-" : <span className={imp > 0 ? "pos" : "neg"}>{imp > 0 ? "+" : ""}{imp.toFixed(1)}%</span>}
      </td>
      <td className="num">{s.morrow?.hitRate == null ? "-" : `${(s.morrow.hitRate * 100).toFixed(1)}%`}</td>
      <td className="num">
        {s.morrow?.winRateVsNaive == null ? "-" : `${(s.morrow.winRateVsNaive * 100).toFixed(1)}%`}
      </td>
    </tr>
  );
}

export function BacktestEvidence() {
  const { data, error, loading } = usePolled<BacktestPayload>("/v1/backtest", 600_000);

  if (loading && !data) return <div className="loading">loading backtest…</div>;
  if (error) return <div className="unavailable">backtest evidence unavailable: {error}</div>;
  if (!data || data.pooled === null) {
    return (
      <div className="unavailable">
        no backtest run recorded yet. run <code>pnpm backtest</code> to score morrow against the naive
        baseline over historical sessions.
      </div>
    );
  }

  return (
    <div>
      <Verdict pooled={data.pooled} />

      <div className="tablewrap" style={{ marginTop: 16 }}>
        <table className="data">
          <thead>
            <tr>
              <th>token</th>
              <th className="num">naive mae</th>
              <th className="num">morrow mae</th>
              <th className="num">improvement</th>
              <th className="num">direction hit</th>
              <th className="num">beats naive</th>
            </tr>
          </thead>
          <tbody>
            {data.tokens.map((s) => (
              <Row key={s.scope} s={s} />
            ))}
            <Row s={data.pooled} />
          </tbody>
        </table>
      </div>

      <p className="dim" style={{ fontSize: 12, marginTop: 12 }}>
        history: {data.run.source}, {data.run.historyFrom ?? "?"} to {data.run.historyTo ?? "?"},{" "}
        {data.run.sessions.toLocaleString("en-US")} session boundaries. the backtest reconstructs
        drift from daily proxy bars, so the overnight window is approximate; it also cannot test the
        onchain blend, since there is no pool history, so the morrow and drift-only predictors
        coincide here. the production-fidelity forward test is <a href="/receipts">the accuracy
        receipts</a>, which score live predictions against the real next open as the feed runs.
      </p>
    </div>
  );
}
