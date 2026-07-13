"use client";

// receipts page. the weekly accuracy track record: one card per week, newest
// first. each card is the server-rendered png plus the per-token summary.
// this is the marketing surface, generated only, never auto-posted.

import { API_URL } from "@/lib/constants";
import { usePolled, type ReceiptListItem } from "@/lib/api";

function absPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v.toFixed(3)}%`;
}

function ReceiptCard({ r }: { r: ReceiptListItem }) {
  const tokens = r.summary.tokens ?? [];
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>
        week {r.weekStart} to {r.weekEnd}
      </h2>
      {r.hasPng && (
        <img
          src={`${API_URL}/v1/receipts/${r.weekStart}/card.png`}
          alt={`morrow accuracy receipt for the week of ${r.weekStart}`}
          style={{ maxWidth: "100%", border: "1px solid var(--border)", marginBottom: 10 }}
        />
      )}
      <table className="data">
        <thead>
          <tr>
            <th>token</th>
            <th className="num">samples</th>
            <th className="num">mean abs error</th>
            <th>best call</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.symbol}>
              <td>{t.symbol}</td>
              <td className="num dim">{t.samples}</td>
              <td className="num green">{absPct(t.meanAbsErrorPct)}</td>
              <td className="dim">
                {t.bestCall
                  ? `${absPct(Math.abs(t.bestCall.errorPct))} on ${t.bestCall.date}`
                  : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dim" style={{ marginTop: 8 }}>
        cycles committed on-chain: {r.summary.cyclesCommitted ?? 0}
      </div>
    </div>
  );
}

export default function ReceiptsPage() {
  const { data, error, loading } = usePolled<ReceiptListItem[]>("/v1/receipts?limit=52", 300_000);

  return (
    <div>
      <h1>weekly accuracy receipts</h1>
      <p className="dim">
        each week, morrow scores its pre-open fair value against the actual next-open print, per
        token, and publishes the mean absolute error, the best call, and the cycles committed
        on-chain. newest first.
      </p>

      {error && <div className="error-line">api unreachable: {error}</div>}
      {loading && !data && <div className="dim loading">loading receipts</div>}

      {data && data.length === 0 && (
        <div className="dim">
          no receipts yet. they generate weekly once open anchors are landing, or run
          <code> pnpm receipts</code>.
        </div>
      )}

      {data && data.map((r) => <ReceiptCard key={r.weekStart} r={r} />)}
    </div>
  );
}
