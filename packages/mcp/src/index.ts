#!/usr/bin/env node
// morrow mcp server. read-only tools over the morrow api, plus independent
// merkle verification against the on-chain commit registry.
//
// configuration (env):
//   MORROW_API_URL           base url of the morrow api (required)
//   MORROW_API_KEY           optional api key, sent as x-api-key
//   MORROW_RPC_URL           optional robinhood chain rpc for on-chain checks
//   MORROW_COMMITS_ADDRESS   optional contract override; defaults to the
//                            address advertised in the proof payload
//
// this package is standalone on purpose: the merkle math is reimplemented
// here (sorted-pair keccak256, promoted odd nodes) so verification does not
// trust any morrow code path that produced the data.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  concat,
  createPublicClient,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Hex,
} from "viem";

const API_URL = (process.env.MORROW_API_URL ?? "").replace(/\/$/, "");
const API_KEY = process.env.MORROW_API_KEY ?? "";
const RPC_URL = process.env.MORROW_RPC_URL ?? "";
const CONTRACT_OVERRIDE = process.env.MORROW_COMMITS_ADDRESS ?? "";

const commitsAbi = parseAbi([
  "function getCommit(uint64 cycleId) view returns (bytes32 merkleRoot, uint64 observationCount, uint64 committedAt)",
]);

async function apiGet(path: string): Promise<unknown> {
  if (!API_URL) {
    throw new Error("MORROW_API_URL is not set. point it at a morrow api deployment.");
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (API_KEY) headers["x-api-key"] = API_KEY;
  const res = await fetch(`${API_URL}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`api ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function text(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorText(err: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
}

// sorted-pair keccak256 fold, identical to MorrowCommits.verify on-chain.
function foldProof(leaf: Hex, proof: Hex[]): Hex {
  let node = leaf;
  for (const sibling of proof) {
    const [lo, hi] =
      node.toLowerCase() <= sibling.toLowerCase() ? [node, sibling] : [sibling, node];
    node = keccak256(concat([lo, hi]));
  }
  return node;
}

const server = new McpServer({
  name: "morrow",
  version: "0.1.0",
});

server.tool(
  "list_tokens",
  "list the stock tokens tracked by the morrow oracle, with their ids and pool addresses.",
  {},
  async () => {
    try {
      return text(await apiGet("/v1/tokens"));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "get_fair_value",
  "latest published fair value for one tracked symbol: value, confidence 0-100, band, regime (market_open, after_hours, weekend, holiday), suspect flag, and decomposition (anchor, drift, onchain twap and spot).",
  { symbol: z.string().describe("token symbol, e.g. tsla") },
  async ({ symbol }) => {
    try {
      return text(await apiGet(`/v1/prices/${encodeURIComponent(symbol.toLowerCase())}`));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "get_history",
  "paginated fair value history for a symbol. from and to accept iso timestamps or unix seconds; defaults to the last 7 days.",
  {
    symbol: z.string().describe("token symbol, e.g. tsla"),
    from: z.string().optional().describe("start of range, iso or unix seconds"),
    to: z.string().optional().describe("end of range, iso or unix seconds"),
    limit: z.number().int().min(1).max(2000).optional().describe("rows per page, default 500"),
    offset: z.number().int().min(0).optional().describe("pagination offset"),
  },
  async ({ symbol, from, to, limit, offset }) => {
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (limit !== undefined) params.set("limit", String(limit));
      if (offset !== undefined) params.set("offset", String(offset));
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      return text(
        await apiGet(`/v1/prices/${encodeURIComponent(symbol.toLowerCase())}/history${qs}`)
      );
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "get_accuracy",
  "realized accuracy for a symbol: each off-hours prediction versus the actual next official open print, with rolling error stats (mean, median, p90 absolute error percent, signed bias).",
  {
    symbol: z.string().describe("token symbol, e.g. tsla"),
    limit: z.number().int().min(1).max(250).optional().describe("samples to include, default 60"),
  },
  async ({ symbol, limit }) => {
    try {
      const qs = limit !== undefined ? `?limit=${limit}` : "";
      return text(await apiGet(`/v1/accuracy/${encodeURIComponent(symbol.toLowerCase())}${qs}`));
    } catch (err) {
      return errorText(err);
    }
  }
);

server.tool(
  "verify_observation",
  "independently verify a published observation: fetch the merkle proof from the api, recompute the leaf hash and root locally, and (when MORROW_RPC_URL is set) compare against the root committed on robinhood chain. trust nothing the api says without this.",
  {
    symbol: z.string().describe("token symbol, e.g. tsla"),
    cycleId: z.number().int().min(0).describe("commit cycle id"),
  },
  async ({ symbol, cycleId }) => {
    try {
      const payload = (await apiGet(
        `/v1/proof/${encodeURIComponent(symbol.toLowerCase())}/${cycleId}`
      )) as {
        data: {
          leaf: { canonicalString: string; hash: string };
          proof: string[];
          merkleRoot: string;
          txHash: string | null;
          contract: string;
          chainId: number;
        };
      };
      const { leaf, proof, merkleRoot, txHash, contract, chainId } = payload.data;

      const recomputedLeaf = keccak256(stringToHex(leaf.canonicalString));
      const leafMatches = recomputedLeaf.toLowerCase() === leaf.hash.toLowerCase();
      const recomputedRoot = foldProof(recomputedLeaf, proof as Hex[]);
      const rootMatchesApi = recomputedRoot.toLowerCase() === merkleRoot.toLowerCase();

      let onchain: {
        checked: boolean;
        rootMatchesOnchain?: boolean;
        onchainRoot?: string;
        note?: string;
      } = { checked: false, note: "set MORROW_RPC_URL to also check the on-chain commit" };

      const contractAddress = (CONTRACT_OVERRIDE || contract) as Hex;
      if (RPC_URL && contractAddress && !contractAddress.includes("PLACEHOLDER")) {
        const client = createPublicClient({ transport: http(RPC_URL) });
        const result = await client.readContract({
          address: contractAddress,
          abi: commitsAbi,
          functionName: "getCommit",
          args: [BigInt(cycleId)],
        });
        const onchainRoot = result[0] as string;
        onchain = {
          checked: true,
          onchainRoot,
          rootMatchesOnchain: onchainRoot.toLowerCase() === recomputedRoot.toLowerCase(),
        };
      }

      const verified =
        leafMatches && rootMatchesApi && (onchain.checked ? onchain.rootMatchesOnchain === true : true);

      return text({
        verified,
        canonicalString: leaf.canonicalString,
        recomputedLeaf,
        leafMatches,
        recomputedRoot,
        apiRoot: merkleRoot,
        rootMatchesApi,
        onchain,
        txHash,
        contract: contractAddress,
        chainId,
        disclaimer:
          "informational feed. not for use in liquidations, settlement, or as sole pricing source. no warranty.",
      });
    } catch (err) {
      return errorText(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
