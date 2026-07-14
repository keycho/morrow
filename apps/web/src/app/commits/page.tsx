"use client";

// the explorer / commit trail. overview tiles bind to the live feed and, for
// the committed-root count, to the contract itself over rpc. the cycles table
// is the real commit history; each row's verify control drills into the
// browser-side proof check against the on-chain root.

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  fmtAge,
  shortHex,
  usePolled,
  type CommitRow,
  type FairValue,
  type HealthPayload,
} from "@/lib/api";
import { txLink } from "@/lib/constants";
import { readContractStats, resolveCommitsAddress } from "@/lib/chain";
import { regimeNow, regimeLabel } from "@/lib/marketClock";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { VerifyPanel } from "@/components/VerifyPanel";

const GRID = "0.7fr 0.7fr 0.9fr 1.7fr 0.6fr 1.6fr 0.5fr";
const PAGE_SIZE = 12;

type Stats = { commitCount: number; latestCycleId: number } | "loading" | "unavailable";

function compactAge(ms: number): string {
  return fmtAge(ms).replace(" ago", "");
}

function useContractStats(): Stats {
  const [stats, setStats] = useState<Stats>("loading");
  useEffect(() => {
    const addr = resolveCommitsAddress();
    if (!addr) {
      setStats("unavailable");
      return;
    }
    let cancelled = false;
    const load = (): void => {
      readContractStats(addr)
        .then((s) => {
          if (!cancelled) setStats(s);
        })
        .catch(() => {
          if (!cancelled) setStats("unavailable");
        });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  return stats;
}

function Tile({
  label,
  value,
  sub,
  dot = false,
}: {
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <div className="tile">
      <div className="tlabel">{label}</div>
      <div className="tval">
        {value}
        {dot && <span className="dot" />}
      </div>
      <div className="tsub">{sub}</div>
    </div>
  );
}

function ExplorerInner() {
  const searchParams = useSearchParams();
  const preselected = searchParams.get("cycle");

  const { data: commits, error, loading } = usePolled<CommitRow[]>("/v1/commits?limit=100", 60_000);
  const { data: health } = usePolled<HealthPayload>("/health", 30_000);
  const { data: prices } = usePolled<FairValue[]>("/v1/prices", 60_000);
  const stats = useContractStats();

  const symbols = useMemo(() => (prices ?? []).map((r) => r.symbol.toLowerCase()), [prices]);

  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selectedCycle, setSelectedCycle] = useState<number | undefined>(
    preselected ? Number(preselected) : undefined
  );

  const rows = commits ?? [];

  // overview numbers, all derived from real data.
  const latest = rows[0] ?? null;
  const cycleSeconds = health?.cycleSeconds ?? null;
  const commitsPerDay = cycleSeconds ? Math.round(86_400 / cycleSeconds) : null;

  const todayUtc = new Date().toISOString().slice(0, 10);
  const commitsToday = rows.filter(
    (c) => (c.committedAt ?? c.createdAt).slice(0, 10) === todayUtc
  );
  const obsToday = commitsToday.reduce((a, c) => a + c.observationCount, 0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (c) =>
        String(c.cycleId).includes(q) ||
        c.merkleRoot.toLowerCase().includes(q) ||
        (c.txHash ?? "").toLowerCase().includes(q)
    );
  }, [rows, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);
  const start = clampedPage * PAGE_SIZE;
  const pageRows = filtered.slice(start, start + PAGE_SIZE);

  const openVerify = (cycleId: number): void => {
    setSelectedCycle(cycleId);
    if (typeof document !== "undefined") {
      document.getElementById("verify")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <>
      <SiteHeader />
      <main className="page">
        {/* search strip */}
        <section className="strip">
          <div className="eyebrow" style={{ marginBottom: 16 }}>
            [ the commit trail · {commitsPerDay ?? "-"} cycles / day · one merkle root per{" "}
            {cycleSeconds ?? "-"}s ]
          </div>
          <div className="search-bar">
            <span className="filters">all cycles ▾</span>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              placeholder="search by cycle id, merkle root, or tx hash"
              aria-label="search commits"
            />
            <button onClick={() => setPage(0)}>search</button>
          </div>
        </section>

        {/* overview tiles */}
        <section className="tiles">
          <Tile
            label="latest cycle"
            value={latest ? `#${latest.cycleId.toLocaleString("en-US")}` : <span className="unavailable">-</span>}
            sub={
              latest ? (
                <>
                  {new Date(latest.committedAt ?? latest.createdAt).toISOString().slice(11, 19)} utc ·{" "}
                  {compactAge(Date.now() - new Date(latest.committedAt ?? latest.createdAt).getTime())}
                </>
              ) : (
                "no commits yet"
              )
            }
          />
          <Tile
            label="cycle interval"
            value={cycleSeconds ? `${cycleSeconds}s` : <span className="unavailable">-</span>}
            sub={commitsPerDay ? `${commitsPerDay} commits / day` : "interval unavailable"}
          />
          <Tile
            label="observations today"
            value={commits ? obsToday : <span className="unavailable">-</span>}
            sub={commits ? `across ${commitsToday.length} cycles today` : "feed unavailable"}
          />
          <Tile
            label="committed roots"
            dot={stats !== "loading" && stats !== "unavailable"}
            value={
              stats === "loading" ? (
                <span className="loading">…</span>
              ) : stats === "unavailable" ? (
                <span className="unavailable">unavailable</span>
              ) : (
                stats.commitCount.toLocaleString("en-US")
              )
            }
            sub={
              stats === "unavailable"
                ? "set commits address to read the contract"
                : "on robinhood chain, read via rpc"
            }
          />
        </section>

        {/* blunt line */}
        <section className="blunt">
          <h1>
            do not trust this feed. <span style={{ fontStyle: "italic", color: "var(--forest-italic)" }}>check it.</span>
          </h1>
          <p>
            every {cycleSeconds ?? 600}s morrow commits a merkle root of every observation on-chain.
            pick any cycle, take any leaf, and recompute the root in your own browser against the
            contract. morrow&apos;s server is not in the loop.
          </p>
        </section>

        {/* verify control */}
        <div id="verify">
          <VerifyPanel
            key={selectedCycle ?? "blank"}
            symbols={symbols}
            initialCycleId={selectedCycle}
          />
        </div>

        {/* cycles table */}
        <main className="frame">
          <div className="frame-head">
            <span className="title">latest cycles</span>
            <span className="count">
              {error
                ? "feed unavailable"
                : filtered.length === 0
                  ? "no matching commits"
                  : `showing ${start + 1} – ${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length.toLocaleString("en-US")} commits`}
            </span>
          </div>

          <div className="trow head" style={{ gridTemplateColumns: GRID }}>
            <span>cycle</span>
            <span>age</span>
            <span>regime</span>
            <span>merkle root</span>
            <span>leaves</span>
            <span>tx hash</span>
            <span className="r">verify</span>
          </div>

          {loading && !commits && <div style={{ padding: "16px 24px" }} className="loading">loading commits…</div>}
          {error && <div style={{ padding: "16px 24px" }} className="error-line">{error}</div>}

          {pageRows.map((c, i) => {
            const when = c.committedAt ?? c.createdAt;
            const regime = regimeNow(new Date(when));
            const isTop = clampedPage === 0 && i === 0;
            return (
              <div
                key={c.cycleId}
                className={`trow ${isTop ? "active" : ""}`}
                style={{ gridTemplateColumns: GRID }}
              >
                <button
                  onClick={() => openVerify(c.cycleId)}
                  style={{ background: "transparent", border: "none", padding: 0, textAlign: "left", cursor: "pointer", color: "var(--forest-italic)", fontWeight: isTop ? 600 : 400, fontFamily: "var(--mono)", fontSize: 12 }}
                >
                  #{c.cycleId.toLocaleString("en-US")}
                </button>
                <span className="dim">{compactAge(Date.now() - new Date(when).getTime())}</span>
                <span>{regimeLabel(regime)}</span>
                <span className="hex">{shortHex(c.merkleRoot, 8)}</span>
                <span>{c.observationCount}</span>
                <span>
                  {c.txHash ? (
                    txLink(c.txHash) ? (
                      <a href={txLink(c.txHash) as string} target="_blank" rel="noreferrer" className="hex">
                        {shortHex(c.txHash, 8)}
                      </a>
                    ) : (
                      <span className="hex">{shortHex(c.txHash, 8)}</span>
                    )
                  ) : (
                    <span className="unavailable">pending</span>
                  )}
                </span>
                <span className="r">
                  <button
                    onClick={() => openVerify(c.cycleId)}
                    aria-label={`verify cycle ${c.cycleId}`}
                    title="verify this cycle"
                    style={{ background: "transparent", border: "none", cursor: "pointer", padding: 4 }}
                  >
                    <span className="dot" />
                  </button>
                </span>
              </div>
            );
          })}

          {commits && filtered.length === 0 && !error && (
            <div style={{ padding: "16px 24px" }} className="unavailable">
              {query ? "no commits match that search." : "no commits yet."}
            </div>
          )}

          {/* pagination */}
          <div className="pagination">
            <span className="note-sm">
              one merkle root per {cycleSeconds ?? 600}-second cycle
              {commitsPerDay ? ` · ${commitsPerDay} a day` : ""}
            </span>
            <div className="pages">
              <button className="page-btn" onClick={() => setPage(0)} disabled={clampedPage === 0}>
                first
              </button>
              <button
                className="page-btn"
                onClick={() => setPage(Math.max(0, clampedPage - 1))}
                disabled={clampedPage === 0}
              >
                ‹
              </button>
              <span className="page-btn active">{clampedPage + 1}</span>
              <button
                className="page-btn"
                onClick={() => setPage(Math.min(totalPages - 1, clampedPage + 1))}
                disabled={clampedPage >= totalPages - 1}
              >
                ›
              </button>
              <button
                className="page-btn"
                onClick={() => setPage(totalPages - 1)}
                disabled={clampedPage >= totalPages - 1}
              >
                last
              </button>
            </div>
          </div>
        </main>
      </main>
      <SiteFooter />
    </>
  );
}

export default function ExplorerPage() {
  return (
    <Suspense fallback={<div className="loading" style={{ padding: 44 }}>loading</div>}>
      <ExplorerInner />
    </Suspense>
  );
}
