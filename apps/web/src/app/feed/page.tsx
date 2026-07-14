"use client";

// the feed: every tracked token, its off-hours fair value, confidence band,
// regime, on-chain pool spot and the spread against fair. all live from
// /v1/prices; the sparkline pulls each token's 24h fair value history. nothing
// hardcoded; unavailable cells say so.

import Link from "next/link";
import { fmtPct, fmtPrice, usePolled, type FairValue } from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { CorporateActionBadge, RegimeBadge, SuspectBadge } from "@/components/RegimeBadge";
import { Sparkline } from "@/components/Sparkline";

function SpreadCell({ row }: { row: FairValue }) {
  if (row.onchainSpot === null || row.fairValue === 0) return <span className="unavailable">no pool</span>;
  const pct = (row.onchainSpot / row.fairValue - 1) * 100;
  const arrow = pct > 0.005 ? "▲" : pct < -0.005 ? "▼" : "=";
  const cls = pct > 0.005 ? "pos" : pct < -0.005 ? "neg" : "flat";
  return (
    <span className={cls}>
      {arrow} {fmtPct(pct)}
    </span>
  );
}

function SparkCell({ symbol }: { symbol: string }) {
  const { data } = usePolled<{ latest: FairValue; history24h: FairValue[] }>(
    `/v1/prices/${symbol.toLowerCase()}`,
    60_000
  );
  if (!data) return <span className="unavailable">-</span>;
  return <Sparkline values={data.history24h.map((r) => r.fairValue)} />;
}

export default function FeedPage() {
  const { data, error, loading } = usePolled<FairValue[]>("/v1/prices", 30_000);

  return (
    <>
      <SiteHeader />
      <main className="page">
        <section className="wrap">
          <div className="eyebrow">[ off-hours fair value feed · one print per 600s ]</div>
          <h1 className="head">the feed.</h1>
          <p className="lead">
            while the underlying market is closed, morrow publishes a fair value per tracked stock
            token with a confidence band. every cycle is committed on-chain and checkable on the{" "}
            <Link href="/commits">explorer</Link>. see the{" "}
            <Link href="/spreads">spreads board</Link> for the biggest pool-vs-fair divergences.
          </p>

          {error && <div className="error-line">feed unavailable: {error}</div>}
          {loading && !data && <div className="loading">loading feed…</div>}

          {data && data.length === 0 && (
            <div className="unavailable">no fair values published yet. is the indexer running.</div>
          )}

          {data && data.length > 0 && (
            <div className="frame" style={{ margin: "20px 0 0" }}>
              <div className="frame-head">
                <span className="title">tracked tokens</span>
                <span className="count">
                  {data.length} live · refreshing every 30s
                </span>
              </div>
              <div className="tablewrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>token</th>
                      <th className="num">fair value</th>
                      <th className="num">conf</th>
                      <th className="num">band</th>
                      <th>regime</th>
                      <th className="num">pool spot</th>
                      <th className="num">spot vs fair</th>
                      <th>24h</th>
                      <th className="num">updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((row) => (
                      <tr key={row.tokenId}>
                        <td>
                          <Link className="symbol-link" href={`/token/${row.symbol.toLowerCase()}`}>
                            {row.symbol}
                          </Link>{" "}
                          <SuspectBadge suspect={row.suspect} />
                          <CorporateActionBadge corporateAction={row.corporateAction} />
                        </td>
                        <td className="num pos">{fmtPrice(row.fairValue)}</td>
                        <td className="num">{row.confidence}</td>
                        <td className="num dim">
                          {fmtPrice(row.bandLow)} .. {fmtPrice(row.bandHigh)}
                        </td>
                        <td>
                          <RegimeBadge regime={row.regime} />
                        </td>
                        <td className="num">
                          {row.onchainSpot === null ? (
                            <span className="unavailable">-</span>
                          ) : (
                            fmtPrice(row.onchainSpot)
                          )}
                        </td>
                        <td className="num">
                          <SpreadCell row={row} />
                        </td>
                        <td>
                          <SparkCell symbol={row.symbol} />
                        </td>
                        <td className="num dim">
                          {new Date(row.ts).toISOString().slice(11, 19)}z
                        </td>
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
