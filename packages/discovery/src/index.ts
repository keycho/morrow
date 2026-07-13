// @fletch/discovery public surface. multi-protocol pool discovery (uniswap v2,
// v3, v4) shared by the discover-pools cli and the indexer's weekly run.

export {
  discoverPools,
  judgePools,
  selectPool,
  runDiscovery,
} from "./discover.js";

export {
  type DiscoveryFinding,
  type DiscoveryFindingKind,
  analyzeDiscovery,
} from "./analyze.js";

export {
  readAnchorReferences,
  storeDiscoveryRun,
  recentDiscoveryResults,
  lastDiscoveryRunAt,
} from "./store.js";

export type { DiscoveredPool, Judged, Selection, DiscoveryResult, QuoteDef } from "./types.js";
