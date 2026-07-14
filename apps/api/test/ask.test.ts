import { describe, it, expect } from "vitest";
import { parseAsk, type AskToken } from "../src/ask.js";

const TOKENS: AskToken[] = [
  { symbol: "tsla", aliases: ["tesla"] },
  { symbol: "aapl", aliases: ["apple"] },
  { symbol: "spy", aliases: ["s&p 500 etf", "spdr"] },
];

function intent(q: string) {
  const p = parseAsk(q, TOKENS);
  if (!p.ok) throw new Error(`expected an intent, got refusal: ${p.reason}`);
  return p.intent;
}

describe("parseAsk intents", () => {
  it("defaults a bare token question to fair value", () => {
    expect(intent("what is tsla worth right now")).toEqual({ kind: "fair_value", symbol: "tsla" });
    expect(intent("tsla")).toEqual({ kind: "fair_value", symbol: "tsla" });
  });

  it("matches a token by its name alias", () => {
    expect(intent("how much is apple worth")).toEqual({ kind: "fair_value", symbol: "aapl" });
  });

  it("routes spread questions", () => {
    expect(intent("what is the spread on aapl")).toEqual({ kind: "spread", symbol: "aapl" });
    expect(intent("is tsla trading above fair value")).toEqual({ kind: "spread", symbol: "tsla" });
  });

  it("routes accuracy questions", () => {
    expect(intent("how accurate is morrow on spy")).toEqual({ kind: "accuracy", symbol: "spy" });
    expect(intent("what is the median error for tsla")).toEqual({ kind: "accuracy", symbol: "tsla" });
  });

  it("routes commit / verification questions", () => {
    expect(intent("show me the latest commit for tsla")).toEqual({ kind: "commit", symbol: "tsla" });
    expect(intent("how do i verify aapl on-chain")).toEqual({ kind: "commit", symbol: "aapl" });
  });
});

describe("parseAsk refusals (first-class)", () => {
  it("refuses an empty question", () => {
    const p = parseAsk("   ", TOKENS);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("empty");
  });

  it("refuses trading advice and predictions even with a token present", () => {
    for (const q of [
      "should i buy tsla",
      "will tsla go up tomorrow",
      "is aapl a good investment",
      "predict spy next week",
      "what is the price target for tsla",
    ]) {
      const p = parseAsk(q, TOKENS);
      expect(p.ok, q).toBe(false);
      if (!p.ok) expect(p.reason).toBe("advice");
    }
  });

  it("refuses questions about untracked tokens", () => {
    const p = parseAsk("what is nvda worth", TOKENS);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("no_token");
  });

  it("refuses an overlong question", () => {
    const p = parseAsk("tsla ".repeat(100), TOKENS);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("too_long");
  });

  it("does not match a token as a substring of another word", () => {
    // "spyware" must not resolve to spy.
    const p = parseAsk("tell me about spyware", TOKENS);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe("no_token");
  });
});
