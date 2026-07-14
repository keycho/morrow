"use client";

// token detail: the model decomposition, a price chart with band shading and
// spot overlay, recent commits, and realized accuracy vs the next open. all
// live; accuracy says "no samples yet" plainly until open prints land.

import Link from "next/link";
import {
  fmtAge,
  fmtPct,
  fmtPrice,
  shortHex,
  usePolled,
  type AccuracyPayload,
  type CommitRow,
  type FairValue,
} from "@/lib/api";
import { txLink } from "@/lib/constants";
import { PriceChart } from "@/components/PriceChart";
import { CorporateActionBadge, RegimeBadge, SuspectBadge } from "@/components/RegimeBadge";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

export default function TokenPage({ params }: { params: { symbol: string } }) {
  const symbol = params.symbol.toLowerCase();
  const { data, error } = usePolled<{ latest: FairValue; history24h: FairValue[] }>(
    `/v1/prices/${symbol}`,
    30_000
  );
  const commits = usePolled<CommitRow[]>("/v1/commits?limit=10", 60_000);
  const accuracy = usePolled<AccuracyPayload>(`/v1/accuracy/${symbol}`, 300_000);

  return (
    <>
      <SiteHeader />
      <main className="page">
        <section className="wrap">
          {error && <div className="error-line">{error}</div>}
          {!data && !error && <div className="loading">loading {symbol}…</div>}

          {data && (
            <>
              <div className="eyebrow">
                <Link href="/feed">feed</Link> / {symbol}
              </div>
              <h1 className="head">
                {data.latest.symbol.toUpperCase()}{" "}
                <span className="dim" style={{ fontSize: 24 }}>
                  {data.latest.name.toLowerCase()}
                </span>
              </h1>

              <div className="panel raised">
                <div className="kv">
                  <span className="k">fair value</span>
                  <span className="v pos" style={{ fontSize: 16 }}>
                    {fmtPrice(data.latest.fairValue)}{" "}
                    <span style={{ fontSize: 12 }}>
                      <RegimeBadge regime={data.latest.regime} />{" "}
                      <SuspectBadge suspect={data.latest.suspect} />{" "}
                      <CorporateActionBadge corporateAction={data.latest.corporateAction} />
                    </span>
                  </span>
                  <span className="k">confidence</span>
                  <span className="v">{data.latest.confidence} / 100</span>
                  <span className="k">band</span>
                  <span className="v dim">
                    {fmtPrice(data.latest.bandLow)} .. {fmtPrice(data.latest.bandHigh)}
                  </span>
                  <span className="k">pool spot</span>
                  <span className="v">
                    {data.latest.onchainSpot === null ? (
                      <span className="unavailable">no pool</span>
                    ) : (
                      fmtPrice(data.latest.onchainSpot)
                    )}
                  </span>
                  <span className="k">onchain twap</span>
                  <span className="v">
                    {data.latest.onchainTwap === null ? (
                      <span className="unavailable">-</span>
                    ) : (
                      fmtPrice(data.latest.onchainTwap)
                    )}
                  </span>
                  <span className="k">anchor (last close)</span>
                  <span className="v">
                    {data.latest.anchorPrice === null ? (
                      <span className="unavailable">-</span>
                    ) : (
                      fmtPrice(data.latest.anchorPrice)
                    )}
                  </span>
                  <span className="k">drift since close</span>
                  <span className="v">
                    {data.latest.drift === null ? (
                      <span className="unavailable">-</span>
                    ) : (
                      fmtPct(data.latest.drift * 100, 3)
                    )}
                  </span>
                  <span className="k">±2% depth</span>
                  <span className="v">
                    {data.latest.depthQuote === null ? (
                      <span className="unavailable">-</span>
                    ) : (
                      `$${Math.round(data.latest.depthQuote).toLocaleString("en-US")}`
                    )}
                  </span>
                  <span className="k">cycle</span>
                  <span className="v">
                    #{data.latest.cycleId.toLocaleString("en-US")}{" "}
                    <span className="dim">({fmtAge(Date.now() - new Date(data.latest.ts).getTime())})</span>
                  </span>
                </div>
              </div>

              <h2 className="sub" style={{ fontSize: 24, marginTop: 24 }}>
                last 24h
              </h2>
              <PriceChart rows={data.history24h} />

              <div className="grid cols-2" style={{ marginTop: 24 }}>
                <div>
                  <h2 className="sub" style={{ fontSize: 24 }}>
                    recent commits
                  </h2>
                  {commits.data ? (
                    <div className="tablewrap">
                      <table className="data">
                        <thead>
                          <tr>
                            <th>cycle</th>
                            <th>root</th>
                            <th>status</th>
                            <th>tx</th>
                          </tr>
                        </thead>
                        <tbody>
                          {commits.data.map((c) => (
                            <tr key={c.cycleId}>
                              <td>
                                <Link href={`/commits?cycle=${c.cycleId}`} className="symbol-link">
                                  #{c.cycleId.toLocaleString("en-US")}
                                </Link>
                              </td>
                              <td className="hex">{shortHex(c.merkleRoot, 6)}</td>
                              <td>
                                <span className={`badge ${c.status}`}>{c.status}</span>
                              </td>
                              <td>
                                {c.txHash ? (
                                  txLink(c.txHash) ? (
                                    <a href={txLink(c.txHash) as string} target="_blank" rel="noreferrer" className="hex">
                                      {shortHex(c.txHash, 5)}
                                    </a>
                                  ) : (
                                    <span className="hex">{shortHex(c.txHash, 5)}</span>
                                  )
                                ) : (
                                  <span className="unavailable">-</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="loading">loading commits…</div>
                  )}
                </div>

                <div>
                  <h2 className="sub" style={{ fontSize: 24 }}>
                    accuracy vs next open
                  </h2>
                  {accuracy.data ? (
                    accuracy.data.stats ? (
                      <div className="panel">
                        <div className="kv">
                          <span className="k">samples</span>
                          <span className="v">{accuracy.data.stats.n}</span>
                          <span className="k">mean abs error</span>
                          <span className="v pos">{accuracy.data.stats.meanAbsErrorPct.toFixed(3)}%</span>
                          <span className="k">median abs error</span>
                          <span className="v">{accuracy.data.stats.medianAbsErrorPct.toFixed(3)}%</span>
                          <span className="k">p90 abs error</span>
                          <span className="v">{accuracy.data.stats.p90AbsErrorPct.toFixed(3)}%</span>
                          <span className="k">bias (signed mean)</span>
                          <span className="v">{fmtPct(accuracy.data.stats.meanErrorPct, 3)}</span>
                          <span className="k">worst</span>
                          <span className="v flat">{accuracy.data.stats.worstAbsErrorPct.toFixed(3)}%</span>
                        </div>
                        <div className="faint" style={{ marginTop: 8 }}>
                          last published off-hours fair value vs the official next-open print.
                        </div>
                      </div>
                    ) : (
                      <div className="unavailable">{accuracy.data.note ?? "no samples yet."}</div>
                    )
                  ) : (
                    <div className="loading">loading accuracy…</div>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
