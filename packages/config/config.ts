// fletch configuration. the single source of truth.
//
// every chain address, rpc url, tracked token, cycle timing value, and tunable
// model weight lives in this file. nothing is hardcoded anywhere else.
//
// secrets never live here. private keys and service-role keys come from env
// vars only. see .env.example at the repo root for the full documented list.
//
// values that must be discovered from official robinhood chain docs or
// supplied by the operator are obvious uppercase placeholders. SETUP.md lists
// every one of them in fill-in order. do not guess these values.

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
// compatible, eth for gas, roughly 100ms blocks.
// ---------------------------------------------------------------------------

export const chain = {
  name: "robinhood chain",
  // PLACEHOLDER: fill FLETCH_CHAIN_ID in .env from official robinhood chain
  // docs. 0 is an invalid chain id and will fail loudly at startup.
  chainId: envNum("FLETCH_CHAIN_ID", 0),
  // PLACEHOLDER: fill FLETCH_RPC_URL in .env from official robinhood chain
  // docs. https json-rpc endpoint.
  rpcUrl: env("FLETCH_RPC_URL", "RPC_URL_PLACEHOLDER"),
  // PLACEHOLDER: block explorer base url, used for tx links in the dashboard.
  explorerBaseUrl: env("FLETCH_EXPLORER_URL", "EXPLORER_URL_PLACEHOLDER"),
  // informational. used to sanity-check block timestamp drift, not for math.
  expectedBlockTimeMs: 100,
  // PLACEHOLDER: FletchCommits contract address, known after deploy (phase 4
  // of SETUP.md).
  commitsContract: env("FLETCH_COMMITS_ADDRESS", "0xFLETCH_COMMITS_PLACEHOLDER") as `0x${string}`,
} as const;

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
  // a proxy tick older than its source stalenessMs is flagged stale and its
  // weight is zeroed in the drift blend.
} as const;

// ---------------------------------------------------------------------------
// tracked tokens. uniswap v3 pools on robinhood chain.
// pool addresses must come from official robinhood chain docs, defillama, or
// dune. never guessed. `id` is the stable numeric id used in merkle leaves
// and the database. never reuse or renumber ids.
// ---------------------------------------------------------------------------

export interface TokenConfig {
  id: number;
  symbol: string;
  name: string;
  // uniswap v3 pool address for token/quote on robinhood chain.
  pool: `0x${string}`;
  // if the stock token is token1 in the pool, set invert true so spot is
  // always quoted as quote-per-stock-token.
  invert: boolean;
  // erc20 decimals of the stock token.
  baseDecimals: number;
  // erc20 decimals of the quote token (usdc is 6).
  quoteDecimals: number;
  // names of proxy sources (below) that inform this token's drift component.
  proxies: string[];
}

export const tokens: TokenConfig[] = [
  {
    id: 1,
    symbol: "tsla",
    name: "tesla",
    pool: "0xPOOL_TSLA",
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_TSLA_A"],
  },
  {
    id: 2,
    symbol: "aapl",
    name: "apple",
    pool: "0xPOOL_AAPL",
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_AAPL_A"],
  },
  {
    id: 3,
    symbol: "nvda",
    name: "nvidia",
    pool: "0xPOOL_NVDA",
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_NVDA_A"],
  },
  {
    id: 4,
    symbol: "msft",
    name: "microsoft",
    pool: "0xPOOL_MSFT",
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_MSFT_A"],
  },
  {
    id: 5,
    symbol: "amzn",
    name: "amazon",
    pool: "0xPOOL_AMZN",
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_AMZN_A"],
  },
];

// ---------------------------------------------------------------------------
// 24/7 proxy signals. generic http price sources that express market
// direction while the underlying market is closed. the operator wires the
// real sources. each entry is fetched on the indexer tick with its own
// timeout, retry budget, and staleness flag. a source that fails repeatedly
// trips its circuit breaker and is skipped until the cooldown passes.
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

  // pool depth floor, denominated in quote token units (usd for usdc quotes),
  // measured as the ±2% depth captured by the indexer. below this floor the
  // onchain weight scales down linearly toward zero, so a thin pool cannot
  // drag fair value.
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
  port: envNum("API_PORT", 8080),
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

// startup validation. call from every service entrypoint. throws on
// unfilled placeholders unless mock mode is on.
export function assertConfigReady(): void {
  if (mockMode) return;
  const problems: string[] = [];
  if (chain.chainId === 0) problems.push("FLETCH_CHAIN_ID is not set");
  if (chain.rpcUrl.includes("PLACEHOLDER")) problems.push("FLETCH_RPC_URL is not set");
  for (const t of tokens) {
    if (t.pool.includes("POOL_")) problems.push(`pool address for ${t.symbol} is a placeholder`);
  }
  if (problems.length > 0) {
    throw new Error(
      `config is not ready for live mode. fix these or set MOCK_MODE=true:\n- ${problems.join("\n- ")}\nsee SETUP.md for the fill-in checklist.`
    );
  }
}
