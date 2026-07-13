"use client";

// token detail chart: fair value line, confidence band shading, onchain spot
// overlay. dependency-free inline svg.

import type { FairValue } from "@/lib/api";
import { fmtPrice } from "@/lib/api";

const W = 760;
const H = 280;
const PAD_L = 62;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 26;

export function PriceChart({ rows }: { rows: FairValue[] }) {
  if (rows.length < 2) {
    return <div className="faint">not enough history yet. the chart fills in as cycles publish.</div>;
  }

  const t0 = new Date(rows[0]!.ts).getTime();
  const t1 = new Date(rows[rows.length - 1]!.ts).getTime();
  const tSpan = Math.max(1, t1 - t0);

  const lows = rows.map((r) => r.bandLow);
  const highs = rows.map((r) => r.bandHigh);
  const spots = rows.map((r) => r.onchainSpot).filter((v): v is number => v !== null);
  const min = Math.min(...lows, ...(spots.length ? spots : lows));
  const max = Math.max(...highs, ...(spots.length ? spots : highs));
  const span = max - min || 1;

  const x = (ts: string): number => PAD_L + ((new Date(ts).getTime() - t0) / tSpan) * (W - PAD_L - PAD_R);
  const y = (v: number): number => PAD_T + (1 - (v - min) / span) * (H - PAD_T - PAD_B);

  const bandPath =
    rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(r.ts).toFixed(1)},${y(r.bandHigh).toFixed(1)}`).join(" ") +
    " " +
    [...rows]
      .reverse()
      .map((r) => `L${x(r.ts).toFixed(1)},${y(r.bandLow).toFixed(1)}`)
      .join(" ") +
    " Z";

  const fairLine = rows
    .map((r, i) => `${i === 0 ? "M" : "L"}${x(r.ts).toFixed(1)},${y(r.fairValue).toFixed(1)}`)
    .join(" ");

  const spotLine = rows
    .filter((r) => r.onchainSpot !== null)
    .map((r, i) => `${i === 0 ? "M" : "L"}${x(r.ts).toFixed(1)},${y(r.onchainSpot as number).toFixed(1)}`)
    .join(" ");

  const gridLines = 4;
  const gridVals = Array.from({ length: gridLines + 1 }, (_, i) => min + (span * i) / gridLines);

  const suspects = rows.filter((r) => r.suspect);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ border: "1px solid var(--border)", background: "var(--panel-2)" }}>
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={PAD_L} y1={y(v)} x2={W - PAD_R} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD_L - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--dim)">
              {fmtPrice(v)}
            </text>
          </g>
        ))}
        <path d={bandPath} fill="rgba(74, 222, 128, 0.08)" stroke="none" />
        {spotLine && <path d={spotLine} fill="none" stroke="var(--cyan)" strokeWidth="1" strokeDasharray="3 3" />}
        <path d={fairLine} fill="none" stroke="var(--green)" strokeWidth="1.5" />
        {suspects.map((r) => (
          <circle key={r.cycleId} cx={x(r.ts)} cy={y(r.fairValue)} r="3" fill="var(--red)" />
        ))}
        <text x={PAD_L} y={H - 8} fontSize="10" fill="var(--dim)">
          {new Date(rows[0]!.ts).toISOString().slice(0, 16).replace("T", " ")}
        </text>
        <text x={W - PAD_R} y={H - 8} textAnchor="end" fontSize="10" fill="var(--dim)">
          {new Date(rows[rows.length - 1]!.ts).toISOString().slice(0, 16).replace("T", " ")}
        </text>
      </svg>
      <div className="dim" style={{ marginTop: 6 }}>
        <span className="green">--</span> fair value &nbsp;
        <span style={{ color: "rgba(74, 222, 128, 0.5)" }}>&#9618;</span> confidence band &nbsp;
        <span className="cyan">- -</span> onchain spot &nbsp;
        <span className="red">o</span> suspect
      </div>
    </div>
  );
}
