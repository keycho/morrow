"use client";

// the explorer's verify control. it proves a published price without trusting
// morrow's server:
//   1. fetch the claim (leaf fields + merkle proof) from the api,
//   2. rebuild the canonical leaf string from the structured fields and hash it
//      in the browser,
//   3. fold the proof in the browser to a root,
//   4. read the committed root for that cycle straight from the deployed
//      contract over rpc, and compare.
// the pass/fail decision is made against the chain root, never the api's. the
// contract's own verify() view is called too as an independent second check.

import { useState } from "react";
import type { Hex } from "viem";
import { getJson, shortHex, type ProofPayload } from "@/lib/api";
import { addressLink, txLink, CHAIN_ID, COMMITS_ADDRESS } from "@/lib/constants";
import {
  canonicalLeafString,
  foldProof,
  hashLeafString,
  readOnchainCommit,
  readOnchainVerify,
  resolveCommitsAddress,
} from "@/lib/chain";

type Outcome = "ok" | "fail";

interface VerifyState {
  outcome: Outcome;
  reason: string;
  symbol: string;
  cycleId: number;
  canonical: string;
  leafBrowser: Hex;
  rootBrowser: Hex;
  rootOnchain: string | null;
  onchainExists: boolean;
  contractVerify: boolean | null;
  contract: string;
  txHash: string | null;
  apiRootAgrees: boolean | null;
}

function Kv({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <span className="k">{k}</span>
      <span className="v" style={mono ? { fontVariantNumeric: "tabular-nums" } : undefined}>
        {v}
      </span>
    </>
  );
}

export function VerifyPanel({
  symbols,
  initialSymbol,
  initialCycleId,
}: {
  symbols: string[];
  initialSymbol?: string;
  initialCycleId?: number;
}) {
  const fallbackSymbol = initialSymbol ?? symbols[0] ?? "";
  const [symbol, setSymbol] = useState(fallbackSymbol);
  const [cycleId, setCycleId] = useState(initialCycleId ? String(initialCycleId) : "");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyState | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    const sym = symbol.toLowerCase().trim();
    const cyc = Number(cycleId.trim());
    try {
      if (!sym) throw new Error("choose a token to verify a leaf for");
      if (!Number.isInteger(cyc) || cyc <= 0) throw new Error("enter a valid cycle id");

      // 1. the claim, from the api. everything here is checked, never trusted.
      setStep("fetching claim from api");
      const payload = await getJson<ProofPayload>(
        `/v1/proof/${encodeURIComponent(sym)}/${cyc}`
      );

      // 2. recompute the leaf in the browser from the structured fields.
      const canonical = canonicalLeafString({
        tokenId: payload.leaf.tokenId,
        cycleId: payload.leaf.cycleId,
        fairValue: payload.leaf.fairValue,
        confidence: payload.leaf.confidence,
        timestamp: payload.leaf.timestamp,
      });
      const leafBrowser = hashLeafString(canonical);

      // 3. fold the proof in the browser to a root.
      const rootBrowser = foldProof(leafBrowser, payload.proof as Hex[]);

      // 4. the decisive check: the committed root straight from the contract.
      const address = resolveCommitsAddress(payload.contract);
      if (!address) {
        setResult({
          outcome: "fail",
          reason:
            "no contract address configured. set NEXT_PUBLIC_COMMITS_ADDRESS to verify against chain.",
          symbol: sym,
          cycleId: cyc,
          canonical,
          leafBrowser,
          rootBrowser,
          rootOnchain: null,
          onchainExists: false,
          contractVerify: null,
          contract: payload.contract || "unavailable",
          txHash: payload.txHash,
          apiRootAgrees: null,
        });
        return;
      }

      setStep("reading committed root from contract via rpc");
      const onchain = await readOnchainCommit(address, cyc);

      let contractVerify: boolean | null = null;
      if (onchain.exists) {
        try {
          contractVerify = await readOnchainVerify(
            address,
            leafBrowser,
            payload.proof as Hex[],
            cyc
          );
        } catch {
          contractVerify = null; // view reverted; getCommit stays authoritative
        }
      }

      const rootMatches =
        onchain.exists && rootBrowser.toLowerCase() === onchain.merkleRoot.toLowerCase();
      const apiRootAgrees =
        payload.merkleRoot != null
          ? payload.merkleRoot.toLowerCase() === onchain.merkleRoot.toLowerCase()
          : null;

      let outcome: Outcome;
      let reason: string;
      if (!onchain.exists) {
        outcome = "fail";
        reason = "this cycle has no committed root on chain. nothing to verify against.";
      } else if (rootMatches) {
        outcome = "ok";
        reason = "this exact price was committed on chain for this cycle.";
      } else {
        outcome = "fail";
        reason =
          "the root recomputed from this observation does not match the committed root on chain.";
      }

      setResult({
        outcome,
        reason,
        symbol: sym,
        cycleId: cyc,
        canonical,
        leafBrowser,
        rootBrowser,
        rootOnchain: onchain.merkleRoot,
        onchainExists: onchain.exists,
        contractVerify,
        contract: address,
        txHash: payload.txHash,
        apiRootAgrees,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  const contractHref = result ? addressLink(result.contract) : null;
  const txHref = result?.txHash ? txLink(result.txHash) : null;

  return (
    <div className="verify">
      <div className="eyebrow" style={{ marginBottom: 14 }}>
        [ verify a leaf · recompute in your browser · check the root on chain ]
      </div>
      <div className="row">
        <span className="dim">token</span>
        {symbols.length > 0 ? (
          <select
            className="input"
            style={{ padding: "10px 12px", fontSize: 13 }}
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            aria-label="token"
          >
            {symbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            style={{ padding: "10px 12px", fontSize: 13 }}
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="symbol"
            size={8}
            aria-label="token"
          />
        )}
        <span className="dim">cycle</span>
        <input
          className="input"
          style={{ padding: "10px 12px", fontSize: 13 }}
          value={cycleId}
          onChange={(e) => setCycleId(e.target.value)}
          placeholder="cycle id"
          inputMode="numeric"
          size={14}
          aria-label="cycle id"
        />
        <button className="btn" onClick={() => void run()} disabled={busy || !cycleId.trim()}>
          {busy ? "verifying" : "verify"}
        </button>
        {busy && step && <span className="faint">{step}…</span>}
      </div>

      {error && <div className="error-line">could not verify: {error}</div>}

      {result && (
        <div className={`result-panel ${result.outcome}`}>
          <div className="result-head">
            {result.outcome === "ok" ? "verified on chain" : "not verified"}
          </div>
          <div className="result-body">
            <div className="kv">
              <Kv k="canonical leaf" v={result.canonical} mono />
              <Kv k="leaf hash (browser)" v={shortHex(result.leafBrowser, 14)} mono />
              <Kv k="root recomputed (browser)" v={shortHex(result.rootBrowser, 14)} mono />
              <Kv
                k="root committed (chain rpc)"
                v={
                  result.rootOnchain && result.onchainExists ? (
                    shortHex(result.rootOnchain, 14)
                  ) : (
                    <span className="unavailable">not committed on chain</span>
                  )
                }
                mono
              />
              <Kv
                k="contract verify()"
                v={
                  result.contractVerify === null ? (
                    <span className="unavailable">not evaluated</span>
                  ) : result.contractVerify ? (
                    "true"
                  ) : (
                    "false"
                  )
                }
              />
              <Kv
                k="contract"
                v={
                  contractHref ? (
                    <a href={contractHref} target="_blank" rel="noreferrer">
                      {shortHex(result.contract, 8)}
                    </a>
                  ) : (
                    shortHex(result.contract, 8)
                  )
                }
                mono
              />
              <Kv k="chain id" v={CHAIN_ID} />
              <Kv
                k="commit tx"
                v={
                  result.txHash ? (
                    txHref ? (
                      <a href={txHref} target="_blank" rel="noreferrer">
                        {shortHex(result.txHash, 10)}
                      </a>
                    ) : (
                      shortHex(result.txHash, 10)
                    )
                  ) : (
                    <span className="unavailable">not on chain yet</span>
                  )
                }
                mono
              />
              {result.apiRootAgrees === false && (
                <Kv
                  k="api-reported root"
                  v={<span className="unavailable">disagrees with chain, chain wins</span>}
                />
              )}
            </div>
            <div className="result-close">
              {result.outcome === "ok" ? ">>---> " : "// "}
              {result.reason}
            </div>
            <div className="faint" style={{ marginTop: 8, fontSize: 11 }}>
              the root check hits the contract at {shortHex(result.contract, 6)} over rpc
              {COMMITS_ADDRESS ? " (deployment address)" : " (address from the proof payload)"}. the
              api is not in this decision.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
