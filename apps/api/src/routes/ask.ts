// POST /v1/ask. a bounded agent surface: it answers only from morrow's own
// data, only about tracked tokens, and only in four shapes (fair value, spread,
// accuracy, a commit). anything else is a clean refusal. every answer carries
// its provenance: the cycle id, the confidence, and the way to verify that
// exact observation on-chain, because the agent is never the source of truth;
// the commit is. the intent parsing is in ask.ts (pure, tested); this route
// does the lookups and stitches on provenance. it is rate limited tighter than
// the read endpoints.

import type { FastifyInstance } from "fastify";
import { chain, disclaimer, tokenBySymbol, tokens } from "@morrow/config";
import { median } from "@morrow/engine";
import { parseAsk, type AskKind, type AskToken } from "../ask.js";
import { accuracySamples, commitByCycle, latestFairValueFor, listCommits } from "../db.js";

const ASK_TOKENS: AskToken[] = tokens.map((t) => ({
  symbol: t.symbol,
  aliases: [t.name.toLowerCase(), ...t.name.toLowerCase().split(/\s+/)].filter((a) => a.length > 2),
}));

const EXPLORER = (process.env.MORROW_EXPLORER_URL ?? "").replace(/\/$/, "");

interface Provenance {
  cycleId: number | null;
  confidence: number | null;
  ts: string | null;
  txHash: string | null;
  txUrl: string | null;
  status: string | null;
  contract: string;
  chainId: number;
  proofPath: string | null; // api: recompute the proof yourself
  verifyPath: string | null; // web: open the explorer verify control
  note: string;
}

interface AskResponse {
  ok: boolean;
  panel: AskKind | null;
  symbol: string | null;
  question: string;
  answer: string;
  reason?: string;
  data: Record<string, unknown> | null;
  provenance: Provenance | null;
}

async function provenanceFor(symbol: string, cycleId: number, confidence: number | null, ts: string | null): Promise<Provenance> {
  const commit = await commitByCycle(cycleId).catch(() => null);
  const txHash = commit?.txHash ?? null;
  return {
    cycleId,
    confidence,
    ts,
    txHash,
    txUrl: txHash && EXPLORER ? `${EXPLORER}/tx/${txHash}` : null,
    status: commit?.status ?? null,
    contract: chain.commitsContract,
    chainId: chain.chainId,
    proofPath: `/v1/proof/${symbol}/${cycleId}`,
    verifyPath: `/commits?cycle=${cycleId}`,
    note: "the agent is not the source of truth. recompute the leaf and check the root on-chain.",
  };
}

function refusal(question: string, reason: string, message: string): AskResponse {
  return { ok: false, panel: null, symbol: null, question, answer: message, reason, data: null, provenance: null };
}

export function registerAskRoutes(app: FastifyInstance): void {
  app.post<{ Body: { question?: unknown } }>(
    "/v1/ask",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const question = typeof req.body?.question === "string" ? req.body.question : "";

      const parsed = parseAsk(question, ASK_TOKENS);
      if (!parsed.ok) {
        return { data: refusal(question, parsed.reason, parsed.message), disclaimer };
      }

      const { kind, symbol } = parsed.intent;
      const token = tokenBySymbol(symbol);
      if (!token) {
        return { data: refusal(question, "no_token", `morrow does not track ${symbol}.`), disclaimer };
      }

      // commit panel: the latest committed cycle (which includes every tracked
      // token), returned with its verify path.
      if (kind === "commit") {
        const commits = await listCommits(1, 0);
        const c = commits[0];
        if (!c) {
          return {
            data: refusal(question, "unavailable", "morrow has not committed any cycles yet."),
            disclaimer,
          };
        }
        const prov = await provenanceFor(symbol, c.cycleId, null, c.committedAt ?? c.createdAt);
        const resp: AskResponse = {
          ok: true,
          panel: "commit",
          symbol,
          question,
          answer: `cycle ${c.cycleId.toLocaleString("en-US")} is committed on-chain with merkle root ${c.merkleRoot.slice(0, 10)}..${c.merkleRoot.slice(-6)}. verify ${symbol} in it yourself.`,
          data: {
            cycleId: c.cycleId,
            merkleRoot: c.merkleRoot,
            observationCount: c.observationCount,
            status: c.status,
            txHash: c.txHash,
          },
          provenance: prov,
        };
        return { data: resp, disclaimer };
      }

      // the other three read the latest fair value for the token.
      const latest = await latestFairValueFor(token.id);
      if (!latest && kind !== "accuracy") {
        return {
          data: refusal(question, "unavailable", `morrow has not published a fair value for ${symbol} yet.`),
          disclaimer,
        };
      }

      if (kind === "fair_value" && latest) {
        const prov = await provenanceFor(symbol, latest.cycleId, latest.confidence, latest.ts);
        const resp: AskResponse = {
          ok: true,
          panel: "fair_value",
          symbol,
          question,
          answer: `morrow's off-hours fair value for ${symbol} is ${latest.fairValue.toFixed(2)}, confidence ${latest.confidence} of 100, band ${latest.bandLow.toFixed(2)} to ${latest.bandHigh.toFixed(2)}.`,
          data: {
            fairValue: latest.fairValue,
            confidence: latest.confidence,
            bandLow: latest.bandLow,
            bandHigh: latest.bandHigh,
            regime: latest.regime,
            name: latest.name,
          },
          provenance: prov,
        };
        return { data: resp, disclaimer };
      }

      if (kind === "spread" && latest) {
        if (latest.onchainSpot === null || latest.fairValue === 0) {
          return {
            data: refusal(
              question,
              "unavailable",
              `morrow has no onchain pool price for ${symbol}, so it cannot state a spread. its fair value is ${latest.fairValue.toFixed(2)}.`
            ),
            disclaimer,
          };
        }
        const spreadPct = (latest.onchainSpot / latest.fairValue - 1) * 100;
        const dir = spreadPct > 0 ? "above" : spreadPct < 0 ? "below" : "at";
        const prov = await provenanceFor(symbol, latest.cycleId, latest.confidence, latest.ts);
        const resp: AskResponse = {
          ok: true,
          panel: "spread",
          symbol,
          question,
          answer: `${symbol}'s pool trades ${dir} morrow fair value by ${Math.abs(spreadPct).toFixed(2)}%. pool ${latest.onchainSpot.toFixed(2)}, fair ${latest.fairValue.toFixed(2)}. a data statement, not advice.`,
          data: {
            fairValue: latest.fairValue,
            onchainSpot: latest.onchainSpot,
            spreadPct,
            confidence: latest.confidence,
          },
          provenance: prov,
        };
        return { data: resp, disclaimer };
      }

      // accuracy: realized error vs the actual next open. "no samples yet" is a
      // clean, correct answer, not a refusal.
      const samples = await accuracySamples(token.id, 250);
      const cycleId = latest?.cycleId ?? null;
      const prov = cycleId ? await provenanceFor(symbol, cycleId, latest?.confidence ?? null, latest?.ts ?? null) : null;
      if (samples.length === 0) {
        const resp: AskResponse = {
          ok: true,
          panel: "accuracy",
          symbol,
          question,
          answer: `morrow has no accuracy samples for ${symbol} yet. accuracy fills in as official opens are recorded.`,
          data: { stats: null, note: "no samples yet" },
          provenance: prov,
        };
        return { data: resp, disclaimer };
      }
      const abs = samples.map((s) => Math.abs(s.errorPct)).sort((a, b) => a - b);
      const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
      const resp: AskResponse = {
        ok: true,
        panel: "accuracy",
        symbol,
        question,
        answer: `over ${samples.length} recorded opens, morrow's mean absolute error on ${symbol} is ${meanAbs.toFixed(3)}%, median ${median(abs).toFixed(3)}%.`,
        data: {
          n: samples.length,
          meanAbsErrorPct: meanAbs,
          medianAbsErrorPct: median(abs),
        },
        provenance: prov,
      };
      void reply;
      return { data: resp, disclaimer };
    }
  );
}
