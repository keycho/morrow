// demo mock data. scaffolding for a screenshot / demo deploy: when DEMO is on
// (see constants.ts) the data layer serves these payloads instead of calling
// the api, so every page shows a full, live-looking feed with no api, database,
// or chain behind it. this is not production code; it is gated behind the flag.
//
// numbers are illustrative. the backtest block carries the real measured
// results so the evidence section stays honest even in the demo.

import { keccak256, stringToHex } from "viem";
import type {
  AccuracyPayload,
  AskResponse,
  BacktestMetrics,
  BacktestPayload,
  BacktestScope,
  CommitRow,
  FairValue,
  HealthPayload,
  ProofPayload,
  ReceiptListItem,
  SpreadsPayload,
} from "./api";

const BASE_CYCLE = 2_973_456;
const CYCLE_SECONDS = 600;
const CONTRACT = "0x8b5f3c2a1d9e4b7f6a0c8d2e1f3a4b5c6d7e8f90";
const CHAIN_ID = 4663;

interface Seed {
  tokenId: number;
  symbol: string;
  name: string;
  fair: number;
  confidence: number;
  spot: number | null;
  drift: number;
}

const SEEDS: Seed[] = [
  { tokenId: 1, symbol: "tsla", name: "tesla", fair: 412.87, confidence: 41, spot: 414.1, drift: -0.0012 },
  { tokenId: 2, symbol: "aapl", name: "apple", fair: 231.44, confidence: 38, spot: 230.9, drift: 0.0006 },
  { tokenId: 3, symbol: "nvda", name: "nvidia", fair: 178.62, confidence: 44, spot: 179.85, drift: -0.0021 },
  { tokenId: 6, symbol: "googl", name: "alphabet", fair: 201.33, confidence: 36, spot: null, drift: -0.0008 },
  { tokenId: 7, symbol: "meta", name: "meta platforms", fair: 712.05, confidence: 33, spot: 715.4, drift: -0.0015 },
  { tokenId: 8, symbol: "spy", name: "spdr s&p 500 etf", fair: 604.18, confidence: 47, spot: 605.02, drift: 0.0004 },
];

function bandHalf(fair: number, confidence: number): number {
  return fair * (0.005 + 0.045 * (1 - confidence / 100));
}

// deterministic 0x hex of `bytes` bytes from a numeric seed (no crypto, no rng).
function pseudoHex(seed: number, bytes = 32): string {
  let x = (seed ^ 0x9e3779b9) >>> 0;
  let out = "0x";
  for (let i = 0; i < bytes; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out += ((x >>> 16) & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

// a single-leaf merkle scheme so the verify drilldown genuinely checks out in
// the demo: canonical -> leaf hash -> root (root == leaf for one leaf), and the
// mocked on-chain read returns the same root.
function mockLeafTs(cycleId: number): number {
  return 1_768_300_000 + (cycleId % 100_000);
}

export function mockCanonical(cycleId: number): string {
  return `1|${cycleId}|412.87000000|41|${mockLeafTs(cycleId)}`;
}

export function mockRoot(cycleId: number): `0x${string}` {
  return keccak256(stringToHex(mockCanonical(cycleId)));
}

function nowMinus(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function fairValueFor(s: Seed, cycleId: number, ts: string, fair = s.fair): FairValue {
  const half = bandHalf(fair, s.confidence);
  return {
    tokenId: s.tokenId,
    symbol: s.symbol,
    name: s.name,
    cycleId,
    ts,
    fairValue: fair,
    confidence: s.confidence,
    bandLow: fair - half,
    bandHigh: fair + half,
    regime: "after_hours",
    suspect: false,
    corporateAction: false,
    anchorStale: false,
    anchorPrice: fair * (1 - s.drift),
    drift: s.drift,
    onchainTwap: s.spot,
    onchainSpot: s.spot,
    depthQuote: s.spot === null ? null : 6000 + s.tokenId * 900,
  };
}

function latestPrices(): FairValue[] {
  const ts = nowMinus(24);
  return SEEDS.map((s) => fairValueFor(s, BASE_CYCLE, ts));
}

function priceHistory(symbol: string): { latest: FairValue; history24h: FairValue[] } | undefined {
  const s = SEEDS.find((x) => x.symbol === symbol);
  if (!s) return undefined;
  const points = 48;
  const history24h: FairValue[] = [];
  for (let i = points - 1; i >= 0; i--) {
    const wobble = Math.sin(i / 3 + s.tokenId) * bandHalf(s.fair, s.confidence) * 0.4;
    history24h.push(
      fairValueFor(s, BASE_CYCLE - i, nowMinus(24 + i * 1800), s.fair + wobble)
    );
  }
  return { latest: fairValueFor(s, BASE_CYCLE, nowMinus(24)), history24h };
}

function commits(limit: number): CommitRow[] {
  const rows: CommitRow[] = [];
  for (let i = 0; i < limit; i++) {
    const cycleId = BASE_CYCLE - i;
    const committedAt = nowMinus(24 + i * CYCLE_SECONDS);
    rows.push({
      cycleId,
      merkleRoot: mockRoot(cycleId),
      observationCount: 6,
      txHash: pseudoHex(cycleId, 32),
      status: "confirmed",
      committedAt,
      createdAt: committedAt,
    });
  }
  return rows;
}

function spreads(): SpreadsPayload {
  return {
    rows: SEEDS.map((s) => {
      const spreadPct = s.spot === null ? null : (s.spot / s.fair - 1) * 100;
      return {
        tokenId: s.tokenId,
        symbol: s.symbol,
        name: s.name,
        fairValue: s.fair,
        onchainSpot: s.spot,
        spreadPct,
        confidence: s.confidence,
        regime: "after_hours",
        suspect: false,
        corporateAction: false,
        anchorStale: false,
        stale: false,
        cycleId: BASE_CYCLE,
        ts: nowMinus(24),
      };
    }),
    thresholds: { warnPct: 1, bigPct: 2 },
  };
}

function accuracy(symbol: string): AccuracyPayload {
  const s = SEEDS.find((x) => x.symbol === symbol);
  const n = 22;
  const samples: AccuracyPayload["samples"] = [];
  let sumAbs = 0;
  for (let i = 0; i < n; i++) {
    const errorPct = Math.sin(i * 1.7 + (s?.tokenId ?? 1)) * 0.6;
    sumAbs += Math.abs(errorPct);
    const open = (s?.fair ?? 300) * (1 + errorPct / 100);
    samples.push({
      marketTs: nowMinus((i + 1) * 86_400),
      openPrice: open,
      predictedFairValue: s?.fair ?? 300,
      predictedAt: nowMinus((i + 1) * 86_400 + 3600),
      confidence: s?.confidence ?? 40,
      errorPct,
    });
  }
  const abs = samples.map((x) => Math.abs(x.errorPct)).sort((a, b) => a - b);
  const mean = sumAbs / n;
  return {
    symbol,
    samples,
    stats: {
      n,
      meanAbsErrorPct: mean,
      medianAbsErrorPct: abs[Math.floor(n / 2)]!,
      p90AbsErrorPct: abs[Math.floor(n * 0.9)]!,
      meanErrorPct: -0.03,
      worstAbsErrorPct: abs[abs.length - 1]!,
    },
  };
}

function health(): HealthPayload {
  const subsystems: HealthPayload["subsystems"] = [
    { name: "indexer", status: "ok", lastSuccess: nowMinus(20), ageMs: 20_000, description: "polling pools and proxies on schedule" },
    { name: "engine", status: "ok", lastSuccess: nowMinus(24), ageMs: 24_000, description: "fair value cycles are publishing" },
    { name: "publisher", status: "ok", lastSuccess: nowMinus(24), ageMs: 24_000, description: "commits are confirming on-chain" },
    { name: "anchors", status: "ok", lastSuccess: nowMinus(3600), ageMs: 3_600_000, description: "close and open anchors are current" },
    { name: "proxies", status: "ok", lastSuccess: nowMinus(15), ageMs: 15_000, description: "24/7 proxy signals are fresh" },
  ];
  return {
    status: "ok",
    mockMode: false,
    subsystems,
    indexer: { lastHeartbeat: nowMinus(20), ageMs: 20_000, ok: true },
    publisher: { lastHeartbeat: nowMinus(24), ok: true, detail: { cycleId: BASE_CYCLE, onchain: true } },
    lastCycle: { newestFairValueTs: nowMinus(24), ageMs: 24_000 },
    cycleSeconds: CYCLE_SECONDS,
    sources: [
      { name: "PROXY_ES", symbol: "es", lastTickTs: nowMinus(12), ageMs: 12_000, stale: false },
      { name: "PROXY_NQ", symbol: "nq", lastTickTs: nowMinus(12), ageMs: 12_000, stale: false },
      { name: "PROXY_ETH", symbol: "eth", lastTickTs: nowMinus(8), ageMs: 8_000, stale: false },
    ],
  };
}

// real measured backtest results, so the evidence section stays honest.
function metrics(
  predictor: "naive" | "drift" | "morrow",
  n: number,
  mae: number,
  median: number,
  rmse: number,
  hit: number | null,
  win: number | null
): BacktestMetrics {
  return {
    predictor,
    n,
    maePct: mae,
    medianAePct: median,
    rmsePct: rmse,
    meanErrorPct: -0.06,
    worstPct: rmse * 8,
    p50AbsPct: median,
    p90AbsPct: mae * 2,
    hitRate: hit,
    winRateVsNaive: win,
  };
}

function scope(
  name: string,
  n: number,
  nv: [number, number, number],
  mo: [number, number, number, number, number]
): BacktestScope {
  return {
    scope: name,
    naive: metrics("naive", n, nv[0], nv[1], nv[2], null, null),
    drift: metrics("drift", n, mo[0], mo[1], mo[2], mo[3], mo[4]),
    morrow: metrics("morrow", n, mo[0], mo[1], mo[2], mo[3], mo[4]),
  };
}

function backtest(): BacktestPayload {
  return {
    run: {
      runAt: nowMinus(3600),
      source: "yahoo-daily",
      method: "next-open predicted from prior close; drift reconstructed from daily proxy bars",
      historyFrom: "2024-07-15",
      historyTo: "2026-07-13",
      sessions: 2994,
    },
    pooled: scope("pooled", 2994, [0.949, 0.562, 1.596], [0.897, 0.546, 1.478, 0.5847, 0.5384]),
    tokens: [
      scope("aapl", 499, [0.657, 0.396, 1.179], [0.658, 0.389, 1.068, 0.5151, 0.4669]),
      scope("googl", 499, [0.881, 0.559, 1.371], [0.829, 0.533, 1.285, 0.5842, 0.5391]),
      scope("meta", 499, [0.97, 0.579, 1.688], [0.897, 0.552, 1.553, 0.6022, 0.5591]),
      scope("nvda", 499, [1.302, 0.947, 1.981], [1.218, 0.896, 1.818, 0.6152, 0.5751]),
      scope("spy", 499, [0.442, 0.288, 0.683], [0.413, 0.281, 0.596, 0.6419, 0.5571]),
      scope("tsla", 499, [1.443, 0.994, 2.186], [1.368, 0.918, 2.06, 0.551, 0.5331]),
    ],
  };
}

function receipts(): ReceiptListItem[] {
  return [
    {
      weekStart: "2026-07-06",
      weekEnd: "2026-07-10",
      generatedAt: nowMinus(86_400),
      hasPng: false,
      summary: {
        cyclesCommitted: 720,
        latestCommitTx: pseudoHex(BASE_CYCLE, 32),
        tokens: SEEDS.map((s) => ({
          symbol: s.symbol,
          samples: 5,
          meanAbsErrorPct: 0.3 + s.tokenId * 0.02,
          bestCall: { date: "2026-07-08", predicted: s.fair, actual: s.fair * 1.001, errorPct: 0.1 },
        })),
      },
    },
  ];
}

function proof(symbol: string, cycleId: number): ProofPayload {
  const ts = mockLeafTs(cycleId);
  const canonicalString = mockCanonical(cycleId);
  return {
    symbol,
    leaf: {
      tokenId: 1,
      cycleId,
      fairValue: "412.87000000",
      confidence: 41,
      timestamp: ts,
      canonicalString,
      hash: mockRoot(cycleId),
    },
    proof: [],
    merkleRoot: mockRoot(cycleId),
    txHash: pseudoHex(cycleId, 32),
    contract: CONTRACT,
    chainId: CHAIN_ID,
    verification: "leaf hash = keccak256(utf8(canonicalString)); single-leaf tree, root == leaf.",
  };
}

// route a GET path to a mock payload (the inner `data`, matching getJson).
// returns undefined for unknown paths so the caller can fall through.
export function mockFor(path: string): unknown {
  const [p, qs] = path.split("?");
  const params = new URLSearchParams(qs ?? "");

  if (p === "/v1/prices") return latestPrices();
  if (p === "/v1/spreads") return spreads();
  if (p === "/health") return health();
  if (p === "/v1/backtest") return backtest();
  if (p === "/v1/receipts") return receipts();

  const priceMatch = p!.match(/^\/v1\/prices\/([^/]+)$/);
  if (priceMatch) return priceHistory(priceMatch[1]!.toLowerCase());

  const accMatch = p!.match(/^\/v1\/accuracy\/([^/]+)$/);
  if (accMatch) return accuracy(accMatch[1]!.toLowerCase());

  if (p === "/v1/commits") return commits(Number(params.get("limit") ?? 50));

  const proofMatch = p!.match(/^\/v1\/proof\/([^/]+)\/(\d+)$/);
  if (proofMatch) return proof(proofMatch[1]!.toLowerCase(), Number(proofMatch[2]));

  return undefined;
}

// the contract-read helpers the explorer uses (chain.ts routes here in DEMO).
export function mockContractStats(): { commitCount: number; latestCycleId: number } {
  return { commitCount: 428_167, latestCycleId: BASE_CYCLE };
}

// a bounded mock of /v1/ask for the landing input.
export function mockAsk(body: unknown): AskResponse {
  const question = typeof (body as { question?: unknown })?.question === "string" ? (body as { question: string }).question : "";
  const q = question.toLowerCase();
  const s = SEEDS.find((x) => new RegExp(`\\b${x.symbol}\\b`).test(q) || q.includes(x.name));
  if (!s) {
    return {
      ok: false,
      panel: null,
      symbol: null,
      question,
      answer: `morrow only answers about its tracked tokens: ${SEEDS.map((x) => x.symbol).join(", ")}. name one.`,
      reason: "no_token",
      data: null,
      provenance: null,
    };
  }
  return {
    ok: true,
    panel: "fair_value",
    symbol: s.symbol,
    question,
    answer: `morrow's off-hours fair value for ${s.symbol} is ${s.fair.toFixed(2)}, confidence ${s.confidence} of 100, band ${(s.fair - bandHalf(s.fair, s.confidence)).toFixed(2)} to ${(s.fair + bandHalf(s.fair, s.confidence)).toFixed(2)}.`,
    data: { fairValue: s.fair, confidence: s.confidence, regime: "after_hours", name: s.name },
    provenance: {
      cycleId: BASE_CYCLE,
      confidence: s.confidence,
      ts: nowMinus(24),
      txHash: pseudoHex(BASE_CYCLE, 32),
      txUrl: null,
      status: "confirmed",
      contract: CONTRACT,
      chainId: CHAIN_ID,
      proofPath: `/v1/proof/${s.symbol}/${BASE_CYCLE}`,
      verifyPath: `/commits?cycle=${BASE_CYCLE}`,
      note: "the agent is not the source of truth. recompute the leaf and check the root on-chain.",
    },
  };
}
