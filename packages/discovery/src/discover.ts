// pool discovery across uniswap v2, v3, and v4 on robinhood chain.
//
// pool addresses are not published as a table; they are resolved from each
// venue. for each launch token this probes:
//   v3: usdg and weth quotes across the 500/3000/10000 fee tiers
//   v2: usdg and weth pairs
//   v4: usdg, weth (erc20), and native eth quotes across the standard
//       fee/tick-spacing combos, at the no-hook pool id
// each hit is read, priced through the erc-8056 ui multiplier, and depth is
// measured as ±2% quote depth normalized across venues (see @fletch/engine
// poolmath), then dollarized when the quote is weth/eth and eth/usd is known.
//
// this is the read + judge + select logic only; it takes an rpc client and,
// optionally, anchor reference prices for the plausibility gate. it does no
// database or filesystem i/o and prints nothing, so the cli and the indexer
// worker share exactly the same discovery.

import { getAddress, zeroAddress, parseAbi, type Hex, type PublicClient } from "viem";
import {
  chain,
  discovery,
  quoteAssets,
  tokens,
  uniswap,
  uniswapV2,
  uniswapV4,
  type PoolProtocol,
  type TokenConfig,
} from "@fletch/config";
import {
  decodeUiMultiplier,
  depthFromReserves,
  depthFromSqrtPriceX96,
  effectivePerSharePrice,
  spotFromReserves,
  spotFromSqrtPriceX96,
  v4PoolId,
} from "@fletch/engine";
import type { DiscoveredPool, DiscoveryResult, Judged, QuoteDef, Selection } from "./types.js";

const NATIVE = zeroAddress as Hex;

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function uiMultiplier() view returns (uint256)",
]);
const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const v3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
  "function liquidity() view returns (uint128)",
]);
const v2FactoryAbi = parseAbi(["function getPair(address,address) view returns (address)"]);
const v2PairAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 ts)",
]);
const svAbi = parseAbi([
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 pf, uint24 lf)",
  "function getLiquidity(bytes32) view returns (uint128)",
]);

async function readDecimals(c: PublicClient): Promise<Map<string, number>> {
  const addrs = [quoteAssets.usdg.address, quoteAssets.weth.address, ...tokens.map((t) => t.address)];
  const res = await c.multicall({
    multicallAddress: chain.multicall3,
    allowFailure: true,
    contracts: addrs.map((a) => ({ address: a, abi: erc20Abi, functionName: "decimals" as const })),
  });
  const m = new Map<string, number>();
  addrs.forEach((a, i) => {
    const r = res[i];
    m.set(a.toLowerCase(), r && r.status === "success" ? Number(r.result) : 18);
  });
  m.set(NATIVE.toLowerCase(), 18);
  return m;
}

async function readMultipliers(c: PublicClient): Promise<Map<number, bigint | null>> {
  const res = await c.multicall({
    multicallAddress: chain.multicall3,
    allowFailure: true,
    contracts: tokens.map((t) => ({ address: t.address, abi: erc20Abi, functionName: "uiMultiplier" as const })),
  });
  const m = new Map<number, bigint | null>();
  tokens.forEach((t, i) => {
    const r = res[i];
    m.set(t.id, r && r.status === "success" ? (r.result as bigint) : null);
  });
  return m;
}

function makePool(
  token: TokenConfig,
  protocol: PoolProtocol,
  quote: QuoteDef,
  fee: number | null,
  identifier: Hex,
  quoteDec: number,
  baseDec: number,
  invert: boolean,
  rawSpot: number,
  depthQuote: number,
  liquidity: bigint,
  multiplier: number,
  ethUsd: number | null
): DiscoveredPool {
  const priceQuote = effectivePerSharePrice(rawSpot, multiplier);
  const priceUsd = quote.dollarize ? (ethUsd !== null ? priceQuote * ethUsd : null) : priceQuote;
  const depthUsd = quote.dollarize ? (ethUsd !== null ? depthQuote * ethUsd : null) : depthQuote;
  const empty = liquidity === 0n || (depthUsd !== null && depthUsd < discovery.emptyDepthUsd);
  return {
    tokenId: token.id,
    symbol: token.symbol,
    protocol,
    quote: quote.label,
    fee,
    identifier,
    invert,
    baseDecimals: baseDec,
    quoteDecimals: quoteDec,
    priceQuote,
    priceUsd,
    depthQuote,
    depthUsd,
    liquidity: liquidity.toString(),
    empty,
  };
}

// probe every venue for every launch token and return one row per pool found.
export async function discoverPools(c: PublicClient, ethUsd: number | null): Promise<DiscoveredPool[]> {
  const decimals = await readDecimals(c);
  const multipliers = await readMultipliers(c);
  const decOf = (a: Hex): number => decimals.get(a.toLowerCase()) ?? 18;
  const mulOf = (t: TokenConfig): number => decodeUiMultiplier(multipliers.get(t.id) ?? null).multiplier;

  const quoteDefs: QuoteDef[] = [
    { label: "usdg", address: quoteAssets.usdg.address, dollarize: false },
    { label: "weth", address: quoteAssets.weth.address, dollarize: true },
  ];
  const v4QuoteDefs: QuoteDef[] = [...quoteDefs, { label: "eth", address: NATIVE, dollarize: true }];

  const out: DiscoveredPool[] = [];

  // --- v3 -------------------------------------------------------------------
  const v3Probes = tokens.flatMap((t) =>
    quoteDefs.flatMap((q) => uniswap.feeTiers.map((fee) => ({ t, q, fee })))
  );
  const v3PoolRes = await c.multicall({
    multicallAddress: chain.multicall3,
    allowFailure: true,
    contracts: v3Probes.map((p) => ({
      address: uniswap.factory,
      abi: v3FactoryAbi,
      functionName: "getPool" as const,
      args: [p.t.address, p.q.address, p.fee] as const,
    })),
  });
  const v3Hits = v3Probes
    .map((p, i) => ({ p, addr: v3PoolRes[i]?.status === "success" ? (v3PoolRes[i]!.result as Hex) : zeroAddress }))
    .filter((h) => h.addr.toLowerCase() !== zeroAddress.toLowerCase());
  if (v3Hits.length > 0) {
    const detail = await c.multicall({
      multicallAddress: chain.multicall3,
      allowFailure: true,
      contracts: v3Hits.flatMap((h) => [
        { address: h.addr, abi: v3PoolAbi, functionName: "slot0" as const },
        { address: h.addr, abi: v3PoolAbi, functionName: "liquidity" as const },
      ]),
    });
    v3Hits.forEach((h, i) => {
      const s0 = detail[i * 2];
      const lq = detail[i * 2 + 1];
      if (!s0 || s0.status !== "success" || !lq || lq.status !== "success") return;
      const sqrtP = (s0.result as readonly bigint[])[0]!;
      const L = lq.result as bigint;
      const baseDec = decOf(h.p.t.address);
      const quoteDec = decOf(h.p.q.address);
      const invert = getAddress(h.p.t.address) > getAddress(h.p.q.address);
      out.push(
        makePool(
          h.p.t, "v3", h.p.q, h.p.fee, h.addr as Hex, quoteDec, baseDec, invert,
          spotFromSqrtPriceX96(sqrtP, baseDec, quoteDec, invert),
          depthFromSqrtPriceX96(sqrtP, L, quoteDec, invert),
          L, mulOf(h.p.t), ethUsd
        )
      );
    });
  }

  // --- v2 -------------------------------------------------------------------
  const v2Probes = tokens.flatMap((t) => quoteDefs.map((q) => ({ t, q })));
  const v2PairRes = await c.multicall({
    multicallAddress: chain.multicall3,
    allowFailure: true,
    contracts: v2Probes.map((p) => ({
      address: uniswapV2.factory,
      abi: v2FactoryAbi,
      functionName: "getPair" as const,
      args: [p.t.address, p.q.address] as const,
    })),
  });
  const v2Hits = v2Probes
    .map((p, i) => ({ p, addr: v2PairRes[i]?.status === "success" ? (v2PairRes[i]!.result as Hex) : zeroAddress }))
    .filter((h) => h.addr.toLowerCase() !== zeroAddress.toLowerCase());
  if (v2Hits.length > 0) {
    const detail = await c.multicall({
      multicallAddress: chain.multicall3,
      allowFailure: true,
      contracts: v2Hits.map((h) => ({ address: h.addr, abi: v2PairAbi, functionName: "getReserves" as const })),
    });
    v2Hits.forEach((h, i) => {
      const r = detail[i];
      if (!r || r.status !== "success") return;
      const [reserve0, reserve1] = r.result as readonly [bigint, bigint, number];
      const baseDec = decOf(h.p.t.address);
      const quoteDec = decOf(h.p.q.address);
      const invert = getAddress(h.p.t.address) > getAddress(h.p.q.address);
      const liq = reserve0 === 0n || reserve1 === 0n ? 0n : reserve0;
      out.push(
        makePool(
          h.p.t, "v2", h.p.q, null, h.addr as Hex, quoteDec, baseDec, invert,
          spotFromReserves(reserve0, reserve1, baseDec, quoteDec, invert),
          depthFromReserves(reserve0, reserve1, quoteDec, invert),
          liq, mulOf(h.p.t), ethUsd
        )
      );
    });
  }

  // --- v4 -------------------------------------------------------------------
  const v4Probes = tokens.flatMap((t) =>
    v4QuoteDefs.flatMap((q) =>
      uniswapV4.feeTickSpacings.map(([fee, ts]) => {
        const [c0, c1] =
          getAddress(t.address) < getAddress(q.address) ? [t.address, q.address] : [q.address, t.address];
        return { t, q, fee, ts, poolId: v4PoolId(c0, c1, fee, ts, uniswapV4.hooks) };
      })
    )
  );
  const v4Slot0 = await c.multicall({
    multicallAddress: chain.multicall3,
    allowFailure: true,
    contracts: v4Probes.map((p) => ({
      address: uniswapV4.stateView,
      abi: svAbi,
      functionName: "getSlot0" as const,
      args: [p.poolId] as const,
    })),
  });
  const v4Hits = v4Probes
    .map((p, i) => {
      const r = v4Slot0[i];
      const sqrtP = r && r.status === "success" ? (r.result as readonly bigint[])[0]! : 0n;
      return { p, sqrtP };
    })
    .filter((h) => h.sqrtP > 0n);
  if (v4Hits.length > 0) {
    const detail = await c.multicall({
      multicallAddress: chain.multicall3,
      allowFailure: true,
      contracts: v4Hits.map((h) => ({
        address: uniswapV4.stateView,
        abi: svAbi,
        functionName: "getLiquidity" as const,
        args: [h.p.poolId] as const,
      })),
    });
    v4Hits.forEach((h, i) => {
      const lq = detail[i];
      const L = lq && lq.status === "success" ? (lq.result as bigint) : 0n;
      const baseDec = decOf(h.p.t.address);
      const quoteDec = decOf(h.p.q.address);
      const invert = getAddress(h.p.t.address) > getAddress(h.p.q.address);
      out.push(
        makePool(
          h.p.t, "v4", h.p.q, h.p.fee, h.p.poolId, quoteDec, baseDec, invert,
          spotFromSqrtPriceX96(h.sqrtP, baseDec, quoteDec, invert),
          depthFromSqrtPriceX96(h.sqrtP, L, quoteDec, invert),
          L, mulOf(h.p.t), ethUsd
        )
      );
    });
  }

  return out;
}

// mark a pool implausible when its per-share price deviates more than the
// config threshold from the anchor reference. an implausible pool is never
// selected silently; it stays in the table with the flag so the operator sees
// it. refs maps token id -> reference usd price.
export function judgePools(pools: DiscoveredPool[], refs: Map<number, number>): Judged[] {
  return pools.map((p) => {
    const ref = refs.get(p.tokenId);
    let deviation: number | null = null;
    let implausible = false;
    if (ref !== undefined && ref > 0 && p.priceUsd !== null) {
      deviation = Math.abs(p.priceUsd / ref - 1);
      implausible = deviation > discovery.plausibilityDeviation;
    }
    return { ...p, implausible, deviation };
  });
}

// choose the deepest usable (non-empty, plausible) pool for a token, preferring
// usdg when its dollar depth is comparable, since fair value is dollar
// denominated. returns a null selection with a reason when nothing is usable.
export function selectPool(token: TokenConfig, judged: Judged[]): Selection {
  const mine = judged.filter((p) => p.tokenId === token.id);
  const usable = mine.filter((p) => !p.empty && !p.implausible);
  if (usable.length === 0) {
    if (mine.length === 0) return { tokenId: token.id, symbol: token.symbol, chosen: null, reason: "no pool found on any venue" };
    return { tokenId: token.id, symbol: token.symbol, chosen: null, reason: "only empty or implausible pools" };
  }
  const depth = (p: Judged): number => (p.depthUsd === null ? -1 : p.depthUsd);
  const deepest = usable.reduce((a, b) => (depth(b) > depth(a) ? b : a));
  const usdg = usable.filter((p) => p.quote === "usdg");
  if (usdg.length > 0) {
    const deepestUsdg = usdg.reduce((a, b) => (depth(b) > depth(a) ? b : a));
    // prefer usdg when its depth is comparable, or when the deepest overall
    // cannot be depth-compared (weth/eth without eth/usd set).
    if (deepest.depthUsd === null || depth(deepestUsdg) >= discovery.usdgComparableFactor * depth(deepest)) {
      return { tokenId: token.id, symbol: token.symbol, chosen: deepestUsdg, reason: "deepest usdg (dollar denominated)" };
    }
  }
  return {
    tokenId: token.id,
    symbol: token.symbol,
    chosen: deepest,
    reason: `deepest across venues (${deepest.protocol} ${deepest.quote})`,
  };
}

// run a full discovery pass: probe every venue, apply the plausibility gate,
// and select a pool per launch token. pure of i/o beyond the rpc client.
export async function runDiscovery(
  c: PublicClient,
  ethUsd: number | null,
  refs: Map<number, number>
): Promise<DiscoveryResult> {
  const pools = await discoverPools(c, ethUsd);
  const judged = judgePools(pools, refs);
  const selections = tokens.map((t) => selectPool(t, judged));
  return { ethUsd, judged, selections };
}
