"use client";

// the mispricings board. onchain pool price versus morrow fair value per
// token, biggest absolute divergence on top. the daily-use page: dense,
// directional arrows, spread cells color-coded by the api thresholds,
// auto-refreshing.

import Link from "next/link";
import { fmtPct, fmtPrice, usePolled, type SpreadsPayload, type SpreadRow } from "@/lib/api";
import { CorporateActionBadge, RegimeBadge, SuspectBadge } from "@/components/RegimeBadge";

function spreadClass(absPct: number, warnPct: number, bigPct: number): string {
  if (absPct >= bigPct) return "red";
  if (absPct >= warnPct) return "amber";
  return "green";
}

function SpreadCell({
  row,
  warnPct,
  bigPct,
}: {
  row: SpreadRow;
  warnPct: number;
  bigPct: number;
}) {
  if (row.spreadPct === null) return <span className="faint">-</span>;
  const abs = Math.abs(row.spreadPct);
  const arrow = row.spreadPct > 0 ? "^" : row.spreadPct < 0 ? "v" : "=";
  return (
    <span className={spreadClass(abs, warnPct, bigPct)}>
      {arrow} {fmtPct(row.spreadPct)}
    </span>
  );
}

export default function SpreadsPage() {
  const { data, error, loading } = usePolled<SpreadsPayload>("/v1/spreads", 15_000);
  const warnPct = data?.thresholds.warnPct ?? 1;
  const bigPct = data?.thresholds.bigPct ?? 2;

  return (
    <div>
      <h1>mispricings board</h1>
      <p className="dim">
        onchain pool price against morrow off-hours fair value, biggest divergence first. the
        pool price is multiplier-adjusted and dollarized. a positive spread means the pool
        trades above fair value. refreshes every 15s. these are data statements, not trading
        advice.
      </p>

      {error && <div className="error-line">api unreachable: {error}</div>}
      {loading && !data && <div className="dim loading">loading spreads</div>}

      {data && (
        <table className="data">
          <thead>
            <tr>
              <th>token</th>
              <th className="num">spread</th>
              <th className="num">onchain spot</th>
              <th className="num">fair value</th>
              <th className="num">conf</th>
              <th>regime</th>
              <th>flags</th>
              <th className="num">updated</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.tokenId}>
                <td>
                  <Link className="symbol-link" href={`/token/${row.symbol}`}>
                    {row.symbol}
                  </Link>
                </td>
                <td className="num">
                  <SpreadCell row={row} warnPct={warnPct} bigPct={bigPct} />
                </td>
                <td className="num cyan">{fmtPrice(row.onchainSpot)}</td>
                <td className="num green">{fmtPrice(row.fairValue)}</td>
                <td className="num">{row.confidence}</td>
                <td>
                  <RegimeBadge regime={row.regime} />
                </td>
                <td>
                  <SuspectBadge suspect={row.suspect} />
                  <CorporateActionBadge corporateAction={row.corporateAction} />
                  {row.anchorStale && (
                    <span className="badge amber" title="anchor stale; band widened">
                      stale anchor
                    </span>
                  )}
                  {row.stale && (
                    <span className="badge down" title="last cycle is old; feed may be degraded">
                      stale feed
                    </span>
                  )}
                </td>
                <td className="num dim">{new Date(row.ts).toISOString().slice(11, 19)}z</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && data.rows.length === 0 && (
        <div className="dim">no fair values published yet.</div>
      )}
    </div>
  );
}
