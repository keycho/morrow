"use client";

// weekly accuracy receipts. one card per week, newest first: the server-rendered
// png plus the per-token summary. generated only, never auto-posted.

import { API_URL } from "@/lib/constants";
import { usePolled, type ReceiptListItem } from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

function absPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v.toFixed(3)}%`;
}

function ReceiptCard({ r }: { r: ReceiptListItem }) {
  const tokens = r.summary.tokens ?? [];
  return (
    <div className="rcard">
      <h2 className="sub" style={{ fontSize: 24, marginBottom: 6 }}>
        week {r.weekStart} to {r.weekEnd}
      </h2>
      {r.hasPng ? (
        <img
          src={`${API_URL}/v1/receipts/${r.weekStart}/card.png`}
          alt={`morrow accuracy receipt for the week of ${r.weekStart}`}
        />
      ) : (
        <div className="unavailable" style={{ margin: "12px 0" }}>
          card image not rendered for this week.
        </div>
      )}
      {tokens.length > 0 ? (
        <div className="tablewrap">
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
                  <td className="symbol-link">{t.symbol}</td>
                  <td className="num dim">{t.samples}</td>
                  <td className="num pos">{absPct(t.meanAbsErrorPct)}</td>
                  <td className="dim">
                    {t.bestCall
                      ? `${absPct(Math.abs(t.bestCall.errorPct))} on ${t.bestCall.date}`
                      : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="unavailable">no scored tokens this week yet.</div>
      )}
      <div className="dim" style={{ marginTop: 10 }}>
        cycles committed on-chain: {r.summary.cyclesCommitted ?? 0}
      </div>
    </div>
  );
}

export default function ReceiptsPage() {
  const { data, error, loading } = usePolled<ReceiptListItem[]>("/v1/receipts?limit=52", 300_000);

  return (
    <>
      <SiteHeader />
      <main className="page">
        <section className="wrap">
          <div className="eyebrow">[ weekly track record · pre-open fair value vs next open ]</div>
          <h1 className="head">receipts.</h1>
          <p className="lead">
            each week, morrow scores its pre-open fair value against the actual next-open print, per
            token, and publishes the mean absolute error, the best call, and the cycles committed
            on-chain. newest first.
          </p>

          {error && <div className="error-line">feed unavailable: {error}</div>}
          {loading && !data && <div className="loading">loading receipts…</div>}

          {data && data.length === 0 && (
            <div className="unavailable">
              no receipts yet. they generate weekly once open anchors are landing, or run{" "}
              <code>pnpm receipts</code>.
            </div>
          )}

          {data && data.length > 0 && (
            <div className="card-list" style={{ marginTop: 20 }}>
              {data.map((r) => (
                <ReceiptCard key={r.weekStart} r={r} />
              ))}
            </div>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
