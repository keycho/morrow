// pool discovery for fletch, across uniswap v2, v3, and v4.
//
// pool addresses on robinhood chain are not published as a table; they are
// resolved from each venue. for each launch token this probes:
//   v3: usdg and weth quotes across the 500/3000/10000 fee tiers
//   v2: usdg and weth pairs
//   v4: usdg, weth (erc20), and native eth quotes across the standard
//       fee/tick-spacing combos, at the no-hook pool id
// it reads each pool, prints one table across all venues sorted by dollar
// depth, and emits a ready-to-paste config snippet selecting the deepest pool
// per token, preferring usdg (dollar denominated) when depth is comparable.
//
// plausibility: a pool with effectively zero liquidity is reported empty and
// never selected. if an anchor reference is available (DATABASE_URL set), a
// pool whose per-share price deviates more than the config threshold from it
// is marked implausible and never selected silently. otherwise the computed
// price is shown for the operator to judge.
//
// this reads mainnet, so it refuses to run without FLETCH_RPC_URL in env. set
// ETH_USD to dollarize weth and native-eth pools for depth comparison.

import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  zeroAddress,
  type Hex,
  type PublicClient,
} from "viem";
import pg from "pg";
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

const NATIVE = zeroAddress;

const erc20Abi = parseAbi(["function decimals() view returns (uint8)", "function uiMultiplier() view returns (uint256)"]);
const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const v3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
  "function liquidity() view returns (uint128)",
]);
const v2FactoryAbi = parseAbi(["function getPair(address,address) view returns (address)"]);
const v2PairAbi = parseAbi(["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 ts)"]);
const svAbi = parseAbi([
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 pf, uint24 lf)",
  "function getLiquidity(bytes32) view returns (uint128)",
]);

interface QuoteDef {
  label: "usdg" | "weth" | "eth";
  address: Hex;
  dollarize: boolean;
}

export interface DiscoveredPool {
  token: TokenConfig;
  protocol: PoolProtocol;
  quote: QuoteDef["label"];
  // fee tier in hundredths of a bip, or null for v2.
  fee: number | null;
  // pool/pair address for v2 and v3, or the v4 pool id.
  identifier: Hex;
  invert: boolean;
  baseDecimals: number;
  quoteDecimals: number;
  // per-share price in quote units, and in usd (dollarized where needed, or
  // null when a weth/eth pool cannot be dollarized without ETH_USD).
  priceQuote: number;
  priceUsd: number | null;
  depthQuote: number;
  depthUsd: number | null;
  liquidity: string;
  empty: boolean;
}

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
    token,
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

async function discover(c: PublicClient, ethUsd: number | null): Promise<DiscoveredPool[]> {
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
          h.p.t, "v3", h.p.q, h.p.fee, h.addr, quoteDec, baseDec, invert,
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
          h.p.t, "v2", h.p.q, null, h.addr, quoteDec, baseDec, invert,
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

// --- anchor reference (optional) --------------------------------------------

async function readAnchorReferences(): Promise<Map<number, number>> {
  const refs = new Map<number, number>();
  const url = process.env.DATABASE_URL;
  if (!url) return refs;
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const res = await pool.query(
      `select distinct on (token_id) token_id, price from anchors where kind = 'close' order by token_id, market_ts desc`
    );
    for (const row of res.rows) refs.set(Number(row.token_id), Number(row.price));
  } catch {
    // reference is optional; ignore failures.
  } finally {
    await pool.end();
  }
  return refs;
}

// --- output -----------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function fmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function idShort(id: Hex): string {
  return id.length > 14 ? id.slice(0, 12) + ".." : id;
}

interface Judged extends DiscoveredPool {
  implausible: boolean;
  deviation: number | null;
}

function judge(pools: DiscoveredPool[], refs: Map<number, number>): Judged[] {
  return pools.map((p) => {
    const ref = refs.get(p.token.id);
    let deviation: number | null = null;
    let implausible = false;
    if (ref !== undefined && ref > 0 && p.priceUsd !== null) {
      deviation = Math.abs(p.priceUsd / ref - 1);
      implausible = deviation > discovery.plausibilityDeviation;
    }
    return { ...p, implausible, deviation };
  });
}

interface Selection {
  token: TokenConfig;
  chosen: Judged | null;
  reason: string;
}

function select(token: TokenConfig, judged: Judged[]): Selection {
  const mine = judged.filter((p) => p.token.id === token.id);
  const usable = mine.filter((p) => !p.empty && !p.implausible);
  if (usable.length === 0) {
    if (mine.length === 0) return { token, chosen: null, reason: "no pool found on any venue" };
    return { token, chosen: null, reason: "only empty or implausible pools" };
  }
  const depth = (p: Judged): number => (p.depthUsd === null ? -1 : p.depthUsd);
  const deepest = usable.reduce((a, b) => (depth(b) > depth(a) ? b : a));
  const usdg = usable.filter((p) => p.quote === "usdg");
  if (usdg.length > 0) {
    const deepestUsdg = usdg.reduce((a, b) => (depth(b) > depth(a) ? b : a));
    // prefer usdg when its depth is comparable, or when the deepest overall
    // cannot be depth-compared (weth/eth without ETH_USD set).
    if (deepest.depthUsd === null || depth(deepestUsdg) >= discovery.usdgComparableFactor * depth(deepest)) {
      return { token, chosen: deepestUsdg, reason: "deepest usdg (dollar denominated)" };
    }
  }
  return { token, chosen: deepest, reason: `deepest across venues (${deepest.protocol} ${deepest.quote})` };
}

function printTable(judged: Judged[]): void {
  console.log("");
  console.log("discovered pools (all venues, sorted by dollar depth)");
  console.log(
    "  " +
      pad("ticker", 7) +
      pad("venue", 6) +
      pad("quote", 6) +
      pad("fee", 7) +
      pad("id", 15) +
      pad("price usd", 12) +
      pad("depth usd", 12) +
      "flags"
  );
  const sorted = [...judged].sort((a, b) => (b.depthUsd ?? -1) - (a.depthUsd ?? -1));
  for (const p of sorted) {
    const flags = [p.empty ? "empty" : "", p.implausible ? `implausible(${((p.deviation ?? 0) * 100).toFixed(0)}%)` : ""]
      .filter(Boolean)
      .join(" ");
    const priceCell = p.priceUsd !== null ? fmt(p.priceUsd) : `${fmt(p.priceQuote)} ${p.quote}`;
    const depthCell = p.depthUsd !== null ? fmt(p.depthUsd) : `${fmt(p.depthQuote)} ${p.quote}`;
    console.log(
      "  " +
        pad(p.token.symbol, 7) +
        pad(p.protocol, 6) +
        pad(p.quote, 6) +
        pad(p.fee === null ? "-" : String(p.fee), 7) +
        pad(idShort(p.identifier), 15) +
        pad(priceCell, 12) +
        pad(depthCell, 12) +
        flags
    );
  }
}

function printSnippet(selections: Selection[]): void {
  const wethSelected = selections.some((s) => s.chosen && (s.chosen.quote === "weth" || s.chosen.quote === "eth"));
  console.log("");
  console.log("ready-to-paste config snippet (packages/config/config.ts)");
  console.log("");
  console.log("export const tokens: TokenConfig[] = [");
  for (const s of selections) {
    const t = s.token;
    const proxyList = `[${t.proxies.map((p) => `"${p}"`).join(", ")}]`;
    if (!s.chosen) {
      console.log(`  // ${t.symbol}: ${s.reason}. excluded from the launch set, left null.`);
      continue;
    }
    const c = s.chosen;
    const quoteForConfig = c.quote === "eth" ? "weth" : c.quote;
    if (c.quote === "weth" || c.quote === "eth") {
      console.log(`  // ${t.symbol}: ${c.protocol} ${c.quote} pool. needs the eth/usd source to dollarize.`);
    }
    console.log("  {");
    console.log(`    id: ${t.id},`);
    console.log(`    symbol: "${t.symbol}",`);
    console.log(`    name: "${t.name}",`);
    console.log(`    address: "${t.address}",`);
    console.log(`    quote: "${quoteForConfig}",`);
    console.log(`    protocol: "${c.protocol}",`);
    console.log(`    pool: "${c.identifier}",`);
    console.log(`    invert: ${c.invert},`);
    console.log(`    baseDecimals: ${c.baseDecimals},`);
    console.log(`    quoteDecimals: ${c.quoteDecimals},`);
    console.log(`    proxies: ${proxyList},`);
    console.log(`  },`);
  }
  console.log("];");
  if (wethSelected) {
    console.log("");
    console.log("a weth or native-eth pool was selected. wire dollarization.ethUsdSource and");
    console.log("keep FLETCH_ANCHOR/ETH_USD set so the reader can dollarize it.");
  }
}

async function main(): Promise<void> {
  const rpcUrl = process.env.FLETCH_RPC_URL;
  if (!rpcUrl || rpcUrl === "") {
    console.log("fletch pool discovery (v2 + v3 + v4)");
    console.log("");
    console.log("this reads robinhood chain mainnet and will not run without an rpc url.");
    console.log("set FLETCH_RPC_URL to an alchemy or quicknode endpoint (not the public one),");
    console.log("optionally ETH_USD to dollarize weth/eth pools, and re-run:");
    console.log("");
    console.log("  FLETCH_RPC_URL=https://your-rpc-url ETH_USD=3500 pnpm discover-pools");
    console.log("");
    process.exit(0);
  }
  const ethUsdRaw = process.env.ETH_USD;
  const ethUsd = ethUsdRaw && Number.isFinite(Number(ethUsdRaw)) ? Number(ethUsdRaw) : null;

  console.log(`fletch pool discovery against ${rpcUrl.replace(/\/\/.*@/, "//")}`);
  console.log(ethUsd !== null ? `dollarizing weth/eth pools at eth/usd = ${ethUsd}` : "no ETH_USD set; weth/eth depth is not usd-comparable");

  const c = createPublicClient({ transport: http(rpcUrl, { timeout: 25_000, retryCount: 3 }) });
  const pools = await discover(c, ethUsd);
  const refs = await readAnchorReferences();
  if (refs.size > 0) console.log(`using ${refs.size} anchor reference prices for the plausibility gate`);

  if (pools.length === 0) {
    console.log("");
    console.log("no pools found for any launch token across v2, v3, and v4. nothing to add.");
    return;
  }

  const judged = judge(pools, refs);
  printTable(judged);

  const selections = tokens.map((t) => select(t, judged));
  console.log("");
  console.log("selection per token");
  for (const s of selections) {
    if (!s.chosen) {
      console.log(`  ${pad(s.token.symbol, 7)} excluded: ${s.reason}`);
    } else {
      console.log(
        `  ${pad(s.token.symbol, 7)} ${pad(s.chosen.protocol, 3)} ${pad(s.chosen.quote, 5)} ` +
          `fee ${pad(s.chosen.fee === null ? "-" : String(s.chosen.fee), 6)} depth $${fmt(s.chosen.depthUsd)} price $${fmt(s.chosen.priceUsd)}`
      );
    }
  }

  printSnippet(selections);

  console.log("");
  console.log("informational feed. not for use in liquidations, settlement, or as sole");
  console.log("pricing source. no warranty.");
}

main().catch((err) => {
  console.error("discovery failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
