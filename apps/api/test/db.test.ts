import { describe, it, expect, vi } from "vitest";
import { isTransientDbError, withDbRetry } from "../src/db.js";

describe("isTransientDbError", () => {
  it("classifies pooled-connection drops as transient", () => {
    expect(isTransientDbError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientDbError(new Error("server closed the connection unexpectedly"))).toBe(true);
    expect(isTransientDbError(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransientDbError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(
      isTransientDbError(new Error("terminating connection due to administrator command"))
    ).toBe(true);
  });

  it("does not treat a real query error as transient", () => {
    expect(isTransientDbError(new Error('syntax error at or near "slect"'))).toBe(false);
    expect(isTransientDbError(new Error('null value in column "x" violates not-null'))).toBe(false);
    expect(isTransientDbError("nope")).toBe(false);
  });
});

describe("withDbRetry", () => {
  const noDelay = { delayMs: () => 0 };

  it("retries a transient failure and then succeeds (the intermittent-500 fix)", async () => {
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
      .mockResolvedValueOnce("ok");
    const out = await withDbRetry(fn, noDelay);
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows a non-transient error immediately, without retrying", async () => {
    const fn = vi.fn<[], Promise<string>>().mockRejectedValue(new Error("syntax error"));
    await expect(withDbRetry(fn, noDelay)).rejects.toThrow("syntax error");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget on a persistent transient error", async () => {
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValue(new Error("server closed the connection"));
    await expect(withDbRetry(fn, { retries: 2, delayMs: () => 0 })).rejects.toThrow(
      "server closed the connection"
    );
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("returns immediately on first success", async () => {
    const fn = vi.fn<[], Promise<number>>().mockResolvedValue(42);
    expect(await withDbRetry(fn, noDelay)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
