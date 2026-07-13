// pure tests for the discovery judgement, selection, and run analysis. no rpc
// and no database: the chain-reading path is exercised live by the cli, but
// the logic that decides what is usable and what to alert on is pinned here.

import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { discovery, type TokenConfig } from "@morrow/config";
import { analyzeDiscovery, judgePools, selectPool } from "../src/index.js";
import type { DiscoveredPool, DiscoveryResult, Judged } from "../src/types.js";

function tokenFixture(over: Partial<TokenConfig>): TokenConfig {
  return {
    id: 1,
    symbol: "aaa",
    name: "a",
    address: "0x0000000000000000000000000000000000000001",
    quote: "usdg",
    protocol: "v3",
    pool: null,
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: [],
    ...over,
  };
}

function poolFixture(over: Partial<DiscoveredPool>): DiscoveredPool {
  return {
    tokenId: 1,
    symbol: "aaa",
    protocol: "v3",
    quote: "usdg",
    fee: 3000,
    identifier: "0xpool" as Hex,
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    priceQuote: 100,
    priceUsd: 100,
    depthQuote: 1000,
    depthUsd: 1000,
    liquidity: "1",
    empty: false,
    ...over,
  };
}

function judgedFixture(over: Partial<Judged>): Judged {
  return { ...poolFixture(over), implausible: false, deviation: null, ...over };
}

describe("judgePools", () => {
  it("marks a pool implausible when it deviates more than the threshold", () => {
    const refs = new Map([[1, 100]]);
    const far = poolFixture({ priceUsd: 100 * (1 + discovery.plausibilityDeviation * 2) });
    const j = judgePools([far], refs)[0]!;
    expect(j.implausible).toBe(true);
    expect(j.deviation).toBeGreaterThan(discovery.plausibilityDeviation);
  });

  it("keeps a pool plausible within the threshold", () => {
    const refs = new Map([[1, 100]]);
    const near = poolFixture({ priceUsd: 100 * (1 + discovery.plausibilityDeviation * 0.5) });
    const j = judgePools([near], refs)[0]!;
    expect(j.implausible).toBe(false);
    expect(j.deviation).toBeLessThan(discovery.plausibilityDeviation);
  });

  it("cannot judge without a reference", () => {
    const j = judgePools([poolFixture({ priceUsd: 999 })], new Map())[0]!;
    expect(j.implausible).toBe(false);
    expect(j.deviation).toBeNull();
  });

  it("cannot judge a pool whose price is not dollarized", () => {
    const refs = new Map([[1, 100]]);
    const j = judgePools([poolFixture({ quote: "weth", priceUsd: null })], refs)[0]!;
    expect(j.implausible).toBe(false);
    expect(j.deviation).toBeNull();
  });
});

describe("selectPool", () => {
  const token = tokenFixture({ id: 1 });

  it("returns no pool found when the token has no pools", () => {
    const sel = selectPool(token, []);
    expect(sel.chosen).toBeNull();
    expect(sel.reason).toContain("no pool found");
  });

  it("returns null when every pool is empty or implausible", () => {
    const judged = [
      judgedFixture({ empty: true }),
      judgedFixture({ implausible: true, quote: "weth" }),
    ];
    const sel = selectPool(token, judged);
    expect(sel.chosen).toBeNull();
    expect(sel.reason).toContain("empty or implausible");
  });

  it("never selects an empty pool", () => {
    const judged = [
      judgedFixture({ quote: "usdg", depthUsd: 5000, empty: true, identifier: "0xempty" as Hex }),
      judgedFixture({ quote: "weth", depthUsd: 500, identifier: "0xweth" as Hex }),
    ];
    const sel = selectPool(token, judged);
    expect(sel.chosen?.identifier).toBe("0xweth");
  });

  it("never selects an implausible pool", () => {
    const judged = [
      judgedFixture({ quote: "usdg", depthUsd: 9000, implausible: true, identifier: "0ximplausible" as Hex }),
      judgedFixture({ quote: "weth", depthUsd: 400, identifier: "0xok" as Hex }),
    ];
    const sel = selectPool(token, judged);
    expect(sel.chosen?.identifier).toBe("0xok");
  });

  it("prefers usdg when its depth is comparable to the deepest", () => {
    const judged = [
      judgedFixture({ quote: "usdg", depthUsd: 1000, identifier: "0xusdg" as Hex }),
      judgedFixture({ quote: "weth", depthUsd: 1200, identifier: "0xweth" as Hex }),
    ];
    const sel = selectPool(token, judged);
    expect(sel.chosen?.quote).toBe("usdg");
    expect(sel.reason).toContain("usdg");
  });

  it("takes the deepest venue when usdg is far shallower", () => {
    const judged = [
      judgedFixture({ quote: "usdg", depthUsd: 100, identifier: "0xusdg" as Hex }),
      judgedFixture({ quote: "weth", depthUsd: 5000, identifier: "0xweth" as Hex }),
    ];
    const sel = selectPool(token, judged);
    expect(sel.chosen?.identifier).toBe("0xweth");
    expect(sel.reason).toContain("deepest across venues");
  });
});

describe("analyzeDiscovery", () => {
  const floor = discovery.depthAlertFloorUsd;
  const runs = discovery.depthBelowFloorRuns;

  function runWithConfiguredDepth(
    tokenId: number,
    identifier: Hex,
    depthUsd: number | null
  ): DiscoveryResult {
    return {
      ethUsd: null,
      judged: [judgedFixture({ tokenId, identifier, depthUsd, quote: "usdg" })],
      selections: [],
    };
  }

  it("flags a new usable pool for an unconfigured token", () => {
    const token = tokenFixture({ id: 9, symbol: "zzz", pool: null });
    const current: DiscoveryResult = {
      ethUsd: null,
      judged: [],
      selections: [
        {
          tokenId: 9,
          symbol: "zzz",
          chosen: judgedFixture({ tokenId: 9, symbol: "zzz", depthUsd: 8000, identifier: "0xnew" as Hex }),
          reason: "deepest usdg (dollar denominated)",
        },
      ],
    };
    const findings = analyzeDiscovery([current], [token]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("new-pool");
    expect(findings[0]!.symbol).toBe("zzz");
  });

  it("does not flag an unconfigured token with no usable pool", () => {
    const token = tokenFixture({ id: 9, symbol: "zzz", pool: null });
    const current: DiscoveryResult = {
      ethUsd: null,
      judged: [],
      selections: [{ tokenId: 9, symbol: "zzz", chosen: null, reason: "only empty or implausible pools" }],
    };
    expect(analyzeDiscovery([current], [token])).toHaveLength(0);
  });

  it("flags a configured pool below the floor for the sustained window", () => {
    const id = "0xconfigured" as Hex;
    const token = tokenFixture({ id: 3, symbol: "ccc", pool: id });
    const history = Array.from({ length: runs }, () => runWithConfiguredDepth(3, id, floor - 1));
    const findings = analyzeDiscovery(history, [token]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("depth-below-floor");
  });

  it("does not flag until the window is full", () => {
    const id = "0xconfigured" as Hex;
    const token = tokenFixture({ id: 3, symbol: "ccc", pool: id });
    const history = Array.from({ length: runs - 1 }, () => runWithConfiguredDepth(3, id, floor - 1));
    expect(analyzeDiscovery(history, [token])).toHaveLength(0);
  });

  it("does not flag when a run in the window is above the floor", () => {
    const id = "0xconfigured" as Hex;
    const token = tokenFixture({ id: 3, symbol: "ccc", pool: id });
    const history = [
      runWithConfiguredDepth(3, id, floor - 1),
      runWithConfiguredDepth(3, id, floor + 1),
      ...Array.from({ length: runs }, () => runWithConfiguredDepth(3, id, floor - 1)),
    ];
    expect(analyzeDiscovery(history, [token])).toHaveLength(0);
  });

  it("does not flag when the configured pool is missing from a run", () => {
    const id = "0xconfigured" as Hex;
    const token = tokenFixture({ id: 3, symbol: "ccc", pool: id });
    const history = [
      runWithConfiguredDepth(3, id, floor - 1),
      runWithConfiguredDepth(3, id, null),
      ...Array.from({ length: runs }, () => runWithConfiguredDepth(3, id, floor - 1)),
    ];
    expect(analyzeDiscovery(history, [token])).toHaveLength(0);
  });

  it("does not flag a healthy configured pool", () => {
    const id = "0xconfigured" as Hex;
    const token = tokenFixture({ id: 3, symbol: "ccc", pool: id });
    const history = Array.from({ length: runs }, () => runWithConfiguredDepth(3, id, floor * 10));
    expect(analyzeDiscovery(history, [token])).toHaveLength(0);
  });
});
