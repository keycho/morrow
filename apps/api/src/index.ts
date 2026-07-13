// fletch api. fastify on railway.
//
// endpoints:
//   GET /v1/tokens
//   GET /v1/prices                       latest fair value, all tokens
//   GET /v1/prices/:symbol               latest plus 24h history
//   GET /v1/prices/:symbol/history       paginated history (from, to)
//   GET /v1/commits                      commit records with tx hashes
//   GET /v1/commits/:cycleId
//   GET /v1/proof/:symbol/:cycleId       merkle proof for verification
//   GET /v1/accuracy/:symbol             realized error vs next-open prints
//   GET /health
//   POST /v1/admin/anchors               bearer ADMIN_TOKEN
//   POST /v1/admin/keys                  bearer ADMIN_TOKEN
//
// tiers: anonymous (free, rate limited), api key via x-api-key (keyed
// limits), and an x402 payment-required path on the price endpoints for
// agent pay-per-query (skeleton; settlement behind an interface).

import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { api, disclaimer } from "@fletch/config";
import { resolveTier, type Tier } from "./auth.js";
import { closeDb } from "./db.js";
import { createX402Middleware, UnwiredVerifier } from "./x402.js";
import { registerPriceRoutes } from "./routes/prices.js";
import { registerCommitRoutes } from "./routes/commits.js";
import { registerAccuracyRoutes } from "./routes/accuracy.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerSpreadRoutes } from "./routes/spreads.js";

interface TieredRequest extends FastifyRequest {
  fletchTier?: Tier;
  fletchKeyHash?: string | null;
}

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: "info" },
    trustProxy: true,
  });

  await app.register(cors, { origin: api.corsOrigin });

  // resolve the caller tier before the rate limiter runs
  app.addHook("onRequest", async (req) => {
    const tiered = req as TieredRequest;
    const { tier, keyHash } = await resolveTier(req);
    tiered.fletchTier = tier;
    tiered.fletchKeyHash = keyHash;
  });

  await app.register(rateLimit, {
    global: true,
    max: (req) =>
      (req as TieredRequest).fletchTier === "keyed"
        ? api.rateLimit.keyedPerMinute
        : api.rateLimit.freePerMinute,
    timeWindow: "1 minute",
    keyGenerator: (req) => (req as TieredRequest).fletchKeyHash ?? req.ip,
    allowList: (req) => req.url === "/health",
    errorResponseBuilder: (_req, context) => ({
      error: "rate limit exceeded",
      retryAfterMs: context.ttl,
      hint: "send an api key in x-api-key for higher limits",
      disclaimer,
    }),
  });

  // x402 skeleton. swap UnwiredVerifier for a real implementation to wire
  // settlement; nothing else changes.
  const x402 = createX402Middleware(new UnwiredVerifier());

  registerPriceRoutes(app, x402);
  registerCommitRoutes(app);
  registerAccuracyRoutes(app);
  registerHealthRoutes(app);
  registerAdminRoutes(app);
  registerSpreadRoutes(app);

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: "not found", disclaimer });
  });

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    app.log.error({ err }, "request failed");
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    void reply.code(statusCode).send({ error: "internal error", disclaimer });
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await app.listen({ port: api.port, host: api.host });
  app.log.info(`fletch api listening on ${api.host}:${api.port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
