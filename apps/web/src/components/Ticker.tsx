"use client";

// the landing's scrolling footer ticker. every value is live: regime and next
// open from the client clock, cycle id and root from the latest commit, per
// token price and spread from the feed, and the median error from the pooled
// accuracy endpoint. the track is rendered twice for a seamless marquee.

import { Fragment, useEffect, useState } from "react";
import { fmtPrice, shortHex, type CommitRow, type FairValue } from "@/lib/api";
import { regimeNow, regimeLabel, nextOpenDay } from "@/lib/marketClock";

function utcHm(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16) + " utc";
}

function spreadFor(row: FairValue): { text: string; cls: string } | null {
  if (row.onchainSpot === null || row.fairValue === 0) return null;
  const pct = (row.onchainSpot / row.fairValue - 1) * 100;
  const cls = pct > 0.005 ? "pos" : pct < -0.005 ? "neg" : "flat";
  const sign = pct > 0 ? "+" : "";
  return { text: `${sign}${pct.toFixed(2)}%`, cls };
}

export function Ticker({
  rows,
  commit,
  medianErrPct,
  anySamples,
}: {
  rows: FairValue[];
  commit: CommitRow | null;
  medianErrPct: number | null;
  anySamples: boolean;
}) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const regime = now ? regimeNow(now) : null;
  const items: React.ReactNode[] = [];

  if (regime) {
    items.push(
      <span className="strong" key="regime">
        <span className="dot" />
        {regimeLabel(regime).toUpperCase()}
      </span>
    );
    if (regime !== "market_open" && now) {
      items.push(<span key="nextopen">next open {nextOpenDay(now)} 09:30 et</span>);
    }
  }

  if (commit) {
    items.push(
      <span key="cycle">
        cycle #{commit.cycleId.toLocaleString("en-US")} · {utcHm(commit.committedAt ?? commit.createdAt)}
      </span>
    );
    items.push(<span key="root">root {shortHex(commit.merkleRoot, 6)}</span>);
    items.push(<span key="obs">{commit.observationCount} obs</span>);
  }

  for (const row of rows) {
    const sp = spreadFor(row);
    items.push(
      <span className="strong" key={`px-${row.tokenId}`} style={{ fontWeight: 600 }}>
        {row.symbol.toUpperCase()} {fmtPrice(row.fairValue)}
        {sp && <span className={sp.cls}> {sp.text}</span>}
      </span>
    );
  }

  items.push(
    <span key="median">
      median err {anySamples && medianErrPct !== null ? `${medianErrPct.toFixed(2)}%` : "no samples yet"}
    </span>
  );

  if (commit && commit.txHash) {
    items.push(
      <span className="strong" key="verified">
        <span className="dot" />
        verified
      </span>
    );
  }

  items.push(
    <span key="disc">
      informational feed · not for use in liquidations or settlement · no warranty
    </span>
  );

  if (items.length === 0) {
    items.push(<span key="empty">feed unavailable</span>);
  }

  const sequence = (copy: number): React.ReactNode => (
    <>
      {items.map((node, i) => (
        <Fragment key={`${copy}-${i}`}>
          {i > 0 && <span className="sep">·</span>}
          {node}
        </Fragment>
      ))}
    </>
  );

  return (
    <footer className="ticker" aria-hidden="true">
      <div className="ticker-track">
        {sequence(0)}
        <span className="sep">·</span>
        {sequence(1)}
      </div>
    </footer>
  );
}
