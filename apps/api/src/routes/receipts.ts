// receipts endpoints. weekly accuracy cards: a list, a single week (markdown
// plus summary), and the rendered png. generation happens in the worker or
// via `pnpm receipts`; the api only serves what is stored.

import type { FastifyInstance } from "fastify";
import { disclaimer } from "@morrow/config";
import { getReceipt, getReceiptPng, listReceipts } from "../db.js";

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

export function registerReceiptRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string } }>("/v1/receipts", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 52) || 52, 1), 260);
    const rows = await listReceipts(limit);
    return { data: rows, disclaimer };
  });

  app.get<{ Params: { weekStart: string } }>("/v1/receipts/:weekStart", async (req, reply) => {
    if (!WEEK_RE.test(req.params.weekStart)) {
      return reply.code(400).send({ error: "weekStart must be yyyy-mm-dd", disclaimer });
    }
    const receipt = await getReceipt(req.params.weekStart);
    if (!receipt) {
      return reply.code(404).send({ error: "no receipt for that week", disclaimer });
    }
    return { data: receipt, disclaimer };
  });

  app.get<{ Params: { weekStart: string } }>(
    "/v1/receipts/:weekStart/card.png",
    async (req, reply) => {
      if (!WEEK_RE.test(req.params.weekStart)) {
        return reply.code(400).send({ error: "weekStart must be yyyy-mm-dd", disclaimer });
      }
      const png = await getReceiptPng(req.params.weekStart);
      if (!png) {
        return reply.code(404).send({ error: "no png for that week", disclaimer });
      }
      return reply.header("content-type", "image/png").header("cache-control", "public, max-age=3600").send(png);
    }
  );
}
