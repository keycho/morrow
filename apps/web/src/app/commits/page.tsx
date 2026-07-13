"use client";

// commits page: cycle history with roots and tx links, plus the client-side
// proof verification widget.

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { fmtAge, shortHex, usePolled, type CommitRow } from "@/lib/api";
import { txLink } from "@/lib/constants";
import { VerifyWidget } from "@/components/VerifyWidget";

function CommitsInner() {
  const searchParams = useSearchParams();
  const preselected = searchParams.get("cycle");
  const { data, error, loading } = usePolled<CommitRow[]>("/v1/commits?limit=100", 60_000);

  return (
    <div>
      <h1>on-chain commits</h1>
      <p className="dim">
        every cycle, all fair value observations are hashed into canonical leaves
        (tokenId|cycleId|fairValue|confidence|timestamp), built into a sorted-pair keccak256
        merkle tree, and the root is committed to FletchCommits on robinhood chain. any
        observation can be verified below without trusting this dashboard.
      </p>

      <VerifyWidget initialCycleId={preselected ? Number(preselected) : undefined} />

      {error && <div className="error-line">{error}</div>}
      {loading && !data && <div className="dim loading">loading commits</div>}

      {data && (
        <table className="data">
          <thead>
            <tr>
              <th>cycle</th>
              <th>merkle root</th>
              <th className="num">leaves</th>
              <th>status</th>
              <th>tx</th>
              <th className="num">committed</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.cycleId}>
                <td>{c.cycleId}</td>
                <td className="dim">{shortHex(c.merkleRoot, 12)}</td>
                <td className="num">{c.observationCount}</td>
                <td>
                  <span className={`badge ${c.status}`}>{c.status}</span>
                </td>
                <td>
                  {c.txHash ? (
                    txLink(c.txHash) ? (
                      <a href={txLink(c.txHash) as string} target="_blank" rel="noreferrer">
                        {shortHex(c.txHash, 8)}
                      </a>
                    ) : (
                      shortHex(c.txHash, 8)
                    )
                  ) : (
                    <span className="faint">-</span>
                  )}
                </td>
                <td className="num dim">
                  {fmtAge(Date.now() - new Date(c.committedAt ?? c.createdAt).getTime())}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && data.length === 0 && <div className="dim">no commits yet.</div>}
    </div>
  );
}

export default function CommitsPage() {
  return (
    <Suspense fallback={<div className="dim loading">loading</div>}>
      <CommitsInner />
    </Suspense>
  );
}
