"use client";

// landing. the hero copy is fixed; every number is live. the cycle meta and
// commit block read the latest on-chain commit, the specimen card reads a real
// tracked token (confidence included, not a placeholder), the meta row counts
// the real tracked universe, and the ticker binds the whole feed. nothing here
// is hardcoded; when a value is missing the ui says so plainly.

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  fmtAge,
  fmtPrice,
  postJson,
  useAggregateAccuracy,
  usePolled,
  type AskResponse,
  type CommitRow,
  type FairValue,
} from "@/lib/api";
import { RegimePill } from "@/components/RegimePill";
import { Ticker } from "@/components/Ticker";

function AskAnswer({
  asking,
  answer,
  error,
}: {
  asking: boolean;
  answer: AskResponse | null;
  error: string | null;
}) {
  if (asking) return <div className="ask-answer thinking">morrow is checking its data…</div>;
  if (error)
    return (
      <div className="ask-answer fail">
        <div className="a-head">could not ask</div>
        <div className="a-body">{error}</div>
      </div>
    );
  if (!answer) return null;
  if (!answer.ok)
    return (
      <div className="ask-answer refuse">
        <div className="a-head">morrow cannot answer that from its data</div>
        <div className="a-body">{answer.answer}</div>
      </div>
    );
  const p = answer.provenance;
  return (
    <div className="ask-answer ok">
      <div className="a-head">
        {answer.panel?.replace("_", " ")} · {answer.symbol}
      </div>
      <div className="a-body">{answer.answer}</div>
      {p && (
        <div className="a-prov">
          {p.cycleId !== null && <>cycle #{p.cycleId.toLocaleString("en-US")}</>}
          {p.confidence !== null && <> · confidence {p.confidence}/100</>}
          {p.verifyPath && (
            <>
              {" · "}
              <Link href={p.verifyPath}>verify it on-chain ↗</Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function clampPct(x: number): number {
  return Math.max(3, Math.min(97, x));
}

function pickFeatured(rows: FairValue[]): FairValue | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const as = a.onchainSpot !== null ? 1 : 0;
    const bs = b.onchainSpot !== null ? 1 : 0;
    if (as !== bs) return bs - as;
    return b.confidence - a.confidence;
  })[0]!;
}

function BandChart({ row }: { row: FairValue }) {
  const spot = row.onchainSpot;
  const lo = Math.min(row.bandLow, row.fairValue, spot ?? row.bandLow);
  const hi = Math.max(row.bandHigh, row.fairValue, spot ?? row.bandHigh);
  const pad = (hi - lo) * 0.18 || 1;
  const axisLow = lo - pad;
  const axisHigh = hi + pad;
  const pos = (v: number): number => clampPct(((v - axisLow) / (axisHigh - axisLow)) * 100);

  const bandL = pos(row.bandLow);
  const bandR = pos(row.bandHigh);
  const fairX = pos(row.fairValue);

  return (
    <div className="band-chart">
      <span className="grid" style={{ top: "33%" }} />
      <span className="grid" style={{ top: "66%" }} />
      <span className="baseline" />
      <span className="band" style={{ left: `${bandL}%`, width: `${Math.max(bandR - bandL, 1)}%` }} />
      {spot !== null && (
        <>
          <span className="marker-pool" style={{ left: `${pos(spot)}%` }} />
          <span
            className="m-label"
            style={{ left: `${pos(spot)}%`, top: "calc(50% + 14px)", color: "var(--text-faint)" }}
          >
            pool
          </span>
        </>
      )}
      <span className="marker-fair" style={{ left: `${fairX}%` }} />
      <span
        className="m-label"
        style={{ left: `${fairX}%`, top: "calc(50% - 30px)", color: "var(--forest-italic)" }}
      >
        fair
      </span>
      <span className="axis" style={{ left: 30 }}>
        {fmtPrice(axisLow)}
      </span>
      <span className="axis" style={{ right: 30 }}>
        {fmtPrice(axisHigh)}
      </span>
    </div>
  );
}

type Tab = "fair" | "band" | "commit";

function SpecimenCard({
  featured,
  commit,
}: {
  featured: FairValue | null;
  commit: CommitRow | null;
}) {
  const [tab, setTab] = useState<Tab>("fair");

  if (!featured) {
    return (
      <div className="specimen">
        <div className="tabs">
          <span className="tab active">fair value</span>
          <span className="tab">band</span>
          <span className="tab">commit</span>
        </div>
        <div className="card-body">
          <div className="unavailable">
            no fair values published yet. is the indexer running.
          </div>
        </div>
      </div>
    );
  }

  const half = (featured.bandHigh - featured.bandLow) / 2;
  const spreadPct =
    featured.onchainSpot !== null && featured.fairValue !== 0
      ? (featured.onchainSpot / featured.fairValue - 1) * 100
      : null;
  const lastCommitAge = commit
    ? fmtAge(Date.now() - new Date(commit.committedAt ?? commit.createdAt).getTime())
    : fmtAge(Date.now() - new Date(featured.ts).getTime());

  return (
    <div className="specimen">
      <div className="tabs">
        <button className={`tab ${tab === "fair" ? "active" : ""}`} onClick={() => setTab("fair")}>
          fair value
        </button>
        <button className={`tab ${tab === "band" ? "active" : ""}`} onClick={() => setTab("band")}>
          band
        </button>
        <button
          className={`tab ${tab === "commit" ? "active" : ""}`}
          onClick={() => setTab("commit")}
        >
          commit
        </button>
      </div>

      <div className="card-body">
        <div className="card-head">
          <Link href={`/token/${featured.symbol.toLowerCase()}`} className="ticker-name">
            {featured.symbol.toUpperCase()}
          </Link>
          <div className="meta">
            {featured.name.toLowerCase()} · tokenized
            <br />
            robinhood chain · cycle #{featured.cycleId.toLocaleString("en-US")}
          </div>
        </div>

        {(tab === "fair" || tab === "band") && <BandChart row={featured} />}

        {tab === "fair" && (
          <div style={{ marginTop: 8 }}>
            <div className="krow">
              <span className="k">fair value</span>
              <span className="v big">{fmtPrice(featured.fairValue)}</span>
            </div>
            <div className="krow">
              <span className="k">confidence band</span>
              <span className="v">± {fmtPrice(half)}</span>
            </div>
            <div className="krow">
              <span className="k">confidence</span>
              <span className="v">{featured.confidence} / 100</span>
            </div>
            <div className="krow">
              <span className="k">spread vs pool</span>
              <span className="v">
                {spreadPct === null ? (
                  <span className="unavailable">no pool</span>
                ) : (
                  <span className={`chip ${Math.abs(spreadPct) < 0.005 ? "flat" : ""}`}>
                    {spreadPct >= 0 ? "▲ +" : "▼ "}
                    {spreadPct.toFixed(2)}%
                  </span>
                )}
              </span>
            </div>
            <div className="krow">
              <span className="k">last commit</span>
              <span className="v">{commit ? lastCommitAge : <span className="unavailable">none yet</span>}</span>
            </div>
          </div>
        )}

        {tab === "band" && (
          <div style={{ marginTop: 8 }}>
            <div className="krow">
              <span className="k">band low</span>
              <span className="v">{fmtPrice(featured.bandLow)}</span>
            </div>
            <div className="krow">
              <span className="k">fair value</span>
              <span className="v big">{fmtPrice(featured.fairValue)}</span>
            </div>
            <div className="krow">
              <span className="k">band high</span>
              <span className="v">{fmtPrice(featured.bandHigh)}</span>
            </div>
            <div className="krow">
              <span className="k">regime</span>
              <span className="v">{featured.regime.replace("_", " ")}</span>
            </div>
          </div>
        )}

        {tab === "commit" && (
          <div style={{ marginTop: 8 }}>
            <div className="krow">
              <span className="k">cycle</span>
              <span className="v">
                {commit ? `#${commit.cycleId.toLocaleString("en-US")}` : featured.cycleId.toLocaleString("en-US")}
              </span>
            </div>
            <div className="krow">
              <span className="k">merkle root</span>
              <span className="v" style={{ fontVariantNumeric: "tabular-nums" }}>
                {commit ? `${commit.merkleRoot.slice(0, 10)}…${commit.merkleRoot.slice(-6)}` : <span className="unavailable">not committed yet</span>}
              </span>
            </div>
            <div className="krow">
              <span className="k">leaves</span>
              <span className="v">{commit ? commit.observationCount : <span className="unavailable">-</span>}</span>
            </div>
            <div className="krow">
              <span className="k">status</span>
              <span className="v">{commit ? commit.status : <span className="unavailable">-</span>}</span>
            </div>
          </div>
        )}

        <div className="commit-block">
          <div>
            <div className="lbl">committed on-chain</div>
            <div className="cyc">
              {commit ? `cycle #${commit.cycleId.toLocaleString("en-US")}` : "no commit yet"}
            </div>
          </div>
          <div className="right">
            <div className="live">
              <span className={`dot ${commit?.txHash ? "bright" : ""}`} />
              {commit ? (
                <>root {commit.merkleRoot.slice(0, 6)}…{commit.merkleRoot.slice(-4)}</>
              ) : (
                "awaiting first commit"
              )}
            </div>
            <div style={{ color: "var(--text-faint)" }}>
              <Link href={`/commits${commit ? `?cycle=${commit.cycleId}` : ""}`} style={{ color: "var(--text-faint)" }}>
                recompute it yourself ↗
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const { data: rows, error } = usePolled<FairValue[]>("/v1/prices", 30_000);
  const { data: commits } = usePolled<CommitRow[]>("/v1/commits?limit=1", 60_000);
  const latestCommit = commits && commits.length > 0 ? commits[0]! : null;

  const symbols = useMemo(() => (rows ?? []).map((r) => r.symbol.toLowerCase()), [rows]);
  const agg = useAggregateAccuracy(symbols);

  const featured = useMemo(() => pickFeatured(rows ?? []), [rows]);
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [askErr, setAskErr] = useState<string | null>(null);

  const cycleMeta = latestCommit
    ? `cycle #${latestCommit.cycleId.toLocaleString("en-US")} · ${new Date(latestCommit.committedAt ?? latestCommit.createdAt).toISOString().slice(11, 16)} utc`
    : featured
      ? `cycle #${featured.cycleId.toLocaleString("en-US")} · ${new Date(featured.ts).toISOString().slice(11, 16)} utc`
      : "cycle unavailable";

  const submitAsk = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const q = ask.trim();
    if (!q) return;
    setAsking(true);
    setAskErr(null);
    setAnswer(null);
    try {
      const res = await postJson<AskResponse>("/v1/ask", { question: q });
      setAnswer(res);
    } catch (err) {
      setAskErr(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  };

  const placeholderSymbol = featured?.symbol.toLowerCase() ?? "tsla";

  return (
    <>
      <header className="site-header" style={{ justifyContent: "space-between" }}>
        <Link href="/" className="wordmark">
          morrow
        </Link>
        <div className="eyebrow" style={{ margin: 0 }}>
          [ off-hours price oracle · robinhood chain ]
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <RegimePill showCountdown />
          <Link href="/feed" className="btn">
            open feed →
          </Link>
        </div>
      </header>

      <main className="hero">
        <div>
          <div className="cycle-meta">
            <span className="dot" />
            {cycleMeta}
          </div>

          <h1 className="h-hero">
            what a stock is worth
            <br />
            when the market is <span className="it">closed.</span>
          </h1>

          <p className="lead">
            morrow reads the last print, publishes a fair value every 600 seconds, and commits every
            observation on-chain. you verify it against the blockchain. you do not trust morrow.
          </p>

          <form className="ask" onSubmit={(e) => void submitAsk(e)}>
            <span className="ask-label">ask</span>
            <div className="ask-field">
              <span className="prompt">›</span>
              <input
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
                placeholder={`what is ${placeholderSymbol} worth right now`}
                aria-label="ask a token"
              />
              <button type="submit" disabled={asking}>
                {asking ? "asking" : "ask →"}
              </button>
            </div>
          </form>

          <AskAnswer asking={asking} answer={answer} error={askErr} />

          <div className="meta-row">
            {rows ? (
              <>
                <span>
                  {rows.length} {rows.length === 1 ? "token" : "tokens"}
                </span>
                <span className="sep">·</span>
                <span>{rows.map((r) => r.symbol.toLowerCase()).join(" · ") || "none live"}</span>
                <span className="sep">·</span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="dot" />
                  on-chain commits
                </span>
              </>
            ) : error ? (
              <span className="unavailable">feed unavailable: {error}</span>
            ) : (
              <span className="loading">loading feed…</span>
            )}
          </div>

          <div className="note">
            note · a fair value every 600s through every closed hour, each observation committed
            on-chain and independently checkable. do not trust this feed. check it.
          </div>
        </div>

        <SpecimenCard featured={featured} commit={latestCommit} />
      </main>

      <Ticker
        rows={rows ?? []}
        commit={latestCommit}
        medianErrPct={agg.medianAbsErrorPct}
        anySamples={agg.anySamples}
      />
    </>
  );
}
