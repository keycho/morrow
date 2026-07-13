// api key resolution and admin auth. only sha-256 hashes of keys are ever
// stored or compared. a small in-memory cache keeps the hot path off the
// database.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { keyTierByHash } from "./db.js";

export type Tier = "free" | "keyed";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface CacheEntry {
  tier: Tier;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export async function resolveTier(req: FastifyRequest): Promise<{ tier: Tier; keyHash: string | null }> {
  const raw = req.headers["x-api-key"];
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return { tier: "free", keyHash: null };

  const keyHash = sha256Hex(key);
  const cached = cache.get(keyHash);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { tier: cached.tier, keyHash };
  }

  const tier = (await keyTierByHash(keyHash)) === "keyed" ? "keyed" : "free";
  cache.set(keyHash, { tier, expiresAt: now + CACHE_TTL_MS });
  return { tier, keyHash };
}

export function generateApiKey(): { plaintext: string; keyHash: string } {
  const plaintext = `flk_${randomBytes(24).toString("base64url")}`;
  return { plaintext, keyHash: sha256Hex(plaintext) };
}

// constant-time bearer comparison for the admin token. both sides are
// hashed first so lengths always match.
export function isAdmin(req: FastifyRequest): boolean {
  const configured = process.env.ADMIN_TOKEN;
  if (!configured) return false;
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(configured).digest();
  return timingSafeEqual(a, b);
}
