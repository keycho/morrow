"use client";

// perps. 24/7 perpetual futures on tokenized stocks, marked off-hours against
// morrow's fair value. the mark is the verifiable off-hours number, funding
// tracks the pool basis, and the leverage cap tightens as morrow's confidence
// falls. markets are driven by the live feed (/v1/prices) so the page stays
// consistent with the rest of the site.

import { useMemo, useState } from "react";
import Link from "next/link";
import { fmtPrice, usePolled, type FairValue } from "@/lib/api";
import { derivePerp, fmtUsdCompact, liquidationPrice, type PerpMarket } from "@/lib/perps";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

const LEVELS = [2, 3, 5, 8, 10];

function fundingCls(pct: number): string {
  return pct > 0.0005 ? "neg" : pct < -0.0005 ? "pos" : "flat";
}

function Skew({ longPct }: { longPct: number }) {
  return (
    <span className="skew">
      <span className="bar">
        <span className="long" style={{ width: `${longPct}%` }} />
        <span className="short" style={{ width: `${100 - longPct}%` }} />
      </span>
      <span className="nums">
        {longPct}% / {100 - longPct}%
      </span>
    </span>
  );
}

function Ticket({ m }: { m: PerpMarket }) {
  const [side, setSide] = useState<"long" | "short">("long");
  const levels = LEVELS.filter((l) => l <= m.maxLeverage);
  const [lev, setLev] = useState<number>(levels[levels.length - 1] ?? 2);
  const [size, setSize] = useState("1000");

  const leverage = Math.min(lev, m.maxLeverage);
  const liq = liquidationPrice(m.mark, leverage, side);
  const notional = (Number(size) || 0) * leverage;

  return (
    <div className="ticket">
      <div className="side-toggle">
        <button className={side === "long" ? "on long" : ""} onClick={() => setSide("long")}>
          long
        </button>
        <button className={side === "short" ? "on short" : ""} onClick={() => setSide("short")}>
          short
        </button>
      </div>

      <label className="field">
        <span className="lbl">size (usd)</span>
        <input
          className="input"
          value={size}
          inputMode="numeric"
          onChange={(e) => setSize(e.target.value.replace(/[^0-9.]/g, ""))}
        />
      </label>

      <div className="field">
        <span className="lbl">leverage · max {m.maxLeverage}x off-hours</span>
        <div className="lev-btns">
          {levels.map((l) => (
            <button key={l} className={`lev ${l === leverage ? "on" : ""}`} onClick={() => setLev(l)}>
              {l}x
            </button>
          ))}
        </div>
      </div>

      <div className="kv" style={{ marginTop: 4 }}>
        <span className="k">entry (mark)</span>
        <span className="v">{fmtPrice(m.mark)}</span>
        <span className="k">notional</span>
        <span className="v">{fmtUsdCompact(notional)}</span>
        <span className="k">est. liquidation</span>
        <span className={`v ${side === "long" ? "neg" : "pos"}`}>{fmtPrice(liq)}</span>
        <span className="k">funding (1h)</span>
        <span className={`v ${fundingCls(m.fundingHourlyPct)}`}>
          {m.fundingHourlyPct >= 0 ? "+" : ""}
          {m.fundingHourlyPct.toFixed(4)}%
        </span>
        <span className="k">morrow confidence</span>
        <span className="v">{m.confidence} / 100</span>
      </div>

      <button className="btn place" disabled>
        connect wallet
      </button>

      <Link className="verify-mark" href={`/commits?cycle=${m.cycleId}`}>
        mark committed on-chain · verify cycle #{m.cycleId.toLocaleString("en-US")} ↗
      </Link>
    </div>
  );
}

export default function PerpsPage() {
  const { data, error, loading } = usePolled<FairValue[]>("/v1/prices", 30_000);
  const markets = useMemo(() => (data ?? []).map(derivePerp), [data]);
  const [selected, setSelected] = useState<string | null>(null);

  const active = markets.find((m) => m.symbol === selected) ?? markets[0] ?? null;

  return (
    <>
      <SiteHeader />
      <main className="page">
        <section className="wrap">
          <div className="eyebrow">[ 24/7 perps · marked off-hours by morrow ]</div>
          <h1 className="head">perps.</h1>
          <p className="lead">
            perpetual futures on tokenized stocks, trading around the clock. off-hours, when the
            underlying market is closed, every mark is morrow&apos;s verifiable fair value. funding
            tracks the pool basis, and the leverage cap tightens as morrow&apos;s confidence falls.
          </p>

          {error && <div className="error-line">markets unavailable: {error}</div>}
          {loading && !data && <div className="loading">loading markets…</div>}

          {markets.length > 0 && (
            <>
              <div className="frame" style={{ margin: "20px 0 0" }}>
                <div className="frame-head">
                  <span className="title">markets</span>
                  <span className="count">{markets.length} · marked off-hours by morrow</span>
                </div>
                <div className="tablewrap">
                  <table className="data perps">
                    <thead>
                      <tr>
                        <th>market</th>
                        <th className="num">mark</th>
                        <th className="num">basis</th>
                        <th className="num">funding / 1h</th>
                        <th className="num">open interest</th>
                        <th>long / short</th>
                        <th className="num">max lev</th>
                      </tr>
                    </thead>
                    <tbody>
                      {markets.map((m) => (
                        <tr
                          key={m.symbol}
                          className={m.symbol === active?.symbol ? "sel" : ""}
                          onClick={() => setSelected(m.symbol)}
                        >
                          <td>
                            <span className="symbol-link">{m.symbol}</span>
                            <span className="mkt-perp"> -perp</span>
                          </td>
                          <td className="num pos">{fmtPrice(m.mark)}</td>
                          <td className="num">
                            {m.basisPct === null ? (
                              <span className="unavailable">-</span>
                            ) : (
                              <span className={m.basisPct > 0 ? "pos" : m.basisPct < 0 ? "neg" : "flat"}>
                                {m.basisPct >= 0 ? "+" : ""}
                                {m.basisPct.toFixed(2)}%
                              </span>
                            )}
                          </td>
                          <td className={`num ${fundingCls(m.fundingHourlyPct)}`}>
                            {m.fundingHourlyPct >= 0 ? "+" : ""}
                            {m.fundingHourlyPct.toFixed(4)}%
                          </td>
                          <td className="num dim">{fmtUsdCompact(m.openInterestUsd)}</td>
                          <td>
                            <Skew longPct={m.longPct} />
                          </td>
                          <td className="num">{m.maxLeverage}x</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {active && (
                <div className="grid cols-2" style={{ marginTop: 24 }}>
                  <div>
                    <h2 className="sub" style={{ fontSize: 24 }}>
                      {active.symbol}-perp
                    </h2>
                    <Ticket m={active} />
                  </div>
                  <div>
                    <h2 className="sub" style={{ fontSize: 24 }}>
                      off-hours risk
                    </h2>
                    <div className="panel">
                      <div className="kv">
                        <span className="k">mark source</span>
                        <span className="v">morrow off-hours fair value</span>
                        <span className="k">funding</span>
                        <span className="v">tracks the pool basis, paid hourly</span>
                        <span className="k">leverage cap</span>
                        <span className="v">
                          gated on confidence: 45+ to 10x, 40+ to 8x, 35+ to 5x, 25+ to 3x, else 2x
                        </span>
                        <span className="k">liquidations</span>
                        <span className="v">
                          pause on a suspect cycle, when an onchain move outruns the proxies
                        </span>
                      </div>
                      <p className="dim" style={{ marginTop: 12, fontSize: 12 }}>
                        the mark is committed on-chain every 600s and recomputable in your browser
                        against the contract. see the <Link href="/commits">explorer</Link> and the{" "}
                        <Link href="/docs">methodology</Link>.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
