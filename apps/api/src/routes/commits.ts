// commit records and merkle proofs. any historical observation can be
// verified independently: fetch the proof here, recompute the root, compare
// against FletchCommits.getCommit(cycleId) on robinhood chain.

import type { FastifyInstance } from "fastify";
import type { Hex } from "viem";
import { chain, disclaimer, tokenBySymbol } from "@fletch/config";
import { buildTree, proofForIndex } from "@fletch/engine";
import { commitByCycle, listCommits } from "../db.js";

export function registerCommitRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/v1/commits",
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500);
      const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
      const rows = await listCommits(limit, offset);
      return { data: rows, pagination: { limit, offset, count: rows.length }, disclaimer };
    }
  );

  app.get<{ Params: { cycleId: string } }>("/v1/commits/:cycleId", async (req, reply) => {
    const cycleId = Number(req.params.cycleId);
    if (!Number.isInteger(cycleId) || cycleId < 0) {
      return reply.code(400).send({ error: "cycleId must be a non-negative integer", disclaimer });
    }
    const commit = await commitByCycle(cycleId);
    if (!commit) {
      return reply.code(404).send({ error: "unknown cycle", disclaimer });
    }
    return { data: commit, disclaimer };
  });

  app.get<{ Params: { symbol: string; cycleId: string } }>(
    "/v1/proof/:symbol/:cycleId",
    async (req, reply) => {
      const token = tokenBySymbol(req.params.symbol);
      if (!token) {
        return reply.code(404).send({ error: "unknown symbol", disclaimer });
      }
      const cycleId = Number(req.params.cycleId);
      if (!Number.isInteger(cycleId) || cycleId < 0) {
        return reply.code(400).send({ error: "cycleId must be a non-negative integer", disclaimer });
      }
      const commit = await commitByCycle(cycleId);
      if (!commit) {
        return reply.code(404).send({ error: "unknown cycle", disclaimer });
      }
      const index = commit.leaves.findIndex((l) => l.tokenId === token.id);
      if (index === -1) {
        return reply.code(404).send({ error: "token not present in this cycle", disclaimer });
      }

      const leafHashes = commit.leaves.map((l) => l.leaf as Hex);
      const tree = buildTree(leafHashes);
      if (tree.root.toLowerCase() !== commit.merkleRoot.toLowerCase()) {
        // stored leaves no longer reproduce the stored root. surface loudly.
        return reply.code(500).send({
          error: "stored leaf set does not reproduce the committed root",
          disclaimer,
        });
      }
      const record = commit.leaves[index]!;
      const proof = proofForIndex(tree, index);

      return {
        data: {
          symbol: token.symbol,
          leaf: {
            tokenId: record.tokenId,
            cycleId: record.cycleId,
            fairValue: record.fairValue,
            confidence: record.confidence,
            timestamp: record.timestamp,
            canonicalString: `${record.tokenId}|${record.cycleId}|${record.fairValue}|${record.confidence}|${record.timestamp}`,
            hash: record.leaf,
          },
          proof,
          merkleRoot: commit.merkleRoot,
          txHash: commit.txHash,
          contract: chain.commitsContract,
          chainId: chain.chainId,
          verification:
            "leaf hash = keccak256(utf8(canonicalString)). fold sorted-pair keccak256 over the proof and compare to FletchCommits.getCommit(cycleId), or call verify(leafHash, proof, cycleId) on the contract.",
        },
        disclaimer,
      };
    }
  );
}
