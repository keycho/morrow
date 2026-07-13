"use client";

// token detail: price chart with band shading and spot overlay, model
// decomposition, recent commits with explorer links, accuracy stats.

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

export default function TokenPage({ params }: { params: { symbol: string } }) {
  const symbol = params.symbol.toLowerCase();
  const { data, error } = usePolled<{ latest: FairValue; history24h: FairValue[] }>(
    `/v1/prices/${symbol}`,
    30_000
  );
  const commits = usePolled<CommitRow[]>("/v1/commits?limit=10", 60_000);
  const accuracy = usePolled<AccuracyPayload>(`/v1/accuracy/${symbol}`, 300_000);

  if (error) return <div className="error-line">{error}</div>;
  if (!data) return <div className="dim loading">loading {symbol}</div>;

  const { latest, history24h } = data;

  return (
    <div>
      <h1>
        {latest.symbol} <span className="dim">/ {latest.name}</span>
      </h1>

      <div className="panel">
        <div className="kv">
          <span className="k">fair value</span>
          <span className="v green" style={{ fontSize: 16 }}>
            {fmtPrice(latest.fairValue)}{" "}
            <span style={{ fontSize: 13 }}>
              <RegimeBadge regime={latest.regime} /> <SuspectBadge suspect={latest.suspect} />{" "}
              <CorporateActionBadge corporateAction={latest.corporateAction} />
            </span>
          </span>
          <span className="k">confidence</span>
          <span className="v">{latest.confidence} / 100</span>
          <span className="k">band</span>
          <span className="v dim">
            {fmtPrice(latest.bandLow)} .. {fmtPrice(latest.bandHigh)}
          </span>
          <span className="k">onchain spot</span>
          <span className="v cyan">{fmtPrice(latest.onchainSpot)}</span>
          <span className="k">onchain twap</span>
          <span className="v">{fmtPrice(latest.onchainTwap)}</span>
          <span className="k">anchor (last close)</span>
          <span className="v">{fmtPrice(latest.anchorPrice)}</span>
          <span className="k">drift since close</span>
          <span className="v">{latest.drift === null ? "-" : fmtPct(latest.drift * 100, 3)}</span>
          <span className="k">±2% depth</span>
          <span className="v">
            {latest.depthQuote === null ? "-" : `$${Math.round(latest.depthQuote).toLocaleString("en-US")}`}
          </span>
          <span className="k">cycle</span>
          <span className="v">
            {latest.cycleId} <span className="dim">({fmtAge(Date.now() - new Date(latest.ts).getTime())})</span>
          </span>
        </div>
      </div>

      <h2>last 24h</h2>
      <PriceChart rows={history24h} />

      <div className="grid cols-2">
        <div>
          <h2>recent commits</h2>
          {commits.data ? (
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
                      <Link href={`/commits?cycle=${c.cycleId}`}>{c.cycleId}</Link>
                    </td>
                    <td className="dim">{shortHex(c.merkleRoot, 6)}</td>
                    <td>
                      <span className={`badge ${c.status}`}>{c.status}</span>
                    </td>
                    <td>
                      {c.txHash ? (
                        txLink(c.txHash) ? (
                          <a href={txLink(c.txHash) as string} target="_blank" rel="noreferrer">
                            {shortHex(c.txHash, 5)}
                          </a>
                        ) : (
                          shortHex(c.txHash, 5)
                        )
                      ) : (
                        <span className="faint">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dim loading">loading commits</div>
          )}
        </div>

        <div>
          <h2>accuracy vs next open</h2>
          {accuracy.data ? (
            accuracy.data.stats ? (
              <div className="panel">
                <div className="kv">
                  <span className="k">samples</span>
                  <span className="v">{accuracy.data.stats.n}</span>
                  <span className="k">mean abs error</span>
                  <span className="v green">{accuracy.data.stats.meanAbsErrorPct.toFixed(3)}%</span>
                  <span className="k">median abs error</span>
                  <span className="v">{accuracy.data.stats.medianAbsErrorPct.toFixed(3)}%</span>
                  <span className="k">p90 abs error</span>
                  <span className="v">{accuracy.data.stats.p90AbsErrorPct.toFixed(3)}%</span>
                  <span className="k">bias (signed mean)</span>
                  <span className="v">{fmtPct(accuracy.data.stats.meanErrorPct, 3)}</span>
                  <span className="k">worst</span>
                  <span className="v amber">{accuracy.data.stats.worstAbsErrorPct.toFixed(3)}%</span>
                </div>
                <div className="faint" style={{ marginTop: 8 }}>
                  last published off-hours fair value vs the official next-open print.
                </div>
              </div>
            ) : (
              <div className="dim">{accuracy.data.note ?? "no samples yet."}</div>
            )
          ) : (
            <div className="dim loading">loading accuracy</div>
          )}
        </div>
      </div>
    </div>
  );
}
