"use client";

// main view: dense table of tracked tokens. fair value, confidence, band,
// regime, onchain spot vs fair value spread with directional ascii arrows,
// sparkline of the last 24h.

import Link from "next/link";
import { fmtPct, fmtPrice, usePolled, type FairValue } from "@/lib/api";
import { CorporateActionBadge, RegimeBadge, SuspectBadge } from "@/components/RegimeBadge";
import { Sparkline } from "@/components/Sparkline";

function SpreadCell({ row }: { row: FairValue }) {
  if (row.onchainSpot === null || row.fairValue === 0) return <span className="faint">-</span>;
  const spreadPct = (row.onchainSpot / row.fairValue - 1) * 100;
  const arrow = spreadPct > 0.005 ? "^" : spreadPct < -0.005 ? "v" : "=";
  const cls = spreadPct > 0.005 ? "arrow-up" : spreadPct < -0.005 ? "arrow-down" : "faint";
  return (
    <span className={cls}>
      {arrow} {fmtPct(spreadPct)}
    </span>
  );
}

function SparkCell({ symbol }: { symbol: string }) {
  const { data } = usePolled<{ latest: FairValue; history24h: FairValue[] }>(
    `/v1/prices/${symbol}`,
    60_000
  );
  if (!data) return <span className="faint loading" />;
  return <Sparkline values={data.history24h.map((r) => r.fairValue)} />;
}

export default function Home() {
  const { data, error, loading } = usePolled<FairValue[]>("/v1/prices", 30_000);

  return (
    <div>
      <h1>off-hours fair value feed</h1>
      <p className="dim">
        when the underlying market is closed, morrow publishes a fair value estimate per tracked
        stock token with a confidence band. every cycle is committed on-chain and verifiable on
        the <Link href="/commits">commits</Link> page.
      </p>
      <div className="panel">
        <span className="green">{">>--->"}</span> see the{" "}
        <Link href="/spreads">mispricings board</Link> for the biggest onchain-vs-fair
        divergences right now, sorted by spread.
      </div>

      {error && <div className="error-line">api unreachable: {error}</div>}
      {loading && !data && <div className="dim loading">loading feed</div>}

      {data && (
        <table className="data">
          <thead>
            <tr>
              <th>token</th>
              <th className="num">fair value</th>
              <th className="num">conf</th>
              <th className="num">band</th>
              <th>regime</th>
              <th className="num">onchain spot</th>
              <th className="num">spot vs fair</th>
              <th>24h</th>
              <th className="num">updated</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.tokenId}>
                <td>
                  <Link className="symbol-link" href={`/token/${row.symbol}`}>
                    {row.symbol}
                  </Link>{" "}
                  <SuspectBadge suspect={row.suspect} />
                  <CorporateActionBadge corporateAction={row.corporateAction} />
                </td>
                <td className="num green">{fmtPrice(row.fairValue)}</td>
                <td className="num">{row.confidence}</td>
                <td className="num dim">
                  {fmtPrice(row.bandLow)} .. {fmtPrice(row.bandHigh)}
                </td>
                <td>
                  <RegimeBadge regime={row.regime} />
                </td>
                <td className="num cyan">{fmtPrice(row.onchainSpot)}</td>
                <td className="num">
                  <SpreadCell row={row} />
                </td>
                <td>
                  <SparkCell symbol={row.symbol} />
                </td>
                <td className="num dim">{new Date(row.ts).toISOString().slice(11, 19)}z</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && data.length === 0 && (
        <div className="dim">no fair values published yet. is the indexer running?</div>
      )}
    </div>
  );
}
