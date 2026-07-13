"use client";

// status page fed by /health: overall state, service heartbeats, cycle age,
// per-source staleness.

import { fmtAge, usePolled, type HealthPayload } from "@/lib/api";

export default function StatusPage() {
  const { data, error, loading } = usePolled<HealthPayload>("/health", 15_000);

  return (
    <div>
      <h1>system status</h1>

      {error && <div className="error-line">api unreachable: {error}</div>}
      {loading && !data && <div className="dim loading">loading status</div>}

      {data && (
        <div>
          <div className="panel">
            <span className={`badge ${data.status}`} style={{ fontSize: 13 }}>
              {data.status}
            </span>
            {data.mockMode && (
              <span className="badge holiday" style={{ marginLeft: 8 }}>
                mock mode
              </span>
            )}
          </div>

          <h2>subsystems</h2>
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

          <div className="grid cols-2">
            <div className="panel">
              <h2 style={{ marginTop: 0 }}>services</h2>
              <div className="kv">
                <span className="k">indexer heartbeat</span>
                <span className={`v ${data.indexer && data.indexer.ok ? "green" : "red"}`}>
                  {data.indexer ? `${fmtAge(data.indexer.ageMs)} (${data.indexer.ok ? "ok" : "erroring"})` : "never"}
                </span>
                <span className="k">publisher heartbeat</span>
                <span className={`v ${data.publisher && data.publisher.ok ? "green" : "amber"}`}>
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

            <div className="panel">
              <h2 style={{ marginTop: 0 }}>proxy sources</h2>
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
                        <span className={`badge ${s.stale ? "failed" : "confirmed"}`}>
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
      )}
    </div>
  );
}
