"use client";

// client-side proof verification. fetches the proof payload from the api,
// recomputes the leaf hash and merkle root in the browser with keccak256,
// and compares against the committed root. the math mirrors
// FletchCommits.verify: sorted-pair keccak256 fold.

import { useState } from "react";
import { concat, keccak256, stringToHex, type Hex } from "viem";
import { getJson, shortHex, type ProofPayload } from "@/lib/api";
import { addressLink, txLink } from "@/lib/constants";

interface VerifyResult {
  payload: ProofPayload;
  recomputedLeaf: string;
  leafMatches: boolean;
  recomputedRoot: string;
  rootMatches: boolean;
}

function foldProof(leaf: Hex, proof: Hex[]): Hex {
  let node = leaf;
  for (const sibling of proof) {
    const [lo, hi] = node.toLowerCase() <= sibling.toLowerCase() ? [node, sibling] : [sibling, node];
    node = keccak256(concat([lo, hi]));
  }
  return node;
}

export function VerifyWidget({ initialCycleId }: { initialCycleId?: number }) {
  const [symbol, setSymbol] = useState("tsla");
  const [cycleId, setCycleId] = useState(initialCycleId ? String(initialCycleId) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const payload = await getJson<ProofPayload>(
        `/v1/proof/${encodeURIComponent(symbol.toLowerCase().trim())}/${cycleId.trim()}`
      );
      const recomputedLeaf = keccak256(stringToHex(payload.leaf.canonicalString));
      const leafMatches = recomputedLeaf.toLowerCase() === payload.leaf.hash.toLowerCase();
      const recomputedRoot = foldProof(recomputedLeaf, payload.proof as Hex[]);
      const rootMatches = recomputedRoot.toLowerCase() === payload.merkleRoot.toLowerCase();
      setResult({ payload, recomputedLeaf, leafMatches, recomputedRoot, rootMatches });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="dim">verify this observation:</span>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder="symbol"
          size={8}
          aria-label="symbol"
        />
        <input
          value={cycleId}
          onChange={(e) => setCycleId(e.target.value)}
          placeholder="cycle id"
          size={14}
          aria-label="cycle id"
        />
        <button onClick={() => void run()} disabled={busy || !cycleId.trim()}>
          {busy ? "verifying" : "verify ->"}
        </button>
      </div>

      {error && <div className="error-line">{error}</div>}

      {result && (
        <div style={{ marginTop: 12 }}>
          <div className="kv">
            <span className="k">canonical string</span>
            <span className="v">{result.payload.leaf.canonicalString}</span>
            <span className="k">leaf recomputed in browser</span>
            <span className="v">{shortHex(result.recomputedLeaf, 12)}</span>
            <span className="k">leaf matches api</span>
            <span className={`v ${result.leafMatches ? "green" : "red"}`}>
              {result.leafMatches ? "yes" : "no"}
            </span>
            <span className="k">root recomputed from proof</span>
            <span className="v">{shortHex(result.recomputedRoot, 12)}</span>
            <span className="k">committed root</span>
            <span className="v">{shortHex(result.payload.merkleRoot, 12)}</span>
            <span className="k">root matches</span>
            <span className={`v ${result.rootMatches ? "green" : "red"}`}>
              {result.rootMatches ? "yes" : "no"}
            </span>
            <span className="k">commit tx</span>
            <span className="v">
              {result.payload.txHash ? (
                txLink(result.payload.txHash) ? (
                  <a href={txLink(result.payload.txHash) as string} target="_blank" rel="noreferrer">
                    {shortHex(result.payload.txHash, 10)}
                  </a>
                ) : (
                  shortHex(result.payload.txHash, 10)
                )
              ) : (
                <span className="faint">not on-chain yet</span>
              )}
            </span>
            <span className="k">contract</span>
            <span className="v">
              {addressLink(result.payload.contract) ? (
                <a href={addressLink(result.payload.contract) as string} target="_blank" rel="noreferrer">
                  {shortHex(result.payload.contract, 8)}
                </a>
              ) : (
                shortHex(result.payload.contract, 8)
              )}
            </span>
          </div>
          <div style={{ marginTop: 10 }}>
            {result.leafMatches && result.rootMatches ? (
              <span className="green">
                {">>--->"} verified. this exact price was committed for this cycle.
              </span>
            ) : (
              <span className="red">verification failed. do not trust this observation.</span>
            )}
          </div>
          <div className="faint" style={{ marginTop: 6 }}>
            final step for full independence: call verify(leafHash, proof, cycleId) on the
            contract or compare getCommit(cycleId) via your own rpc. the mcp tool
            verify_observation does both.
          </div>
        </div>
      )}
    </div>
  );
}
