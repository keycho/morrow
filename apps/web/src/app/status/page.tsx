"use client";

// status, fed by /health: overall state, service heartbeats, cycle age, and
// per-source staleness. every value live.

import { fmtAge, usePolled, type HealthPayload } from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

export default function StatusPage() {
  const { data, error, loading } = usePolled<HealthPayload>("/health", 15_000);

  return (
    <>
      <SiteHeader />
      <main className="page">
        <section className="wrap">
          <div className="eyebrow">[ system health · live from /health ]</div>
          <h1 className="head">status.</h1>

          {error && <div className="error-line">api unreachable: {error}</div>}
          {loading && !data && <div className="loading">loading status…</div>}

          {data && (
            <>
              <div className="panel raised" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className={`badge ${data.status}`} style={{ fontSize: 12 }}>
                  {data.status}
                </span>
                {data.mockMode && (
                  <span className="badge holiday" style={{ fontSize: 12 }}>
                    mock mode
                  </span>
                )}
                <span className="dim" style={{ marginLeft: "auto" }}>
                  last cycle {fmtAge(data.lastCycle.ageMs)} · cycle length {data.cycleSeconds}s
                </span>
              </div>

              <h2 className="sub" style={{ fontSize: 24, marginTop: 24 }}>
                subsystems
              </h2>
              <div className="tablewrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>subsystem</th>
                      <th>state</th>
                      <th>detail</th>
                      <th className="num">last success</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.subsystems ?? []).map((s) => (
                      <tr key={s.name}>
                        <td>{s.name}</td>
                        <td>
                          <span className={`badge ${s.status}`}>{s.status}</span>
                        </td>
                        <td className="dim">{s.description}</td>
                        <td className="num dim">{fmtAge(s.ageMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid cols-2" style={{ marginTop: 24 }}>
                <div>
                  <h2 className="sub" style={{ fontSize: 24 }}>
                    services
                  </h2>
                  <div className="panel">
                    <div className="kv">
                      <span className="k">indexer heartbeat</span>
                      <span className={`v ${data.indexer && data.indexer.ok ? "pos" : "down"}`}>
                        {data.indexer
                          ? `${fmtAge(data.indexer.ageMs)} (${data.indexer.ok ? "ok" : "erroring"})`
                          : "never"}
                      </span>
                      <span className="k">publisher heartbeat</span>
                      <span className={`v ${data.publisher && data.publisher.ok ? "pos" : "flat"}`}>
                        {data.publisher
                          ? `${fmtAge(Date.now() - new Date(data.publisher.lastHeartbeat).getTime())} (${data.publisher.ok ? "ok" : "erroring"})`
                          : "never"}
                      </span>
                      <span className="k">last cycle</span>
                      <span className="v">{fmtAge(data.lastCycle.ageMs)}</span>
                      <span className="k">cycle length</span>
                      <span className="v">{data.cycleSeconds}s</span>
                    </div>
                  </div>
                </div>

                <div>
                  <h2 className="sub" style={{ fontSize: 24 }}>
                    proxy sources
                  </h2>
                  <div className="tablewrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>source</th>
                          <th>symbol</th>
                          <th className="num">last tick</th>
                          <th>state</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.sources.map((s) => (
                          <tr key={s.name}>
                            <td className="dim">{s.name}</td>
                            <td>{s.symbol}</td>
                            <td className="num dim">{fmtAge(s.ageMs)}</td>
                            <td>
                              <span className={`badge ${s.stale ? "stale" : "fresh"}`}>
                                {s.stale ? "stale" : "fresh"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
