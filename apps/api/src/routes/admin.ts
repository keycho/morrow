// admin endpoints, bearer ADMIN_TOKEN. v1 anchor management is manual by
// design (config.anchors.automatedSource reserves the automated path) and
// api keys are minted here. plaintext keys are returned exactly once.

import type { FastifyInstance } from "fastify";
import { disclaimer, tokenBySymbol } from "@fletch/config";
import { generateApiKey, isAdmin } from "../auth.js";
import { insertAnchor, insertKey } from "../db.js";

interface AnchorBody {
  symbol?: string;
  kind?: string;
  price?: number;
  marketTs?: string;
}

interface KeyBody {
  label?: string;
}

export function registerAdminRoutes(app: FastifyInstance): void {
  app.post<{ Body: AnchorBody }>("/v1/admin/anchors", async (req, reply) => {
    if (!isAdmin(req)) {
      return reply.code(401).send({ error: "unauthorized", disclaimer });
    }
    const { symbol, kind, price, marketTs } = req.body ?? {};
    const token = symbol ? tokenBySymbol(symbol) : undefined;
    if (!token) {
      return reply.code(400).send({ error: "unknown or missing symbol", disclaimer });
    }
    if (kind !== "close" && kind !== "open") {
      return reply.code(400).send({ error: "kind must be close or open", disclaimer });
    }
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      return reply.code(400).send({ error: "price must be a positive number", disclaimer });
    }
    const ts = marketTs ? new Date(marketTs) : null;
    if (!ts || Number.isNaN(ts.getTime())) {
      return reply.code(400).send({
        error: "marketTs must be an iso timestamp of the official print (16:00 et close, 09:30 et open)",
        disclaimer,
      });
    }
    await insertAnchor(token.id, kind, price, ts, "manual");
    return {
      data: { symbol: token.symbol, kind, price, marketTs: ts.toISOString() },
      disclaimer,
    };
  });

  app.post<{ Body: KeyBody }>("/v1/admin/keys", async (req, reply) => {
    if (!isAdmin(req)) {
      return reply.code(401).send({ error: "unauthorized", disclaimer });
    }
    const label = (req.body?.label ?? "").trim();
    if (!label) {
      return reply.code(400).send({ error: "label is required", disclaimer });
    }
    const { plaintext, keyHash } = generateApiKey();
    await insertKey(keyHash, label);
    return {
      data: {
        key: plaintext,
        label,
        note: "store this now. only the hash is kept server-side and it cannot be shown again.",
      },
      disclaimer,
    };
  });
}
