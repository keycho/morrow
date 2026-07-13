// fletch configuration. the single source of truth.
//
// every chain address, rpc url, tracked token, cycle timing value, and tunable
// model weight lives in this file. nothing is hardcoded anywhere else.
//
// secrets never live here. private keys and service-role keys come from env
// vars only. see .env.example at the repo root for the full documented list.
//
// chain facts and token addresses below are verified from official sources
// (docs.robinhood.com/chain/contracts, developers.uniswap.org) as of july
// 2026. pool addresses are not published as a table; they are resolved from
// the v3 factory by scripts/discover-pools.ts and pasted in per token. until
// discovery runs, each token's pool is null and live mode refuses to boot.

// ---------------------------------------------------------------------------
// env helpers. env vars override the defaults written here so deployments can
// retune without a code change. the file remains the catalog of every knob.
// ---------------------------------------------------------------------------

function env(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === "" ? fallback : raw;
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`env var ${key} is not a number: ${raw}`);
  }
  return parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// chain. robinhood chain is a permissionless arbitrum orbit l2, evm
// compatible, eth for gas, roughly 100ms blocks. verified from
// docs.robinhood.com/chain.
// ---------------------------------------------------------------------------

export const chain = {
  name: "robinhood chain",
  chainId: envNum("FLETCH_CHAIN_ID", 4663),
  // public endpoint is rate limited. for production set FLETCH_RPC_URL to an
  // alchemy or quicknode robinhood chain url. the indexer should not run
  // against the public endpoint.
  rpcUrl: env("FLETCH_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  explorerBaseUrl: env("FLETCH_EXPLORER_URL", "https://robinhoodchain.blockscout.com"),
  // blockscout verifier base for forge contract verification.
  verifierUrl: env("FLETCH_VERIFIER_URL", "https://robinhoodchain.blockscout.com/api/"),
  // informational. used to sanity-check block timestamp drift, not for math.
  expectedBlockTimeMs: 100,
  // canonical multicall3, deployed at the same create2 address on every chain
  // and verified present on robinhood chain. this is what viem's
  // client.multicall speaks (aggregate3); the reader and pool discovery use
  // it. it is not the uniswap interface multicall in `uniswap` below, which
  // has a different, incompatible abi.
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as `0x${string}`,
  // PLACEHOLDER: FletchCommits contract address, known after deploy (see
  // SETUP.md). the publisher handles this being unset gracefully.
  commitsContract: env("FLETCH_COMMITS_ADDRESS", "0xFLETCH_COMMITS_PLACEHOLDER") as `0x${string}`,
} as const;

// ---------------------------------------------------------------------------
// uniswap v3 on robinhood chain. verified from developers.uniswap.org
// (robinhood chain deployments). v2, v3, v4, and uniswapx are all live;
// fletch v1 reads v3 pools.
// ---------------------------------------------------------------------------

export const uniswap = {
  factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa" as `0x${string}`,
  quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" as `0x${string}`,
  tickLens: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468" as `0x${string}`,
  // the uniswap interface multicall (UniswapInterfaceMulticall). kept for
  // reference. note: this is not multicall3; viem's client.multicall reverts
  // against it, so the reader and discovery use chain.multicall3 instead.
  multicall: "0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3" as `0x${string}`,
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2" as `0x${string}`,
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904" as `0x${string}`,
  // fee tiers to probe during pool discovery, in hundredths of a bip.
  feeTiers: [500, 3000, 10000] as const,
} as const;

// ---------------------------------------------------------------------------
// quote assets. fair value is dollar denominated, so usdg-quoted pools are
// preferred. a weth-quoted pool would need an eth/usd proxy to dollarize
// (flagged by discovery, not wired in v1). addresses verified from
// docs.robinhood.com/chain/contracts. discovery reads the authoritative
// decimals from chain per pool.
// ---------------------------------------------------------------------------

export const quoteAssets = {
  usdg: {
    symbol: "usdg",
    // global dollar.
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as `0x${string}`,
    decimals: 6,
  },
  weth: {
    symbol: "weth",
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as `0x${string}`,
    decimals: 18,
  },
} as const;

export type QuoteSymbol = keyof typeof quoteAssets;

// ---------------------------------------------------------------------------
// timing. all cycle and polling cadence in one place.
// ---------------------------------------------------------------------------

export const timing = {
  // indexer tick: poll pools and proxy sources this often.
  indexerPollMs: envNum("FLETCH_POLL_MS", 30_000),
  // fair value + commit cycle length in seconds. cycle_id = floor(unix / this).
  cycleSeconds: envNum("FLETCH_CYCLE_SECONDS", 600),
  // trailing window for the onchain twap, in seconds.
  twapWindowSeconds: envNum("FLETCH_TWAP_WINDOW_SECONDS", 3_600),
  // heartbeat row is written every indexer tick. /health flags the service
  // degraded when the newest heartbeat is older than this.
  heartbeatStaleMs: 120_000,
} as const;

// ---------------------------------------------------------------------------
// tracked tokens. the launch set for fletch.
//
// `address` is the erc-20 stock token (an erc-8056 scaled-ui token). `pool`
// is the selected uniswap v3 pool and stays null until discovery fills it
// (scripts/discover-pools.ts prints a ready-to-paste snippet). `invert` and
// `quoteDecimals` are also set from discovery. `id` is the stable numeric id
// used in merkle leaves and the database; never reuse or renumber ids.
//
// token addresses verified from docs.robinhood.com/chain/contracts. same
// ticker at a different address is a fake.
// ---------------------------------------------------------------------------

export interface TokenConfig {
  id: number;
  symbol: string;
  name: string;
  // erc-20 stock token address (erc-8056).
  address: `0x${string}`;
  // which quote the selected pool uses. set by discovery.
  quote: QuoteSymbol;
  // selected uniswap v3 pool. null until discovery fills it.
  pool: `0x${string}` | null;
  // true when the stock token is token1 in the pool. set by discovery.
  invert: boolean;
  // erc20 decimals of the stock token.
  baseDecimals: number;
  // erc20 decimals of the quote token. set by discovery.
  quoteDecimals: number;
  // names of proxy sources (below) that inform this token's drift component.
  proxies: string[];
}

// pool, invert, and quoteDecimals below come from a discovery run against
// robinhood chain mainnet (scripts/discover-pools.ts). tsla and nvda have
// usdg pools and are filled. aapl, msft, and amzn are left null with the
// reason: re-run discovery against a production rpc before launch to confirm
// current selection and liquidity, since pools and depth evolve.
export const tokens: TokenConfig[] = [
  {
    id: 1,
    symbol: "tsla",
    name: "tesla",
    address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    quote: "usdg",
    pool: "0xf4ACdAEEB7022862A763C9B1B885e11191c889E3",
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_TSLA_A"],
  },
  {
    // no usdg pool as of discovery. a weth pool exists
    // (0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f) but a weth quote needs an
    // eth/usd proxy to dollarize before the engine can track it, which is not
    // wired in v1. left null until a usdg pool appears or dollarization is
    // added. remove aapl from the launch set to boot live without it.
    id: 2,
    symbol: "aapl",
    name: "apple",
    address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    quote: "usdg",
    pool: null,
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_AAPL_A"],
  },
  {
    id: 3,
    symbol: "nvda",
    name: "nvidia",
    address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    quote: "usdg",
    pool: "0xB944cec30Bd4175855215D767ADC81F39e5f7E2B",
    invert: true,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_NVDA_A"],
  },
  {
    // no uniswap v3 pool found on usdg or weth as of discovery. left null and
    // excluded from the live launch set until a pool exists. remove msft from
    // the launch set, or re-run discovery, before booting live.
    id: 4,
    symbol: "msft",
    name: "microsoft",
    address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
    quote: "usdg",
    pool: null,
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_MSFT_A"],
  },
  {
    // no uniswap v3 pool found on usdg or weth as of discovery. left null and
    // excluded from the live launch set until a pool exists. remove amzn from
    // the launch set, or re-run discovery, before booting live.
    id: 5,
    symbol: "amzn",
    name: "amazon",
    address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
    quote: "usdg",
    pool: null,
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_AMZN_A"],
  },
];

// stock tokens verified on chain but not in the launch set. kept here so the
// addresses are captured in config; promote an entry into `tokens` (with a
// fresh id) once its pool has liquidity worth tracking. addresses from
// docs.robinhood.com/chain/contracts.
export const availableStockTokens: Record<string, `0x${string}`> = {
  googl: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  meta: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
  amd: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
  coin: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b",
  pltr: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
  spy: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  qqq: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
};

// ---------------------------------------------------------------------------
// 24/7 proxy signals. generic http price sources that express market
// direction while the underlying market is closed. the operator wires the
// real sources. each entry is fetched on the indexer tick with its own
// timeout, retry budget, and staleness flag. a source that fails repeatedly
// trips its circuit breaker and is skipped until the cooldown passes.
//
// note: a weth-quoted token needs an eth/usd source here to dollarize its
// pool price. the launch set is usdg-quoted, so none is required yet;
// discovery flags the requirement if a token is weth-only.
// ---------------------------------------------------------------------------

export interface ProxySourceConfig {
  // unique name, referenced from TokenConfig.proxies.
  name: string;
  // which tracked token symbol this source informs.
  symbol: string;
  // http(s) endpoint returning json.
  url: string;
  // dot path to the numeric price in the response, e.g. "data.mark_price" or
  // "result.0.last". array indexes are plain numbers in the path.
  jsonPath: string;
  // relative weight inside the drift blend for this token.
  weight: number;
  timeoutMs: number;
  retries: number;
  // a tick older than this is flagged stale and contributes zero weight.
  stalenessMs: number;
}

export const proxySources: ProxySourceConfig[] = [
  // PLACEHOLDER: replace url and jsonPath per source. add or remove sources
  // freely. multiple sources per token are blended by weight.
  {
    name: "PROXY_TSLA_A",
    symbol: "tsla",
    url: "https://PROXY_SOURCE_URL_TSLA_A",
    jsonPath: "REPLACE.WITH.PATH",
    weight: 1,
    timeoutMs: 5_000,
    retries: 2,
    stalenessMs: 180_000,
  },
  {
    name: "PROXY_AAPL_A",
    symbol: "aapl",
    url: "https://PROXY_SOURCE_URL_AAPL_A",
    jsonPath: "REPLACE.WITH.PATH",
    weight: 1,
    timeoutMs: 5_000,
    retries: 2,
    stalenessMs: 180_000,
  },
  {
    name: "PROXY_NVDA_A",
    symbol: "nvda",
    url: "https://PROXY_SOURCE_URL_NVDA_A",
    jsonPath: "REPLACE.WITH.PATH",
    weight: 1,
    timeoutMs: 5_000,
    retries: 2,
    stalenessMs: 180_000,
  },
  {
    name: "PROXY_MSFT_A",
    symbol: "msft",
    url: "https://PROXY_SOURCE_URL_MSFT_A",
    jsonPath: "REPLACE.WITH.PATH",
    weight: 1,
    timeoutMs: 5_000,
    retries: 2,
    stalenessMs: 180_000,
  },
  {
    name: "PROXY_AMZN_A",
    symbol: "amzn",
    url: "https://PROXY_SOURCE_URL_AMZN_A",
    jsonPath: "REPLACE.WITH.PATH",
    weight: 1,
    timeoutMs: 5_000,
    retries: 2,
    stalenessMs: 180_000,
  },
];

// circuit breaker for proxy sources and the rpc.
export const circuitBreaker = {
  // consecutive failures before a source is opened (skipped).
  failureThreshold: 5,
  // how long an opened breaker stays open before a probe is allowed.
  cooldownMs: 300_000,
  // exponential backoff for retries inside one fetch attempt.
  backoffBaseMs: 500,
  backoffMaxMs: 8_000,
} as const;

// ---------------------------------------------------------------------------
// fair value model. every weight and threshold the engine uses.
// see packages/engine for the math and the unit tests that pin the behavior.
// ---------------------------------------------------------------------------

export const model = {
  // share of fair value taken from the onchain twap when the pool is at or
  // above full depth. the remainder comes from anchor plus drift.
  onchainWeight: 0.6,

  // pool depth floor, denominated in quote token units (usd for usdg quotes),
  // measured as the ±2% depth captured by the indexer. below this floor the
  // onchain weight scales down linearly toward zero, so a thin pool cannot
  // drag fair value. tokenized float is extremely thin at launch, so expect
  // the onchain weight to sit near zero and fair value to be mostly anchor
  // plus proxy drift. that is correct behavior; the confidence score reflects
  // it.
  depthFloorQuote: 50_000,

  // hard clamp: the onchain twap may not move fair value more than this
  // fraction away from anchor-plus-drift, regardless of weight.
  maxOnchainDeviation: 0.05,

  // spike guard: if the onchain component moved more than this fraction
  // within one cycle window while proxies were flat, the output is clamped to
  // the band edge and flagged suspect. surfaced in the api, never hidden.
  spikeThreshold: 0.10,

  // proxies within ±this return are considered flat for the spike guard.
  proxyFlatThreshold: 0.002,

  // hard cap on the absolute blended drift component.
  maxDriftAbs: 0.20,

  // confidence band. half-width as a fraction of fair value:
  // basePct + confidenceScalePct * (1 - confidence / 100).
  band: {
    basePct: 0.005,
    confidenceScalePct: 0.045,
  },

  // confidence scoring, 0 to 100. weighted sum of three subscores.
  confidence: {
    weights: {
      freshness: 0.35,
      depth: 0.35,
      proxyAgreement: 0.30,
    },
    // freshness subscore halves every this many ms of input age.
    freshnessHalfLifeMs: 120_000,
    // proxy dispersion (max pairwise return disagreement) at which the
    // agreement subscore reaches zero.
    proxyDisagreementFullPct: 0.03,
  },

  // market_open regime runs in passthrough mode: official prices are live so
  // the onchain market is trusted more and the band tightens.
  marketOpen: {
    onchainWeight: 0.9,
    bandBasePct: 0.002,
  },

  // corporate action (erc-8056 uiMultiplier change). when the multiplier
  // changes within a window (split, stock dividend), the engine excludes
  // pre-change ticks from the twap, flags the cycle, adds this to the band
  // half-width fraction, and caps confidence for that cycle.
  corporateAction: {
    bandWidenPct: 0.03,
    maxConfidence: 50,
    // relative difference between two multipliers above which they count as
    // changed. guards float round-trip noise; a real split is 2x or more.
    changeRelTolerance: 1e-6,
  },
} as const;

// ---------------------------------------------------------------------------
// market calendar. the engine implements nyse hours and us market holidays in
// America/New_York. these lists let the operator patch the calendar without
// a code change (format "yyyy-mm-dd").
// ---------------------------------------------------------------------------

export const calendar = {
  timezone: "America/New_York",
  // extra full-day closures not covered by the computed holiday rules, for
  // example a national day of mourning.
  extraHolidays: [] as string[],
  // extra half days (13:00 close) beyond the computed ones.
  extraHalfDays: [] as string[],
} as const;

// ---------------------------------------------------------------------------
// anchors. last official close per token is the model anchor. v1 is manual
// admin insert. the flag below reserves the wiring for a future automated
// source without a schema change.
// ---------------------------------------------------------------------------

export const anchors = {
  automatedSource: false,
  // when automatedSource is true the indexer will pull closes from this url
  // per token. PLACEHOLDER until an automated source is chosen.
  automatedSourceUrl: "ANCHOR_SOURCE_URL_PLACEHOLDER",
} as const;

// ---------------------------------------------------------------------------
// api. rate limits and the x402 pay-per-query skeleton.
// ---------------------------------------------------------------------------

export const api = {
  // railway injects PORT; API_PORT wins when both are set.
  port: envNum("API_PORT", envNum("PORT", 8080)),
  host: env("API_HOST", "0.0.0.0"),
  corsOrigin: env("API_CORS_ORIGIN", "*"),
  rateLimit: {
    // anonymous free tier, requests per minute per ip.
    freePerMinute: 30,
    // api key tier, requests per minute per key.
    keyedPerMinute: 300,
  },
  x402: {
    // when true, price endpoints answer 402 to unauthenticated callers with a
    // payment-required payload and accept paid requests via the verifier
    // interface. settlement wiring is intentionally out of scope.
    enabled: envBool("X402_ENABLED", false),
    // advertised price per query in usd.
    priceUsdPerQuery: 0.001,
    // PLACEHOLDER: network identifier and receiving address advertised in the
    // 402 payload. fill when wiring settlement.
    network: "X402_NETWORK_PLACEHOLDER",
    payTo: "X402_PAY_TO_PLACEHOLDER",
  },
} as const;

// ---------------------------------------------------------------------------
// shared copy. the disclaimer rides on every api response and the dashboard
// footer. lowercase everywhere by design.
// ---------------------------------------------------------------------------

export const disclaimer =
  "informational feed. not for use in liquidations, settlement, or as sole pricing source. no warranty.";

export const branding = {
  name: "fletch",
  tagline: "off-hours fair value for tokenized equities on robinhood chain",
  // ascii arrow mark used in the dashboard and docs.
  mark: ">>--->",
} as const;

// ---------------------------------------------------------------------------
// mock mode. runs the indexer against synthetic pools and proxy sources so
// the whole pipeline can be exercised before any placeholder is filled.
// ---------------------------------------------------------------------------

export const mockMode = envBool("MOCK_MODE", false);

// convenience lookups -------------------------------------------------------

export function tokenBySymbol(symbol: string): TokenConfig | undefined {
  return tokens.find((t) => t.symbol === symbol.toLowerCase());
}

export function tokenById(id: number): TokenConfig | undefined {
  return tokens.find((t) => t.id === id);
}

export function proxiesForToken(symbol: string): ProxySourceConfig[] {
  const token = tokenBySymbol(symbol);
  if (!token) return [];
  return proxySources.filter((p) => token.proxies.includes(p.name));
}

export function quoteAssetFor(token: TokenConfig): (typeof quoteAssets)[QuoteSymbol] {
  return quoteAssets[token.quote];
}

// startup validation. call from every service entrypoint. throws on
// unfilled placeholders unless mock mode is on.
export function assertConfigReady(): void {
  if (mockMode) return;
  const problems: string[] = [];
  if (chain.chainId === 0) problems.push("FLETCH_CHAIN_ID is not set");
  if (chain.rpcUrl.includes("PLACEHOLDER")) problems.push("FLETCH_RPC_URL is not set");
  for (const t of tokens) {
    if (t.pool === null) {
      problems.push(`pool for ${t.symbol} is not discovered yet (run pnpm discover-pools)`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `config is not ready for live mode. fix these or set MOCK_MODE=true:\n- ${problems.join("\n- ")}\nsee SETUP.md for the fill-in checklist.`
    );
  }
}
