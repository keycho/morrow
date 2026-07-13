// price endpoints. the x402 middleware guards these three routes when
// enabled; everything else on the api stays free (rate-limited).

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { disclaimer, tokenBySymbol, tokens } from "@morrow/config";
import {
  fairValueHistory,
  fairValueHistoryCount,
  latestFairValueFor,
  latestFairValues,
} from "../db.js";

function parseWhen(value: unknown, fallback: Date): Date {
  if (typeof value !== "string" || value === "") return fallback;
  // unix seconds or iso 8601
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.length <= 12) {
    return new Date(asNumber * 1000);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed;
}

export function registerPriceRoutes(app: FastifyInstance, x402: preHandlerHookHandler): void {
  app.get("/v1/tokens", async () => {
    return {
      data: tokens.map((t) => ({
        id: t.id,
        symbol: t.symbol,
        name: t.name,
        pool: t.pool,
      })),
      disclaimer,
    };
  });

  app.get("/v1/prices", { preHandler: x402 }, async () => {
    const rows = await latestFairValues();
    return { data: rows, disclaimer };
  });

  app.get<{ Params: { symbol: string } }>(
    "/v1/prices/:symbol",
    { preHandler: x402 },
    async (req, reply) => {
      const token = tokenBySymbol(req.params.symbol);
      if (!token) {
        return reply.code(404).send({ error: "unknown symbol", disclaimer });
      }
      const latest = await latestFairValueFor(token.id);
      if (!latest) {
        return reply.code(404).send({ error: "no fair value published yet", disclaimer });
      }
      const to = new Date();
      const from = new Date(to.getTime() - 24 * 3600 * 1000);
      const history = await fairValueHistory(token.id, from, to, 500, 0);
      return { data: { latest, history24h: history }, disclaimer };
    }
  );

  app.get<{
    Params: { symbol: string };
    Querystring: { from?: string; to?: string; limit?: string; offset?: string };
  }>("/v1/prices/:symbol/history", { preHandler: x402 }, async (req, reply) => {
    const token = tokenBySymbol(req.params.symbol);
    if (!token) {
      return reply.code(404).send({ error: "unknown symbol", disclaimer });
    }
    const to = parseWhen(req.query.to, new Date());
    const from = parseWhen(req.query.from, new Date(to.getTime() - 7 * 24 * 3600 * 1000));
    const limit = Math.min(Math.max(Number(req.query.limit ?? 500) || 500, 1), 2000);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const [rows, total] = await Promise.all([
      fairValueHistory(token.id, from, to, limit, offset),
      fairValueHistoryCount(token.id, from, to),
    ]);
    return {
      data: rows,
      pagination: { limit, offset, count: rows.length, total },
      range: { from: from.toISOString(), to: to.toISOString() },
      disclaimer,
    };
  });
}
