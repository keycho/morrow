import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { redactSecrets } from "../config.js";

describe("redactSecrets", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    // a realistic alchemy rpc url and a finnhub key, plus a db url.
    process.env.MORROW_RPC_URL = "https://robinhood-mainnet.g.alchemy.com/v2/SuperSecretAlchemyKey123";
    process.env.ANCHOR_API_KEY = "d9ancf1r01qp4bhrn4t0finnhubkey";
    process.env.DATABASE_URL = "postgresql://user:pgpassword123@db.example.com:5432/morrow";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("masks the exact rpc url wherever it appears, including inside an error", () => {
    const line = `pool read failed: HTTP request failed. URL: ${process.env.MORROW_RPC_URL}`;
    const out = redactSecrets(line);
    expect(out).not.toContain("SuperSecretAlchemyKey123");
    expect(out).toContain("[redacted:MORROW_RPC_URL]");
  });

  it("masks the finnhub key embedded in an anchor url", () => {
    const line = `anchor fetch https://finnhub.io/api/v1/quote?symbol=TSLA&token=${process.env.ANCHOR_API_KEY}`;
    const out = redactSecrets(line);
    expect(out).not.toContain("d9ancf1r01qp4bhrn4t0finnhubkey");
  });

  it("masks db url userinfo even for an unknown host", () => {
    const out = redactSecrets("connect postgresql://someuser:somepass1234@other-host:5432/db failed");
    expect(out).not.toContain("somepass1234");
    expect(out).toContain("//[redacted]@");
  });

  it("masks alchemy path-style keys by pattern even when the value is not in env", () => {
    const out = redactSecrets("rpc https://x.g.alchemy.com/v2/UnknownKeyNotInEnv999 timed out");
    expect(out).not.toContain("UnknownKeyNotInEnv999");
    expect(out).toContain("/v2/[redacted]");
  });

  it("masks query-string api keys by pattern", () => {
    const out = redactSecrets("GET /thing?apikey=ZZZmysteryZZZ&x=1");
    expect(out).not.toContain("ZZZmysteryZZZ");
    expect(out).toContain("apikey=[redacted]");
  });

  it("leaves ordinary log text untouched", () => {
    const line = "cycle 2973456 published root 0x9f3c committed tsla nvda";
    expect(redactSecrets(line)).toBe(line);
  });

  it("is a no-op on empty input", () => {
    expect(redactSecrets("")).toBe("");
  });
});
