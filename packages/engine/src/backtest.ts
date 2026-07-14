// backtest scoring. pure functions that turn a set of per-session prediction
// errors into the metrics the `pnpm backtest` command reports and stores. kept
// here, next to the fair value math, so the scoring is unit-tested off a live
// database exactly like the rest of the engine. the script in scripts/backtest
// only assembles data (history fetch, model replay) and calls these.

export interface Metrics {
  n: number;
  maePct: number;
  medianAePct: number;
  rmsePct: number;
  meanErrorPct: number; // signed bias, positive = predicts high
  worstPct: number;
  p50AbsPct: number;
  p90AbsPct: number;
  hitRate: number | null; // directional; null when the predictor makes no call
  winRateVsNaive: number | null; // fraction of sessions strictly beating naive
}

export function median(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 ? sortedAsc[mid]! : (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1)
  );
  return sortedAsc[idx]!;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// score one predictor.
//   errs      signed fractional errors (predicted/actual - 1)
//   predGap   predicted overnight gap per session, or null when the predictor
//             makes no directional call (naive always predicts a flat open)
//   actualGap realized overnight gap per session
//   naiveAbs  the naive predictor's absolute error per session, or null when
//             scoring naive itself (nothing to beat)
export function scoreMetrics(
  errs: number[],
  predGap: number[] | null,
  actualGap: number[],
  naiveAbs: number[] | null
): Metrics {
  const abs = errs.map((e) => Math.abs(e)).sort((a, b) => a - b);
  const rmse = Math.sqrt(mean(errs.map((e) => e * e)));

  let hitRate: number | null = null;
  if (predGap) {
    let calls = 0;
    let hits = 0;
    for (let i = 0; i < predGap.length; i++) {
      const pg = predGap[i]!;
      const ag = actualGap[i]!;
      if (pg === 0 || ag === 0) continue;
      calls++;
      if (Math.sign(pg) === Math.sign(ag)) hits++;
    }
    hitRate = calls > 0 ? hits / calls : null;
  }

  let winRate: number | null = null;
  if (naiveAbs) {
    let wins = 0;
    for (let i = 0; i < errs.length; i++) if (Math.abs(errs[i]!) < naiveAbs[i]!) wins++;
    winRate = errs.length ? wins / errs.length : null;
  }

  return {
    n: errs.length,
    maePct: mean(abs) * 100,
    medianAePct: median(abs) * 100,
    rmsePct: rmse * 100,
    meanErrorPct: mean(errs) * 100,
    worstPct: (abs[abs.length - 1] ?? 0) * 100,
    p50AbsPct: percentile(abs, 50) * 100,
    p90AbsPct: percentile(abs, 90) * 100,
    hitRate,
    winRateVsNaive: winRate,
  };
}
