// morrow configuration. the single source of truth.
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
  chainId: envNum("MORROW_CHAIN_ID", 4663),
  // public endpoint is rate limited. for production set MORROW_RPC_URL to an
  // alchemy or quicknode robinhood chain url. the indexer should not run
  // against the public endpoint.
  rpcUrl: env("MORROW_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  explorerBaseUrl: env("MORROW_EXPLORER_URL", "https://robinhoodchain.blockscout.com"),
  // blockscout verifier base for forge contract verification.
  verifierUrl: env("MORROW_VERIFIER_URL", "https://robinhoodchain.blockscout.com/api/"),
  // informational. used to sanity-check block timestamp drift, not for math.
  expectedBlockTimeMs: 100,
  // canonical multicall3, deployed at the same create2 address on every chain
  // and verified present on robinhood chain. this is what viem's
  // client.multicall speaks (aggregate3); the reader and pool discovery use
  // it. it is not the uniswap interface multicall in `uniswap` below, which
  // has a different, incompatible abi.
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11" as `0x${string}`,
  // PLACEHOLDER: MorrowCommits contract address, known after deploy (see
  // SETUP.md). the publisher handles this being unset gracefully.
  commitsContract: env("MORROW_COMMITS_ADDRESS", "0xMORROW_COMMITS_PLACEHOLDER") as `0x${string}`,
} as const;

// ---------------------------------------------------------------------------
// uniswap v3 on robinhood chain. verified from developers.uniswap.org
// (robinhood chain deployments). v2, v3, v4, and uniswapx are all live;
// morrow v1 reads v3 pools.
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
// uniswap v2 on robinhood chain. addresses from developers.uniswap.org and
// confirmed as deployed contracts on chain (code size greater than zero)
// during discovery. never assume a factory address; verify it.
// ---------------------------------------------------------------------------

export const uniswapV2 = {
  factory: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f" as `0x${string}`,
  router: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba" as `0x${string}`,
} as const;

// ---------------------------------------------------------------------------
// uniswap v4 on robinhood chain. v4 pools live in a singleton pool manager and
// are identified by a pool id (keccak of the pool key), not a per-pool
// address. state is read through the state-view lens by pool id. addresses
// from developers.uniswap.org and confirmed deployed on chain during
// discovery; the state-view read path was confirmed returning real slot0 and
// liquidity for existing pools before being trusted.
// ---------------------------------------------------------------------------

export const uniswapV4 = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951" as `0x${string}`,
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as `0x${string}`,
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as `0x${string}`,
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7" as `0x${string}`,
  // fee to tick-spacing pairs to probe, the standard uniswap combos.
  feeTickSpacings: [
    [500, 10],
    [3000, 60],
    [10000, 200],
  ] as const,
  // v4 represents native eth as the zero address, not weth.
  nativeCurrency: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  // morrow only tracks no-hook pools; the hook is the zero address.
  hooks: "0x0000000000000000000000000000000000000000" as `0x${string}`,
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
  indexerPollMs: envNum("MORROW_POLL_MS", 30_000),
  // fair value + commit cycle length in seconds. cycle_id = floor(unix / this).
  cycleSeconds: envNum("MORROW_CYCLE_SECONDS", 600),
  // trailing window for the onchain twap, in seconds.
  twapWindowSeconds: envNum("MORROW_TWAP_WINDOW_SECONDS", 3_600),
  // heartbeat row is written every indexer tick. /health flags the service
  // degraded when the newest heartbeat is older than this.
  heartbeatStaleMs: 120_000,
} as const;

// ---------------------------------------------------------------------------
// tracked tokens. the launch set for morrow.
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

// which venue the selected pool lives in. the reader dispatches on this.
export type PoolProtocol = "v2" | "v3" | "v4";

export interface TokenConfig {
  id: number;
  symbol: string;
  name: string;
  // erc-20 stock token address (erc-8056).
  address: `0x${string}`;
  // which quote the selected pool uses. set by discovery.
  quote: QuoteSymbol;
  // which venue the pool lives in. set by discovery.
  protocol: PoolProtocol;
  // selected pool identifier: a pool/pair address for v2 and v3, or a v4 pool
  // id (bytes32 keccak of the pool key) for v4. null until discovery fills it.
  pool: `0x${string}` | null;
  // true when the stock token is the higher-address side (token1 / currency1).
  // set by discovery.
  invert: boolean;
  // erc20 decimals of the stock token.
  baseDecimals: number;
  // erc20 decimals of the quote token. set by discovery.
  quoteDecimals: number;
  // names of proxy sources (below) that inform this token's drift component.
  proxies: string[];
}

// the launch set comes from a multi-protocol discovery run against robinhood
// chain mainnet over the full captured token universe (scripts/discover-pools.ts
// probes v2, v3, and v4 for every token in `tokens` plus every entry in
// availableStockTokens, see discoveryCandidates). the deepest usable pools are
// uniswap v4 usdg pools, identified by v4 pool id (bytes32), not a pool
// address; the reader reads them through the v4 state-view lens.
//
// the six tracked tokens below each have a real, non-empty v4 usdg pool and a
// per-share price within ~10% of the underlying at discovery (july 2026 refs:
// tsla 395 vs ~397, nvda 205, aapl 319 vs ~298, googl 355 vs ~331, meta 661,
// spy 743). depth is thin in absolute terms (1.3k-6.5k usd), well below the
// model depth floor, so the onchain weight sits near zero and fair value is
// mostly anchor plus proxy drift; that is expected and surfaced in confidence.
//
// msft and amzn had no usable pool on any venue at discovery, so they are not
// in the launch set (kept in availableStockTokens; weekly discovery still
// sweeps them and alerts if a pool appears). ids 4 and 5 are theirs and stay
// retired so leaf/db ids are never reused.
//
// not promoted, kept in availableStockTokens with real pools that did not make
// the cut: spcx (deepest pool on the network at ~15k usd, but spacex is private
// with no official market close to anchor, so the off-hours model cannot price
// it); pltr, amd, mu (thin pools, and amd/mu price well above the underlying —
// track only after a real anchor confirms them). re-run discovery before launch;
// pools and depth evolve.
export const tokens: TokenConfig[] = [
  {
    id: 1,
    symbol: "tsla",
    name: "tesla",
    address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    quote: "usdg",
    protocol: "v4",
    pool: "0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e",
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_TSLA_A"],
  },
  {
    // real v4 usdg pool, depth ~6500 usd. price ~319 usd/share is ~7% above
    // aapl's july 2026 real (~298), inside the plausibility gate; an earlier
    // config note used a stale ~235 reference and wrongly excluded this pool.
    // filled.
    id: 2,
    symbol: "aapl",
    name: "apple",
    address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    quote: "usdg",
    protocol: "v4",
    pool: "0xda4116b5894ee7479e64eae9276e1a2944ef0e5ce863a299d296a15618deee01",
    invert: true,
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
    protocol: "v4",
    pool: "0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1",
    invert: true,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_NVDA_A"],
  },
  // ids 4 (msft) and 5 (amzn) are retired: no usable pool at discovery, so they
  // are not tracked. their addresses live in availableStockTokens for weekly
  // discovery. do not reuse these ids.
  {
    // real v4 usdg pool, depth ~5600 usd. price ~355 vs ~331 real (~7%).
    // promoted from availableStockTokens after full-universe discovery.
    id: 6,
    symbol: "googl",
    name: "alphabet",
    address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
    quote: "usdg",
    protocol: "v4",
    pool: "0xef22239f96c6ac95dcd57b90c6b14c0cc8c3c16844def34daef68dc9dd945344",
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_GOOGL_A"],
  },
  {
    // real v4 usdg pool, depth ~1770 usd, price ~661. promoted from
    // availableStockTokens. confirm against a live anchor before launch.
    id: 7,
    symbol: "meta",
    name: "meta platforms",
    address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
    quote: "usdg",
    protocol: "v4",
    pool: "0x5875d407a42965b0e768c8925cea290e06fa50603ef34fc99eb92a1050e6ae36",
    invert: true,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_META_A"],
  },
  {
    // real v4 usdg pool, depth ~1290 usd, price ~743. spy is the s&p 500 etf;
    // promoted from availableStockTokens. confirm against a live anchor.
    id: 8,
    symbol: "spy",
    name: "spdr s&p 500 etf",
    address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
    quote: "usdg",
    protocol: "v4",
    pool: "0x7eeda68cd84620339e6ad4bf054af9b19878ac13139991c7aaec018c40a8bb6a",
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: ["PROXY_SPY_A"],
  },
];

// stock and etf tokens verified on chain but not (yet) in the launch set.
// captured here so the addresses live in config; discovery probes these too
// (see discoveryCandidates), and an entry is promoted into `tokens` with a
// fresh id once discovery shows it has a real, plausible, deep-enough pool.
//
// addresses from docs.robinhood.com/chain/contracts (the full deployed set as
// of july 2026); every one that overlapped the prior launch config matched
// exactly. voo and openai from the featured list are not in the contracts doc,
// so they are intentionally absent rather than guessed. same ticker at a
// different address is a fake.
// (googl, meta, spy were promoted into `tokens` after discovery found real,
// the captured robinhood chain equity universe not (yet) in the launch set.
// discovery probes these too (see discoveryCandidates), and an entry is
// promoted into `tokens` with a fresh id once discovery shows a real,
// plausible, deep-enough pool.
//
// addresses resolved from the robinhood chain explorer (blockscout) and
// cross-checked against the operator's published contract list by address
// prefix and suffix; every one is a deployed contract (code size > 0) with 18
// decimals. arm, dram, nasa, nok, rvi from that list could not be resolved to
// a full verified address and are intentionally absent rather than guessed, as
// are voo and openai (no on-chain contract found). same ticker at a different
// address is a fake.
// (googl, meta, spy were promoted into `tokens`, so they are not repeated here.)
export const availableStockTokens: Record<string, `0x${string}`> = {
  aaoi: "0x521Cf887E6531c6F667b5BC4D896E5d9bfE8EB2E",
  amat: "0x36046893810a7E7fCE501229d57dc3FC8c8716d0",
  amd: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
  amzn: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
  apld: "0xb8DBf92F9741c9ac1c32115E78581f23509916FD",
  asml: "0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA",
  asts: "0x1AF6446f07eb1d97c546AFC8c9544cBDF3AD5137",
  avgo: "0x156E175DD063a8cE274C50654eF40e0032b3fbcF",
  ba: "0x4D21483a44Bf67a86b77E3dA301411880797D452",
  baba: "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4",
  be: "0x822CC93fFD030293E9842c30BBD678F530701867",
  cbrs: "0x5c90450Bbb4273D7b2f17CF6917AEB237A569679",
  ccl: "0x9651342CeA770aE9a2969Ba2A52611523146aef9",
  celh: "0x8cF07C5A878945185d327aAa6e33FAa95F95e7bF",
  clsk: "0xcBB95BBF36099d34dA091dc6Fa6F49EfA257Cee3",
  coin: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b",
  cost: "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2",
  crcl: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5",
  crwd: "0xea72Ecca2d0f6bFA1394DBBCff85b52CD4233931",
  crwv: "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3",
  ddog: "0x27c99fBde9D0d2AA4f4Bfb4943f237843DdF6958",
  dell: "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd",
  elf: "0x39EC44Bee4F6A116c6F9B8De566848a985C53C60",
  everpure: "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D",
  ewy: "0x7f0aBeF0C07280F82c6a08ead09dEd6BAE2C13Fc",
  f: "0x25C288E6D899b9BC30160965aD9644c67e73bE0C",
  flnc: "0x282e87451E10fA6679BC7D76C69BE44cD3fC777C",
  futu: "0xeB30663bDFf0622Ef4e4E5cBb4E975F19f33f51D",
  glw: "0x7c04E6A3368F2A1DE3874f0e80d2e0A1a9915da6",
  gme: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E",
  inod: "0xf1953DAB6FaD537488d5A022361FfAa8B4c95eC6",
  intc: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681",
  intu: "0x56d23beE5f41A7120170b0c603Dae30128e460e9",
  ionq: "0x558378E000D634A36593E338eBacdd6207640EfE",
  iren: "0xF0AB0c93bE6F41369d302e55db1A96b3c430212D",
  lite: "0x8eF20885F94e3D9bc7eB3080279188Bd5ED7c08C",
  lly: "0x8005d266423c7ea827372c9c864491e5786600ea",
  lulu: "0x4e62068525Ab11FE768e29dfD00ef909B9803016",
  lunr: "0xa5D4968421bA94814Be3B136b15cf422101aC1a3",
  mdb: "0xDdf2266b79abf0B48898959B0ed6E6adf512be74",
  mrvl: "0x62fd0668e10D8B72339BE2DCF7643001688ff13B",
  mstr: "0xec262a75e413fAfD0dF80480274532C79D42da09",
  msft: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
  mu: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD",
  mxl: "0x48961813349333209994750ffA89b3c5C22eC969",
  nbis: "0x9D9c6684F596F66a64C030B93A886D51Fd4D7931",
  nflx: "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8",
  nne: "0xBEF75684C43c4ea7BD18Dd532a2244674Ee8b926",
  now: "0x0C3260aF4B8f13a69c4c2dFb84fD667890CDFa14",
  nu: "0x408c14038a04f7bD235329E26d2bf569ee20e250",
  nvts: "0xbE6702d7b70315376dC48a3293f24f0982F86386",
  orcl: "0xb0992820E760d836549ba69BC7598b4af75dEE03",
  peng: "0x9b23573b156B52565012F5cE02CDF60AFBaa70Be",
  pltr: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
  poet: "0xcf6B2D875361be807EAfa57458c80f28521F9333",
  pr: "0x4189F0c66EBBB0bfeF1C31f763131361EF32f77C",
  qbts: "0xC583c60aeF9Dc401Da72cEC1B404743a93cea1Cc",
  qcom: "0x0f17206447090e464C277571124dD2688E48AEA9",
  qqq: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
  qubt: "0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4",
  rblx: "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8",
  rddt: "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C",
  rdw: "0x92Ef19E82bD8fF36661DE838D5eaE7e5CEF0EfFE",
  rgti: "0x284358abc07F9359f19f4b5b4aC91901Be2597Ba",
  rivn: "0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B",
  rklb: "0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2",
  sats: "0x95052ddcd5DC25641657424A8Cf04834997E1730",
  sgov: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5",
  shop: "0xF53F66751B1Eff985311b693531E3290F600c410",
  slv: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f",
  smci: "0xc01aA1fECeC0605b13bc84874ff7256C0f5F562a",
  sndk: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400",
  sofi: "0x98E75885157C80992A8D41b696D8c9C6Fb30A926",
  soxx: "0x75742c18BC1f1C5c5f448f4C9D9C6F66dafAAa38",
  spcx: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa",
  spmo: "0xAd622320e520de39e72d41EF07438C3Fd3354875",
  tsem: "0x89776d4Cd68193597A2fC132cfaC1fDe36CCeA8a",
  tsm: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA",
  ttwo: "0x5e81213613b6B86EaB4c6c50d718d34359459786",
  umc: "0x0E6e67Ba88e7b5d9B67636A215c76779B948dE79",
  ups: "0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2",
  usar: "0xd917B029C761D264c6A312BBbcDA868658eF86a6",
  uso: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344",
  wday: "0x82DA4646242e1D962e96e932269Dc644c94a9CaA",
  xlk: "0x15Cd20759CE7F3285c29A319dE2D1A2e098c6f43",
  xndu: "0xA8eB3BCcbf2017eE7CBfb652eB51CF2E1B153289",
  xom: "0xf9B46d3D1B22199D4D1025a9cEDB540A33F1a2d5",
  zm: "0x44c4F142009036cF477eD2d09932051843137CF1",
  zs: "0x7dc013eB55e436f30d7ED1AFE4E36d6e45e3c3f7",
};

// reserved id range for discovery-only candidates. these never collide with a
// launch token id and never enter merkle leaves, the database, or the feed.
export const DISCOVERY_CANDIDATE_ID_BASE = 1000;

// the token universe discovery probes: the launch tokens plus every captured
// available token. available entries get reserved discovery-only ids so a run
// can report on the whole robinhood chain equity set, not just the launch
// five. discovery reads each token's real decimals, side (invert), and quote
// from chain, so the placeholder fields here are unused by it; they exist only
// to satisfy the shared TokenConfig shape. promote an entry into `tokens` with
// a real, fresh id once discovery shows a pool worth tracking.
export function discoveryCandidates(): TokenConfig[] {
  const extra: TokenConfig[] = Object.entries(availableStockTokens).map(([symbol, address], i) => ({
    id: DISCOVERY_CANDIDATE_ID_BASE + i,
    symbol,
    name: symbol,
    address,
    quote: "usdg",
    protocol: "v4",
    pool: null,
    invert: false,
    baseDecimals: 18,
    quoteDecimals: 6,
    proxies: [],
  }));
  return [...tokens, ...extra];
}

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
    name: "PROXY_GOOGL_A",
    symbol: "googl",
    url: "https://PROXY_SOURCE_URL_GOOGL_A",
    jsonPath: "REPLACE.WITH.PATH",
    weight: 1,
    timeoutMs: 5_000,
    retries: 2,
    stalenessMs: 180_000,
  },
  {
    name: "PROXY_META_A",
    symbol: "meta",
    url: "https://PROXY_SOURCE_URL_META_A",
    jsonPath: "REPLACE.WITH.PATH",
    weight: 1,
    timeoutMs: 5_000,
    retries: 2,
    stalenessMs: 180_000,
  },
  {
    name: "PROXY_SPY_A",
    symbol: "spy",
    url: "https://PROXY_SOURCE_URL_SPY_A",
    jsonPath: "REPLACE.WITH.PATH",
    weight: 1,
    timeoutMs: 5_000,
    retries: 2,
    stalenessMs: 180_000,
  },
];

// ---------------------------------------------------------------------------
// dollarization. a weth-quoted pool prices a stock token in eth, not dollars.
// fair value is dollar denominated, so a weth pool's price and depth are
// multiplied by this eth/usd source before use. the source is fetched
// alongside the proxies and stored in proxy_ticks. a stale eth/usd rate must
// never produce a published price: the reader skips a weth token when the
// rate is stale, which degrades confidence rather than dollarizing wrong.
//
// the eth/usd source is only fetched when a tracked token is weth-quoted. the
// operator wires the real endpoint (url and json path, overridable by env).
// ---------------------------------------------------------------------------

export const dollarization = {
  // a weth token whose eth/usd tick is older than this is skipped for the
  // tick (no observation stored), degrading confidence.
  stalenessMs: envNum("MORROW_ETHUSD_STALENESS_MS", 180_000),
  ethUsdSource: {
    name: "PROXY_ETHUSD",
    symbol: "ethusd",
    url: env("MORROW_ETHUSD_URL", "https://PROXY_SOURCE_URL_ETHUSD"),
    jsonPath: env("MORROW_ETHUSD_JSONPATH", "REPLACE.WITH.PATH"),
    weight: 1,
    timeoutMs: 5_000,
    retries: 2,
    stalenessMs: envNum("MORROW_ETHUSD_STALENESS_MS", 180_000),
  } as ProxySourceConfig,
} as const;

// ---------------------------------------------------------------------------
// discovery. thresholds for scripts/discover-pools.ts when it selects a pool
// across venues.
// ---------------------------------------------------------------------------

export const discovery = {
  // flag a pool whose per-share price deviates more than this from the anchor
  // reference (when one is available). an implausible pool is never selected
  // silently.
  plausibilityDeviation: envNum("MORROW_DISCOVERY_PLAUSIBILITY", 0.25),
  // a pool with less than this dollar depth is treated as empty and never
  // selected.
  emptyDepthUsd: envNum("MORROW_DISCOVERY_EMPTY_DEPTH_USD", 1),
  // prefer a usdg pool when its dollar depth is at least this fraction of the
  // deepest pool found for the token, since fair value is dollar denominated.
  usdgComparableFactor: 0.5,
  // a configured pool whose dollar depth stays below this for this many
  // consecutive weekly runs raises an ops alert (the pool is drying up). this
  // is a low drying-up floor, distinct from the model depth floor that scales
  // the onchain weight; launch pools already sit below the model floor, so
  // alerting on that would be constant noise.
  depthAlertFloorUsd: envNum("MORROW_DISCOVERY_DEPTH_ALERT_USD", 500),
  depthBelowFloorRuns: envNum("MORROW_DISCOVERY_DEPTH_ALERT_RUNS", 3),
  // weekly scheduled discovery run in the indexer worker.
  schedule: {
    autoWeekly: envBool("MORROW_DISCOVERY_AUTO", true),
    // day of week in America/New_York (1 = monday) and the hour to run at.
    weekday: envNum("MORROW_DISCOVERY_WEEKDAY", 1),
    hourEt: envNum("MORROW_DISCOVERY_HOUR_ET", 12),
  },
} as const;

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

  // stale anchor. when the model anchor is older than the most recent
  // official close (an expected close print was missed), the engine keeps
  // producing a number but caps confidence and widens the band for the cycle.
  anchorStale: {
    bandWidenPct: 0.02,
    maxConfidence: 60,
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
// anchors. the last official close per token is the model anchor; the
// next-open print feeds accuracy. the indexer can insert both automatically
// on a schedule, or the operator can insert them by hand via the admin
// endpoints (which stay as the override path).
//
// each token gets a generic http anchor source: a close url and an open url
// (url templates the operator fills), a json path to the price, and a name.
// same shape as the proxy fetcher so the http client is shared. the operator
// wires the real quote endpoints; a mock source with realistic fixtures runs
// in mock mode.
// ---------------------------------------------------------------------------

export interface AnchorSourceConfig {
  name: string;
  symbol: string;
  // url templates. {symbol} -> token symbol as-is, {SYMBOL} -> uppercased
  // (finnhub and most quote apis want uppercase tickers), {apiKey} ->
  // anchors.apiKey (from env, never hardcoded).
  closeUrl: string;
  openUrl: string;
  // default json path to the price. used when the per-kind override below is
  // not set.
  jsonPath: string;
  // optional per-kind overrides. a single endpoint (e.g. finnhub /quote)
  // returns both the previous close and the open, at different fields, so the
  // close and open anchors read different paths from the same response.
  closeJsonPath?: string;
  openJsonPath?: string;
  timeoutMs: number;
  retries: number;
}

export const anchors = {
  // master switch for the automated scheduler. off by default; the manual
  // admin endpoints work regardless.
  automatedSource: envBool("MORROW_ANCHOR_AUTOMATED", false),
  // api key for the anchor quote source (finnhub), substituted into the url
  // templates as {apiKey}. secret: env only, never hardcoded or committed.
  apiKey: env("ANCHOR_API_KEY", ""),
  schedule: {
    // insert the close anchor this many minutes after the 16:00 (or 13:00 on
    // half days) et close, and the open print this many minutes after 09:30.
    closeDelayMinutes: envNum("MORROW_ANCHOR_CLOSE_DELAY_MIN", 15),
    openDelayMinutes: envNum("MORROW_ANCHOR_OPEN_DELAY_MIN", 5),
    // if an anchor is still missing this many hours after its target, alert.
    missedDeadlineHours: envNum("MORROW_ANCHOR_MISSED_HOURS", 2),
    // grace before an older-than-last-close anchor is treated as stale by the
    // engine, so the normal insertion window does not flap the flag.
    staleGraceMinutes: envNum("MORROW_ANCHOR_STALE_GRACE_MIN", 30),
  },
  // reject an automated anchor that deviates more than this from the previous
  // anchor of the same kind, unless the token had a corporate action.
  deviationThreshold: 0.15,
  // look back this far for a corporate action when validating a large jump.
  corporateActionLookbackHours: 48,
  sources: [
    // all six launch tokens (tsla, aapl, nvda, googl, meta, spy) are wired to
    // finnhub's /quote endpoint: one call returns the previous close (pc) for
    // the close anchor and the day's open (o) for the open anchor. {SYMBOL} is
    // the uppercased ticker, {apiKey} is anchors.apiKey from env.
    {
      name: "ANCHOR_TSLA",
      symbol: "tsla",
      closeUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      openUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      jsonPath: "pc",
      closeJsonPath: "pc",
      openJsonPath: "o",
      timeoutMs: 8_000,
      retries: 3,
    },
    {
      name: "ANCHOR_AAPL",
      symbol: "aapl",
      closeUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      openUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      jsonPath: "pc",
      closeJsonPath: "pc",
      openJsonPath: "o",
      timeoutMs: 8_000,
      retries: 3,
    },
    {
      name: "ANCHOR_NVDA",
      symbol: "nvda",
      closeUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      openUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      jsonPath: "pc",
      closeJsonPath: "pc",
      openJsonPath: "o",
      timeoutMs: 8_000,
      retries: 3,
    },
    {
      name: "ANCHOR_GOOGL",
      symbol: "googl",
      closeUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      openUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      jsonPath: "pc",
      closeJsonPath: "pc",
      openJsonPath: "o",
      timeoutMs: 8_000,
      retries: 3,
    },
    {
      name: "ANCHOR_META",
      symbol: "meta",
      closeUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      openUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      jsonPath: "pc",
      closeJsonPath: "pc",
      openJsonPath: "o",
      timeoutMs: 8_000,
      retries: 3,
    },
    {
      name: "ANCHOR_SPY",
      symbol: "spy",
      closeUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      openUrl: "https://finnhub.io/api/v1/quote?symbol={SYMBOL}&token={apiKey}",
      jsonPath: "pc",
      closeJsonPath: "pc",
      openJsonPath: "o",
      timeoutMs: 8_000,
      retries: 3,
    },
  ] as AnchorSourceConfig[],
} as const;

export function anchorSourceFor(symbol: string): AnchorSourceConfig | undefined {
  return anchors.sources.find((s) => s.symbol === symbol.toLowerCase());
}

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
// ops alerting. how often the same alert condition may re-notify. ops
// hardening (task 3) extends this with the telegram transports.
// ---------------------------------------------------------------------------

export const ops = {
  alertCooldownMs: envNum("MORROW_OPS_COOLDOWN_MS", 1_800_000),
  // page when the indexer heartbeat is older than this many cycles.
  heartbeatStaleCycles: envNum("MORROW_OPS_HEARTBEAT_STALE_CYCLES", 3),
  // page after this many consecutive ticks with rpc/pool read failures.
  rpcFailureTicks: envNum("MORROW_OPS_RPC_FAILURE_TICKS", 3),
  // page when the publisher wallet balance drops below this many eth; the
  // alert estimates gas runway from gasPerCommitEth.
  publisherBalanceFloorEth: envNum("MORROW_OPS_PUBLISHER_FLOOR_ETH", 0.01),
  gasPerCommitEth: envNum("MORROW_OPS_GAS_PER_COMMIT_ETH", 0.0002),
  // api 5xx spike: page when this many 5xx responses occur within the window.
  api5xxWindowMs: envNum("MORROW_OPS_5XX_WINDOW_MS", 60_000),
  api5xxThreshold: envNum("MORROW_OPS_5XX_THRESHOLD", 5),
  // how often the api ops monitor polls its conditions.
  monitorIntervalMs: envNum("MORROW_OPS_MONITOR_INTERVAL_MS", 60_000),
} as const;

// ---------------------------------------------------------------------------
// spreads. the dashboard color-codes the onchain-vs-fair spread by these
// absolute-percent thresholds. the api echoes them so the client stays
// config-driven.
// ---------------------------------------------------------------------------

export const spreads = {
  // amber at or above this absolute spread percent, red at or above bigPct.
  warnPct: envNum("MORROW_SPREAD_WARN_PCT", 1),
  bigPct: envNum("MORROW_SPREAD_BIG_PCT", 2),
} as const;

// ---------------------------------------------------------------------------
// telegram. the public divergence alert channel. bot token and chat id are
// secrets and come from env only. dry_run logs instead of sending and is on
// by default until the operator sets the token. the private ops channel is
// added by ops hardening (task 3).
// ---------------------------------------------------------------------------

export const telegram = {
  public: {
    // api the alert worker polls for spreads.
    apiUrl: env("MORROW_API_URL", "http://localhost:8080"),
    pollMs: envNum("MORROW_TG_POLL_MS", 60_000),
    // absolute spread percent that triggers an alert.
    alertThresholdPct: envNum("MORROW_TG_THRESHOLD_PCT", 2),
    // re-arm only after the spread falls below threshold times this fraction,
    // so oscillation around the threshold does not spam.
    rearmFraction: 0.5,
    // minimum time between alerts for the same token.
    cooldownMs: envNum("MORROW_TG_COOLDOWN_MS", 1_800_000),
    // dashboard base url for the token link in the message.
    webUrl: env("MORROW_PUBLIC_WEB_URL", ""),
    // secrets. env only.
    botToken: env("TELEGRAM_PUBLIC_BOT_TOKEN", ""),
    chatId: env("TELEGRAM_PUBLIC_CHAT_ID", ""),
    // log instead of send. on by default until the token is set.
    dryRun: envBool("TELEGRAM_DRY_RUN", true),
    // one-line footer on every message. data statements only, no advice.
    footer: "informational feed, not trading advice",
  },
  // private ops channel. separate token and chat from the public one. dry_run
  // on by default. secrets from env only.
  ops: {
    botToken: env("TELEGRAM_OPS_BOT_TOKEN", ""),
    chatId: env("TELEGRAM_OPS_CHAT_ID", ""),
    dryRun: envBool("TELEGRAM_OPS_DRY_RUN", true),
  },
} as const;

// ---------------------------------------------------------------------------
// receipts. weekly accuracy cards (markdown + a rendered png). generated only,
// never auto-posted. the worker generates last week's card on the configured
// day after the open anchors land.
// ---------------------------------------------------------------------------

export const receipts = {
  // when true, the indexer generates the weekly receipt on schedule.
  autoGenerate: envBool("MORROW_RECEIPTS_AUTO", true),
  // day of week to generate on, in America/New_York (1 = monday).
  generateWeekday: envNum("MORROW_RECEIPTS_WEEKDAY", 1),
  // minutes after the 09:30 et open to wait before generating, so the open
  // anchors have landed.
  generateAfterOpenMinutes: envNum("MORROW_RECEIPTS_AFTER_OPEN_MIN", 30),
} as const;

// ---------------------------------------------------------------------------
// shared copy. the disclaimer rides on every api response and the dashboard
// footer. lowercase everywhere by design.
// ---------------------------------------------------------------------------

export const disclaimer =
  "informational feed. not for use in liquidations, settlement, or as sole pricing source. no warranty.";

export const branding = {
  name: "morrow",
  // morrow means the next morning: every price is implicitly a claim about
  // tomorrow's open.
  tagline: "what stocks are worth when the market is closed",
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

// true when any tracked token is priced in a weth pool and therefore needs
// the eth/usd source to dollarize.
export function wethTokensPresent(): boolean {
  return tokens.some((t) => t.quote === "weth");
}

// the sources the indexer fetches each tick: the per-token proxies, plus the
// eth/usd source when a weth-quoted token is tracked.
export function activeFetchSources(): ProxySourceConfig[] {
  return wethTokensPresent() ? [...proxySources, dollarization.ethUsdSource] : [...proxySources];
}

export function quoteAssetFor(token: TokenConfig): (typeof quoteAssets)[QuoteSymbol] {
  return quoteAssets[token.quote];
}

// startup validation. call from every service entrypoint. throws on
// unfilled placeholders unless mock mode is on.
export function assertConfigReady(): void {
  if (mockMode) return;
  const problems: string[] = [];
  if (chain.chainId === 0) problems.push("MORROW_CHAIN_ID is not set");
  if (chain.rpcUrl.includes("PLACEHOLDER")) problems.push("MORROW_RPC_URL is not set");
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
