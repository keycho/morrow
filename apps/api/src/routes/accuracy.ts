// realized accuracy. predicted off-hours fair value versus the actual next
// official open print, rolling. this endpoint is the marketing.

import type { FastifyInstance } from "fastify";
import { disclaimer, tokenBySymbol } from "@fletch/config";
import { accuracySamples } from "../db.js";

function percentile(sortedAbs: number[], p: number): number {
  if (sortedAbs.length === 0) return 0;
  const idx = Math.min(sortedAbs.length - 1, Math.ceil((p / 100) * sortedAbs.length) - 1);
  return sortedAbs[Math.max(0, idx)]!;
}

export function registerAccuracyRoutes(app: FastifyInstance): void {
  app.get<{ Params: { symbol: string }; Querystring: { limit?: string } }>(
    "/v1/accuracy/:symbol",
    async (req, reply) => {
      const token = tokenBySymbol(req.params.symbol);
      if (!token) {
        return reply.code(404).send({ error: "unknown symbol", disclaimer });
      }
      const limit = Math.min(Math.max(Number(req.query.limit ?? 60) || 60, 1), 250);
      const samples = await accuracySamples(token.id, limit);

      if (samples.length === 0) {
        return {
          data: {
            symbol: token.symbol,
            samples: [],
            stats: null,
            note: "no open prints recorded yet. accuracy fills in as official opens are inserted (see anchors).",
          },
          disclaimer,
        };
      }

      const errors = samples.map((s) => s.errorPct);
      const absErrors = errors.map((e) => Math.abs(e)).sort((a, b) => a - b);
      const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

      return {
        data: {
          symbol: token.symbol,
          samples,
          stats: {
            n: samples.length,
            meanAbsErrorPct: mean(absErrors),
            medianAbsErrorPct: percentile(absErrors, 50),
            p90AbsErrorPct: percentile(absErrors, 90),
            // signed mean shows systematic bias, positive = predictions high
            meanErrorPct: mean(errors),
            worstAbsErrorPct: absErrors[absErrors.length - 1],
          },
        },
        disclaimer,
      };
    }
  );
}
