// typed fetch helpers over the fletch api, plus a small polling hook.

"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL } from "./constants";

export interface FairValue {
  tokenId: number;
  symbol: string;
  name: string;
  cycleId: number;
  ts: string;
  fairValue: number;
  confidence: number;
  bandLow: number;
  bandHigh: number;
  regime: string;
  suspect: boolean;
  corporateAction: boolean;
  anchorStale: boolean;
  anchorPrice: number | null;
  drift: number | null;
  onchainTwap: number | null;
  onchainSpot: number | null;
  depthQuote: number | null;
}

export interface SpreadRow {
  tokenId: number;
  symbol: string;
  name: string;
  fairValue: number;
  onchainSpot: number | null;
  spreadPct: number | null;
  confidence: number;
  regime: string;
  suspect: boolean;
  corporateAction: boolean;
  anchorStale: boolean;
  stale: boolean;
  cycleId: number;
  ts: string;
}

export interface SpreadsPayload {
  rows: SpreadRow[];
  thresholds: { warnPct: number; bigPct: number };
}

export interface CommitRow {
  cycleId: number;
  merkleRoot: string;
  observationCount: number;
  txHash: string | null;
  status: string;
  committedAt: string | null;
  createdAt: string;
}

export interface ProofPayload {
  symbol: string;
  leaf: {
    tokenId: number;
    cycleId: number;
    fairValue: string;
    confidence: number;
    timestamp: number;
    canonicalString: string;
    hash: string;
  };
  proof: string[];
  merkleRoot: string;
  txHash: string | null;
  contract: string;
  chainId: number;
  verification: string;
}

export interface AccuracyPayload {
  symbol: string;
  samples: {
    marketTs: string;
    openPrice: number;
    predictedFairValue: number;
    predictedAt: string;
    confidence: number;
    errorPct: number;
  }[];
  stats: {
    n: number;
    meanAbsErrorPct: number;
    medianAbsErrorPct: number;
    p90AbsErrorPct: number;
    meanErrorPct: number;
    worstAbsErrorPct: number;
  } | null;
  note?: string;
}

export interface Subsystem {
  name: string;
  status: "ok" | "degraded" | "down";
  lastSuccess: string | null;
  ageMs: number | null;
  description: string;
}

export interface ReceiptSummaryToken {
  symbol: string;
  samples: number;
  meanAbsErrorPct: number | null;
  bestCall: { date: string; predicted: number; actual: number; errorPct: number } | null;
}

export interface ReceiptListItem {
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  hasPng: boolean;
  summary: {
    cyclesCommitted?: number;
    latestCommitTx?: string | null;
    tokens?: ReceiptSummaryToken[];
  };
}

export interface HealthPayload {
  status: "ok" | "degraded" | "down";
  mockMode: boolean;
  subsystems: Subsystem[];
  indexer: { lastHeartbeat: string; ageMs: number | null; ok: boolean } | null;
  publisher: {
    lastHeartbeat: string;
    ok: boolean;
    detail: Record<string, unknown>;
  } | null;
  lastCycle: { newestFairValueTs: string | null; ageMs: number | null };
  cycleSeconds: number;
  sources: {
    name: string;
    symbol: string;
    lastTickTs: string | null;
    ageMs: number | null;
    stale: boolean;
  }[];
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`api ${res.status}: ${body.slice(0, 200)}`);
  }
  const parsed = (await res.json()) as { data: T };
  return parsed.data;
}

export interface Polled<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

export function usePolled<T>(path: string | null, intervalMs = 30_000): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, loading: true });
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const data = await getJson<T>(path);
        if (!cancelled) setState({ data, error: null, loading: false });
      } catch (err) {
        if (!cancelled) {
          setState((prev) => ({
            data: prev.data,
            error: err instanceof Error ? err.message : String(err),
            loading: false,
          }));
        }
      }
    };
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, intervalMs]);

  return state;
}

export function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function fmtAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "never";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function shortHex(hex: string, chars = 8): string {
  if (hex.length <= 2 + chars * 2) return hex;
  return `${hex.slice(0, 2 + chars)}..${hex.slice(-chars)}`;
}
