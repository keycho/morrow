"use client";

// the spreads board. on-chain pool price against morrow off-hours fair value,
// biggest divergence first. thresholds come from the api, not the client.
// data statements, not trading advice.

import Link from "next/link";
import { fmtPct, fmtPrice, usePolled, type SpreadsPayload, type SpreadRow } from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { CorporateActionBadge, RegimeBadge, SuspectBadge } from "@/components/RegimeBadge";

function spreadClass(absPct: number, warnPct: number, bigPct: number): string {
  if (absPct >= bigPct) return "down"; // ink, heaviest
  if (absPct >= warnPct) return "flat";
  return "pos";
}

function SpreadCell({ row, warnPct, bigPct }: { row: SpreadRow; warnPct: number; bigPct: number }) {
  if (row.spreadPct === null) return <span className="unavailable">no pool</span>;
  const abs = Math.abs(row.spreadPct);
  const arrow = row.spreadPct > 0 ? "▲" : row.spreadPct < 0 ? "▼" : "=";
  const cls = spreadClass(abs, warnPct, bigPct);
  return (
    <span className={cls} style={abs >= bigPct ? { fontWeight: 600 } : undefined}>
      {arrow} {fmtPct(row.spreadPct)}
    </span>
  );
}

export default function SpreadsPage() {
  const { data, error, loading } = usePolled<SpreadsPayload>("/v1/spreads", 15_000);
  const warnPct = data?.thresholds.warnPct ?? 1;
  const bigPct = data?.thresholds.bigPct ?? 2;

  return (
    <>
      <SiteHeader />
      <main className="page">
        <section className="wrap">
          <div className="eyebrow">[ pool vs fair · biggest divergence first · refresh 15s ]</div>
          <h1 className="head">spreads.</h1>
          <p className="lead">
            on-chain pool price against morrow off-hours fair value, biggest divergence on top. the
            pool price is multiplier-adjusted and dollarized. a positive spread means the pool trades
            above fair value. these are data statements, not trading advice. thresholds: warn at{" "}
            {warnPct}%, wide at {bigPct}%.
          </p>

          {error && <div className="error-line">feed unavailable: {error}</div>}
          {loading && !data && <div className="loading">loading spreads…</div>}

          {data && data.rows.length === 0 && (
            <div className="unavailable">no fair values published yet.</div>
          )}

          {data && data.rows.length > 0 && (
            <div className="frame" style={{ margin: "20px 0 0" }}>
              <div className="frame-head">
                <span className="title">mispricings</span>
                <span className="count">{data.rows.length} tracked · sorted by absolute spread</span>
              </div>
              <div className="tablewrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>token</th>
                      <th className="num">spread</th>
                      <th className="num">pool spot</th>
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
                          <Link className="symbol-link" href={`/token/${row.symbol.toLowerCase()}`}>
                            {row.symbol}
                          </Link>
                        </td>
                        <td className="num">
                          <SpreadCell row={row} warnPct={warnPct} bigPct={bigPct} />
                        </td>
                        <td className="num">
                          {row.onchainSpot === null ? (
                            <span className="unavailable">-</span>
                          ) : (
                            fmtPrice(row.onchainSpot)
                          )}
                        </td>
                        <td className="num pos">{fmtPrice(row.fairValue)}</td>
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
              </div>
            </div>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
