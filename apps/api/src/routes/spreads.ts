// spreads endpoint. the mispricings board: onchain pool price (already
// multiplier-adjusted and dollarized by the reader) versus fletch fair value,
// per token, sorted by absolute spread. the dashboard and the telegram alert
// worker both read this. thresholds are echoed so the client stays
// config-driven.

import type { FastifyInstance } from "fastify";
import { disclaimer, spreads, timing } from "@fletch/config";
import { latestFairValues } from "../db.js";

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

export function registerSpreadRoutes(app: FastifyInstance): void {
  app.get("/v1/spreads", async () => {
    const rows = await latestFairValues();
    const now = Date.now();
    const staleAfterMs = timing.cycleSeconds * 2 * 1000;

    const result: SpreadRow[] = rows.map((r) => {
      const spreadPct =
        r.onchainSpot !== null && r.fairValue > 0
          ? (r.onchainSpot / r.fairValue - 1) * 100
          : null;
      return {
        tokenId: r.tokenId,
        symbol: r.symbol,
        name: r.name,
        fairValue: r.fairValue,
        onchainSpot: r.onchainSpot,
        spreadPct,
        confidence: r.confidence,
        regime: r.regime,
        suspect: r.suspect,
        corporateAction: r.corporateAction,
        anchorStale: r.anchorStale,
        stale: now - new Date(r.ts).getTime() > staleAfterMs,
        cycleId: r.cycleId,
        ts: r.ts,
      };
    });

    // biggest absolute divergences on top; tokens without a spread last.
    result.sort((a, b) => {
      const av = a.spreadPct === null ? -1 : Math.abs(a.spreadPct);
      const bv = b.spreadPct === null ? -1 : Math.abs(b.spreadPct);
      return bv - av;
    });

    return {
      data: { rows: result, thresholds: { warnPct: spreads.warnPct, bigPct: spreads.bigPct } },
      disclaimer,
    };
  });
}
