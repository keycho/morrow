// pool discovery cli for morrow, across uniswap v2, v3, and v4.
//
// the discovery itself (probing every venue, pricing through the erc-8056 ui
// multiplier, judging plausibility against anchor references, and selecting a
// pool per token) lives in @morrow/discovery, shared with the indexer's weekly
// run. this file is the operator front end: it reads the rpc url from env,
// runs one pass, records it in the pool_discovery_runs dataset when a database
// is configured, and prints either a human table plus a ready-to-paste config
// snippet, or machine-readable json for tooling.
//
// this reads mainnet, so it refuses to run without MORROW_RPC_URL in env. set
// ETH_USD to dollarize weth and native-eth pools for depth comparison. pass
// --json to print the full run as json (intro logs go to stderr).

import { createPublicClient, http, type Hex } from "viem";
import pg from "pg";
import {
  DISCOVERY_CANDIDATE_ID_BASE,
  discoveryCandidates,
  redactSecrets,
  type TokenConfig,
} from "@morrow/config";
import {
  readAnchorReferences,
  runDiscovery,
  storeDiscoveryRun,
  type DiscoveryResult,
  type Judged,
  type Selection,
} from "@morrow/discovery";

// every token discovery probes, by id, so a selection (launch or available
// candidate) resolves back to its full config for the snippet.
const candidateById = new Map<number, TokenConfig>(discoveryCandidates().map((t) => [t.id, t]));
const isCandidate = (id: number): boolean => id >= DISCOVERY_CANDIDATE_ID_BASE;

// --- output helpers ---------------------------------------------------------

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
        pad(p.symbol, 7) +
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

function printSelections(selections: Selection[]): void {
  console.log("");
  console.log("selection per token (launch set + captured available tokens)");
  for (const s of selections) {
    const tag = isCandidate(s.tokenId) ? " (available)" : "";
    if (!s.chosen) {
      console.log(`  ${pad(s.symbol, 7)} excluded: ${s.reason}${tag}`);
    } else {
      console.log(
        `  ${pad(s.symbol, 7)} ${pad(s.chosen.protocol, 3)} ${pad(s.chosen.quote, 5)} ` +
          `fee ${pad(s.chosen.fee === null ? "-" : String(s.chosen.fee), 6)} depth $${fmt(s.chosen.depthUsd)} price $${fmt(s.chosen.priceUsd)}${tag}`
      );
    }
  }
}

function printTokenEntry(t: TokenConfig, c: Judged, promote: boolean): void {
  const quoteForConfig = c.quote === "eth" ? "weth" : c.quote;
  if (c.quote === "weth" || c.quote === "eth") {
    console.log(`  // ${t.symbol}: ${c.protocol} ${c.quote} pool. needs the eth/usd source to dollarize.`);
  }
  console.log("  {");
  console.log(`    id: ${promote ? "<next unused id>" : t.id},`);
  console.log(`    symbol: "${t.symbol}",`);
  console.log(`    name: "${promote ? "<full name>" : t.name}",`);
  console.log(`    address: "${t.address}",`);
  console.log(`    quote: "${quoteForConfig}",`);
  console.log(`    protocol: "${c.protocol}",`);
  console.log(`    pool: "${c.identifier}",`);
  console.log(`    invert: ${c.invert},`);
  console.log(`    baseDecimals: ${c.baseDecimals},`);
  console.log(`    quoteDecimals: ${c.quoteDecimals},`);
  console.log(`    proxies: ${promote ? "[/* wire a proxy + anchor source */]" : `[${t.proxies.map((p) => `"${p}"`).join(", ")}]`},`);
  console.log(`  },`);
}

function printSnippet(selections: Selection[]): void {
  const wethSelected = selections.some((s) => s.chosen && (s.chosen.quote === "weth" || s.chosen.quote === "eth"));

  // launch set: the current five, filled or excluded as discovery found them.
  console.log("");
  console.log("ready-to-paste config snippet — launch set (packages/config/config.ts)");
  console.log("");
  console.log("export const tokens: TokenConfig[] = [");
  for (const s of selections.filter((x) => !isCandidate(x.tokenId))) {
    const t = candidateById.get(s.tokenId);
    if (!t) continue;
    if (!s.chosen) {
      console.log(`  // ${t.symbol}: ${s.reason}. excluded from the launch set, left null.`);
      continue;
    }
    printTokenEntry(t, s.chosen, false);
  }
  console.log("];");

  // promotable available tokens: those with a real, plausible pool that are
  // not yet in the launch set. assign a fresh id and wire sources to add them.
  const promotable = selections.filter((s) => isCandidate(s.tokenId) && s.chosen);
  if (promotable.length > 0) {
    console.log("");
    console.log(`promotable available tokens (${promotable.length}) — a real pool exists, not yet tracked.`);
    console.log("give each a fresh unused id and wire a proxy + anchor source, then move into tokens:");
    console.log("");
    for (const s of promotable) {
      const t = candidateById.get(s.tokenId);
      if (t && s.chosen) printTokenEntry(t, s.chosen, true);
    }
  }

  if (wethSelected) {
    console.log("");
    console.log("a weth or native-eth pool was selected. wire dollarization.ethUsdSource and");
    console.log("keep MORROW_ANCHOR/ETH_USD set so the reader can dollarize it.");
  }
}

function printHuman(result: DiscoveryResult): void {
  if (result.judged.length === 0) {
    console.log("");
    console.log("no pools found for any launch token across v2, v3, and v4. nothing to add.");
    return;
  }
  printTable(result.judged);
  printSelections(result.selections);
  printSnippet(result.selections);
  console.log("");
  console.log("informational feed. not for use in liquidations, settlement, or as sole");
  console.log("pricing source. no warranty.");
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  // in json mode all human output goes to stderr so stdout is pure json.
  const note = json ? console.error : console.log;

  const rpcUrl = process.env.MORROW_RPC_URL;
  if (!rpcUrl || rpcUrl === "") {
    note("morrow pool discovery (v2 + v3 + v4)");
    note("");
    note("this reads robinhood chain mainnet and will not run without an rpc url.");
    note("set MORROW_RPC_URL to an alchemy or quicknode endpoint (not the public one),");
    note("optionally ETH_USD to dollarize weth/eth pools, and re-run:");
    note("");
    note("  MORROW_RPC_URL=https://your-rpc-url ETH_USD=3500 pnpm discover-pools");
    note("");
    // json callers get a non-zero exit so a missing rpc is not read as "no pools".
    process.exit(json ? 1 : 0);
  }
  const ethUsdRaw = process.env.ETH_USD;
  const ethUsd = ethUsdRaw && Number.isFinite(Number(ethUsdRaw)) ? Number(ethUsdRaw) : null;

  note(`morrow pool discovery against ${redactSecrets(rpcUrl)}`);
  note(
    ethUsd !== null
      ? `dollarizing weth/eth pools at eth/usd = ${ethUsd}`
      : "no ETH_USD set; weth/eth depth is not usd-comparable"
  );

  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 25_000, retryCount: 3 }) });

  // the anchor reference (plausibility gate) and the run dataset both use the
  // database when one is configured. discovery still runs without it.
  const dbUrl = process.env.DATABASE_URL;
  const pool = dbUrl ? new pg.Pool({ connectionString: dbUrl, max: 2 }) : null;
  try {
    const refs = pool ? await readAnchorReferences(pool) : new Map<number, number>();
    if (refs.size > 0) note(`using ${refs.size} anchor reference prices for the plausibility gate`);

    const result = await runDiscovery(client, ethUsd, refs);

    if (pool) {
      await storeDiscoveryRun(pool, result);
      note("recorded this run in pool_discovery_runs");
    }

    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      printHuman(result);
    }
  } finally {
    if (pool) await pool.end();
  }
}

main().catch((err) => {
  console.error("discovery failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
