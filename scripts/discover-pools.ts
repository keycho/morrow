// pool discovery for fletch.
//
// pool addresses on robinhood chain are not published as a table; they are
// resolved from the uniswap v3 factory. for each launch token this probes
// usdg and weth quotes across the 500, 3000, and 10000 fee tiers, reads each
// pool that exists, prints a table, and emits a ready-to-paste config snippet
// selecting the deepest pool per token.
//
// selection rule: fair value is dollar denominated, so a usdg-quoted pool is
// preferred whenever one exists. a weth-quoted pool needs an eth/usd rate to
// dollarize its price, and comparing usd depth to eth depth needs that same
// rate, so weth is used only when no usdg pool exists, and then flagged as
// requiring an eth/usd proxy source. within one quote, the deepest pool wins.
// a token with no pool at all is excluded from the suggested launch set.
//
// this reads mainnet, so it refuses to run without FLETCH_RPC_URL in env. it
// never falls back to the public endpoint for a bulk scan.

import {
  createPublicClient,
  http,
  parseAbi,
  zeroAddress,
  type Hex,
  type PublicClient,
} from "viem";
import { chain, quoteAssets, tokens, uniswap, type QuoteSymbol, type TokenConfig } from "@fletch/config";
import { decodeUiMultiplier, effectivePerSharePrice } from "@fletch/engine";

const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const erc20Abi = parseAbi(["function decimals() view returns (uint8)"]);
const erc8056Abi = parseAbi(["function uiMultiplier() view returns (uint256)"]);

const Q96 = 2 ** 96;

interface DiscoveredPool {
  token: TokenConfig;
  quote: QuoteSymbol;
  fee: number;
  pool: Hex;
  invert: boolean;
  perSharePrice: number;
  quoteDecimals: number;
  baseDecimals: number;
  liquidity: bigint;
  depthQuote: number;
  uiMultiplier: number;
  uiMultiplierMissing: boolean;
}

function priceAndDepth(
  sqrtPriceX96: bigint,
  liquidity: bigint,
  stockIsToken0: boolean,
  stockDec: number,
  quoteDec: number,
  multiplier: number
): { rawPrice: number; perShare: number; depthQuote: number } {
  const sp = Number(sqrtPriceX96) / Q96;
  const p = sp * sp; // token1 per token0, raw units
  const rawPrice = stockIsToken0
    ? p * 10 ** (stockDec - quoteDec)
    : (1 / p) * 10 ** (stockDec - quoteDec);
  const perShare = effectivePerSharePrice(rawPrice, multiplier);

  const L = Number(liquidity);
  const up = Math.sqrt(1.02);
  const dn = Math.sqrt(0.98);
  let depthRaw = 0;
  if (L > 0 && sp > 0) {
    depthRaw = stockIsToken0
      ? L * sp * (up - 1) + L * sp * (1 - dn)
      : (L / sp) * (1 / dn - 1) + (L / sp) * (1 - 1 / up);
  }
  return { rawPrice, perShare, depthQuote: depthRaw / 10 ** quoteDec };
}

async function discover(client: PublicClient): Promise<DiscoveredPool[]> {
  const quoteList: QuoteSymbol[] = ["usdg", "weth"];

  // step 1: getPool for every token x quote x fee.
  const combos: { token: TokenConfig; quote: QuoteSymbol; fee: number }[] = [];
  for (const token of tokens) {
    for (const quote of quoteList) {
      for (const fee of uniswap.feeTiers) {
        combos.push({ token, quote, fee });
      }
    }
  }
  const poolResults = await client.multicall({
    multicallAddress: chain.multicall3,
    allowFailure: true,
    contracts: combos.map((c) => ({
      address: uniswap.factory,
      abi: factoryAbi,
      functionName: "getPool" as const,
      args: [c.token.address, quoteAssets[c.quote].address, c.fee],
    })),
  });

  const existing: { token: TokenConfig; quote: QuoteSymbol; fee: number; pool: Hex }[] = [];
  poolResults.forEach((res, i) => {
    const combo = combos[i]!;
    if (res.status === "success") {
      const pool = res.result as Hex;
      if (pool && pool.toLowerCase() !== zeroAddress) {
        existing.push({ ...combo, pool });
      }
    }
  });

  if (existing.length === 0) return [];

  // step 2: read each pool (slot0, liquidity, ordering) plus token decimals
  // and the stock token ui multiplier.
  const perPoolContracts = existing.flatMap((e) => [
    { address: e.pool, abi: poolAbi, functionName: "slot0" as const },
    { address: e.pool, abi: poolAbi, functionName: "liquidity" as const },
    { address: e.pool, abi: poolAbi, functionName: "token0" as const },
    { address: e.pool, abi: poolAbi, functionName: "token1" as const },
    { address: e.token.address, abi: erc20Abi, functionName: "decimals" as const },
    { address: quoteAssets[e.quote].address, abi: erc20Abi, functionName: "decimals" as const },
    { address: e.token.address, abi: erc8056Abi, functionName: "uiMultiplier" as const },
  ]);
  const poolData = await client.multicall({
    multicallAddress: chain.multicall3,
    allowFailure: true,
    contracts: perPoolContracts,
  });

  const out: DiscoveredPool[] = [];
  existing.forEach((e, idx) => {
    const base = idx * 7;
    const slot0 = poolData[base];
    const liq = poolData[base + 1];
    const t0 = poolData[base + 2];
    const t1 = poolData[base + 3];
    const stockDecRes = poolData[base + 4];
    const quoteDecRes = poolData[base + 5];
    const multRes = poolData[base + 6];

    if (
      !slot0 || slot0.status !== "success" ||
      !liq || liq.status !== "success" ||
      !t0 || t0.status !== "success" ||
      !t1 || t1.status !== "success"
    ) {
      console.log(`  warn: could not read pool ${e.pool} (${e.token.symbol}/${e.quote} ${e.fee}); skipping`);
      return;
    }

    const token0 = (t0.result as Hex).toLowerCase();
    const stockIsToken0 = token0 === e.token.address.toLowerCase();
    const invert = !stockIsToken0;
    const stockDec =
      stockDecRes && stockDecRes.status === "success"
        ? Number(stockDecRes.result)
        : e.token.baseDecimals;
    const quoteDec =
      quoteDecRes && quoteDecRes.status === "success"
        ? Number(quoteDecRes.result)
        : quoteAssets[e.quote].decimals;
    const rawMult = multRes && multRes.status === "success" ? (multRes.result as bigint) : null;
    const { multiplier, missing } = decodeUiMultiplier(rawMult);

    const sqrtPriceX96 = (slot0.result as readonly [bigint, ...unknown[]])[0];
    const liquidity = liq.result as bigint;
    const { perShare, depthQuote } = priceAndDepth(
      sqrtPriceX96,
      liquidity,
      stockIsToken0,
      stockDec,
      quoteDec,
      multiplier
    );

    out.push({
      token: e.token,
      quote: e.quote,
      fee: e.fee,
      pool: e.pool,
      invert,
      perSharePrice: perShare,
      quoteDecimals: quoteDec,
      baseDecimals: stockDec,
      liquidity,
      depthQuote,
      uiMultiplier: multiplier,
      uiMultiplierMissing: missing,
    });
  });
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

interface Selection {
  token: TokenConfig;
  status: "usdg" | "weth" | "none";
  chosen?: DiscoveredPool;
}

function select(token: TokenConfig, pools: DiscoveredPool[]): Selection {
  const mine = pools.filter((p) => p.token.id === token.id);
  const usdg = mine.filter((p) => p.quote === "usdg").sort((a, b) => b.depthQuote - a.depthQuote);
  const weth = mine.filter((p) => p.quote === "weth").sort((a, b) => b.depthQuote - a.depthQuote);
  if (usdg.length > 0) return { token, status: "usdg", chosen: usdg[0] };
  if (weth.length > 0) return { token, status: "weth", chosen: weth[0] };
  return { token, status: "none" };
}

function printTable(pools: DiscoveredPool[]): void {
  console.log("");
  console.log("discovered pools");
  console.log(
    "  " +
      pad("ticker", 7) +
      pad("quote", 6) +
      pad("fee", 7) +
      pad("pool", 14) +
      pad("invert", 8) +
      pad("price/share", 14) +
      pad("~depth (quote)", 16) +
      "liquidity"
  );
  const sorted = [...pools].sort(
    (a, b) => a.token.id - b.token.id || a.quote.localeCompare(b.quote) || a.fee - b.fee
  );
  for (const p of sorted) {
    console.log(
      "  " +
        pad(p.token.symbol, 7) +
        pad(p.quote, 6) +
        pad(String(p.fee), 7) +
        pad(p.pool.slice(0, 10) + "..", 14) +
        pad(p.invert ? "true" : "false", 8) +
        pad(fmtNum(p.perSharePrice), 14) +
        pad(fmtNum(p.depthQuote), 16) +
        p.liquidity.toString()
    );
    if (p.uiMultiplierMissing) {
      console.log(`      note: ${p.token.symbol} does not expose uiMultiplier(); treated as 1`);
    } else if (Math.abs(p.uiMultiplier - 1) > 1e-6) {
      console.log(`      note: ${p.token.symbol} ui multiplier is ${p.uiMultiplier} (post corporate action)`);
    }
  }
}

function printSnippet(selections: Selection[]): void {
  const wethSelections = selections.filter((s) => s.status === "weth");

  console.log("");
  console.log("ready-to-paste config snippet (packages/config/config.ts)");
  console.log("");
  console.log("export const tokens: TokenConfig[] = [");
  for (const s of selections) {
    const t = s.token;
    const proxyList = `[${t.proxies.map((p) => `"${p}"`).join(", ")}]`;
    if (s.status === "none" || !s.chosen) {
      console.log(`  // ${t.symbol}: no uniswap v3 pool found on usdg or weth. excluded from the launch set.`);
      continue;
    }
    const c = s.chosen;
    if (s.status === "weth") {
      console.log(`  // ${t.symbol}: no usdg pool. weth pool selected, but the engine needs an`);
      console.log(`  // eth/usd proxy source to dollarize this price before it can be tracked.`);
    }
    console.log("  {");
    console.log(`    id: ${t.id},`);
    console.log(`    symbol: "${t.symbol}",`);
    console.log(`    name: "${t.name}",`);
    console.log(`    address: "${t.address}",`);
    console.log(`    quote: "${c.quote}",`);
    console.log(`    pool: "${c.pool}",`);
    console.log(`    invert: ${c.invert},`);
    console.log(`    baseDecimals: ${c.baseDecimals},`);
    console.log(`    quoteDecimals: ${c.quoteDecimals},`);
    console.log(`    proxies: ${proxyList},`);
    console.log(`  },`);
  }
  console.log("];");

  if (wethSelections.length > 0) {
    console.log("");
    console.log("required extra proxy sources for the weth-quoted tokens above.");
    console.log("add an eth/usd source and reference it from each weth token's proxies list,");
    console.log("and wire the dollarization step before tracking these tokens:");
    console.log("");
    console.log("  {");
    console.log('    name: "PROXY_ETHUSD",');
    console.log('    symbol: "ethusd",');
    console.log('    url: "https://PROXY_SOURCE_URL_ETHUSD",');
    console.log('    jsonPath: "REPLACE.WITH.PATH",');
    console.log("    weight: 1,");
    console.log("    timeoutMs: 5000,");
    console.log("    retries: 2,");
    console.log("    stalenessMs: 180000,");
    console.log("  },");
  }
}

async function main(): Promise<void> {
  const rpcUrl = process.env.FLETCH_RPC_URL;
  if (!rpcUrl || rpcUrl === "") {
    console.log("fletch pool discovery");
    console.log("");
    console.log("this reads robinhood chain mainnet and will not run without an rpc url.");
    console.log("set FLETCH_RPC_URL to an alchemy or quicknode robinhood chain endpoint");
    console.log("(not the public one) and re-run:");
    console.log("");
    console.log("  FLETCH_RPC_URL=https://your-rpc-url pnpm discover-pools");
    console.log("");
    process.exit(0);
  }

  console.log(`fletch pool discovery against ${rpcUrl.replace(/\/\/.*@/, "//")}`);
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 3 }) });

  const pools = await discover(client);
  if (pools.length === 0) {
    console.log("");
    console.log("no pools found for any launch token across usdg/weth and the 500/3000/10000");
    console.log("fee tiers. nothing to add to the launch set yet.");
    return;
  }

  printTable(pools);

  const selections = tokens.map((t) => select(t, pools));

  console.log("");
  console.log("selection per token");
  for (const s of selections) {
    if (s.status === "none" || !s.chosen) {
      console.log(`  ${pad(s.token.symbol, 7)} no pool, excluded from the launch set`);
    } else {
      console.log(
        `  ${pad(s.token.symbol, 7)} ${pad(s.chosen.quote, 5)} fee ${pad(String(s.chosen.fee), 6)} ` +
          `depth ~${fmtNum(s.chosen.depthQuote)} ${s.status === "weth" ? "(weth, needs eth/usd proxy)" : ""}`
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
