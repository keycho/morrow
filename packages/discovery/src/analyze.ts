// analysis of discovery runs against the current config, producing the ops
// findings the indexer's weekly run turns into alerts. pure functions of the
// stored run history and the config; no i/o, so this is unit-tested directly.
//
// two conditions matter:
//   (a) a usable pool now exists for a token that has no configured pool. the
//       operator should review and, if it checks out, add it to config.
//   (b) a configured pool's dollar depth has stayed below the alert floor for
//       a sustained window of runs. the pool is drying up.
// discovery never edits config; it only surfaces these for the operator.

import { discovery, type TokenConfig } from "@morrow/config";
import type { DiscoveryResult } from "./types.js";

export type DiscoveryFindingKind = "new-pool" | "depth-below-floor";

export interface DiscoveryFinding {
  kind: DiscoveryFindingKind;
  tokenId: number;
  symbol: string;
  message: string;
  detail: Record<string, unknown>;
}

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "unknown";
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// the dollar depth of the token's currently-configured pool as seen in a run,
// or null when the pool is not configured or was not observed in that run.
function configuredDepthUsd(result: DiscoveryResult, token: TokenConfig): number | null {
  if (token.pool === null) return null;
  const target = token.pool.toLowerCase();
  const match = result.judged.find(
    (p) => p.tokenId === token.id && p.identifier.toLowerCase() === target
  );
  return match ? match.depthUsd : null;
}

// recentResults: most recent first, index 0 is the run that just completed.
export function analyzeDiscovery(
  recentResults: DiscoveryResult[],
  cfgTokens: readonly TokenConfig[]
): DiscoveryFinding[] {
  const findings: DiscoveryFinding[] = [];
  const current = recentResults[0];
  if (!current) return findings;

  for (const token of cfgTokens) {
    const selection = current.selections.find((s) => s.tokenId === token.id);

    // (a) new usable pool for an unconfigured token.
    if (token.pool === null) {
      if (selection?.chosen) {
        const c = selection.chosen;
        findings.push({
          kind: "new-pool",
          tokenId: token.id,
          symbol: token.symbol,
          message: `usable ${c.protocol} ${c.quote} pool found for ${token.symbol} (unconfigured), depth ~$${fmtUsd(c.depthUsd)}`,
          detail: {
            protocol: c.protocol,
            quote: c.quote,
            identifier: c.identifier,
            depthUsd: c.depthUsd,
            priceUsd: c.priceUsd,
            reason: selection.reason,
          },
        });
      }
      continue;
    }

    // (b) configured pool depth below the floor for the sustained window.
    const need = discovery.depthBelowFloorRuns;
    const window = recentResults.slice(0, need).map((r) => configuredDepthUsd(r, token));
    const sustainedLow =
      window.length >= need && window.every((d) => d !== null && d < discovery.depthAlertFloorUsd);
    if (sustainedLow) {
      findings.push({
        kind: "depth-below-floor",
        tokenId: token.id,
        symbol: token.symbol,
        message: `${token.symbol} configured pool depth below $${fmtUsd(discovery.depthAlertFloorUsd)} for ${need} consecutive runs`,
        detail: {
          pool: token.pool,
          floorUsd: discovery.depthAlertFloorUsd,
          runs: need,
          depthsUsd: window,
        },
      });
    }
  }
  return findings;
}
