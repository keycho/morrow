// viem chain definition and rpc client for robinhood chain (4663).
//
// robinhood chain is an arbitrum orbit l2, so blocks, transactions and
// receipts carry extra fields (l1BlockNumber, gasUsedForL1, effectiveGasPrice)
// that viem's default formatters would drop. we attach arbitrum-style
// formatters so those fields survive typed calls, and the backfill hot path
// additionally reads raw json-rpc (see rpc() below) so nothing is ever lost.

import {
  createPublicClient,
  defineChain,
  defineBlock,
  defineTransaction,
  defineTransactionReceipt,
  http,
} from "viem";
import { log } from "./log.js";
import type { RawBlock, RawReceipt, RawTx } from "./transform.js";

export const CHAIN_ID = 4663;

// canonical multicall3, confirmed deployed on this chain.
export const MULTICALL3_ADDRESS =
  "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

export const RPC_URL = process.env.RPC_URL ?? PUBLIC_RPC;
if (!process.env.RPC_URL) {
  log.warn(
    "RPC_URL is not set, falling back to the public rate-limited endpoint. do not backfill against it.",
  );
}

// keep the arbitrum-only fields when viem parses a block/tx/receipt.
const formatters = {
  block: defineBlock({
    format(args: { l1BlockNumber?: `0x${string}` | null }) {
      return {
        l1BlockNumber:
          args.l1BlockNumber != null ? BigInt(args.l1BlockNumber) : undefined,
      };
    },
  }),
  transaction: defineTransaction({
    format(args: {
      gasUsedForL1?: `0x${string}` | null;
      l1BlockNumber?: `0x${string}` | null;
    }) {
      return {
        gasUsedForL1:
          args.gasUsedForL1 != null ? BigInt(args.gasUsedForL1) : undefined,
        l1BlockNumber:
          args.l1BlockNumber != null ? BigInt(args.l1BlockNumber) : undefined,
      };
    },
  }),
  transactionReceipt: defineTransactionReceipt({
    format(args: {
      l1BlockNumber?: `0x${string}` | null;
      gasUsedForL1?: `0x${string}` | null;
    }) {
      return {
        l1BlockNumber:
          args.l1BlockNumber != null ? BigInt(args.l1BlockNumber) : undefined,
        gasUsedForL1:
          args.gasUsedForL1 != null ? BigInt(args.gasUsedForL1) : undefined,
      };
    },
  }),
};

export const rhChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  contracts: {
    multicall3: { address: MULTICALL3_ADDRESS, blockCreated: 0 },
  },
  formatters,
});

// batch is the single biggest throughput lever: viem packs every request made
// through this transport (including the raw rpc() calls below and multicall)
// into json-rpc batches. we handle retry/backoff ourselves in rpc(), so the
// transport does not retry.
const BATCH_WAIT = Number(process.env.BATCH_WAIT ?? 20);
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 100);
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 30_000);

export const client = createPublicClient({
  chain: rhChain,
  transport: http(RPC_URL, {
    batch: { wait: BATCH_WAIT, batchSize: BATCH_SIZE },
    timeout: RPC_TIMEOUT_MS,
    retryCount: 0,
  }),
});

const MAX_RPC_ATTEMPTS = Number(process.env.MAX_RPC_ATTEMPTS ?? 8);

function isRateLimitError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("-32005") || // json-rpc limit exceeded
    msg.includes("exceeded") ||
    msg.includes("capacity") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    // a rate-limited batch often comes back as a malformed / short body that
    // viem cannot line up with the requests. treat those as transient too.
    msg.includes("an unknown rpc error") ||
    msg.includes("cannot read properties") ||
    msg.includes("service unavailable") ||
    msg.includes("bad gateway") ||
    msg.includes("gateway timeout")
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// raw batched json-rpc with exponential backoff and jitter on rate-limit and
// transient network errors. non-transient errors throw immediately.
export async function rpc<T>(
  method: string,
  params: unknown[],
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return (await client.request({
        method: method as never,
        params: params as never,
      })) as T;
    } catch (err) {
      attempt += 1;
      if (attempt >= MAX_RPC_ATTEMPTS || !isRateLimitError(err)) {
        throw err;
      }
      const backoff = Math.min(250 * 2 ** attempt, 15_000);
      const jitter = Math.floor(Math.random() * backoff * 0.5);
      const wait = backoff + jitter;
      log.warn(
        `rpc ${method} rate limited, retry ${attempt}/${MAX_RPC_ATTEMPTS} in ${wait}ms`,
      );
      await sleep(wait);
    }
  }
}

export async function getHead(): Promise<number> {
  const hex = await rpc<`0x${string}`>("eth_blockNumber", []);
  return Number(BigInt(hex));
}

const toHex = (n: number): `0x${string}` => `0x${n.toString(16)}`;

// eth_getBlockByNumber with full transactions gives per-tx fields (value,
// nonce, calldata, fee caps); eth_getBlockReceipts gives execution results and
// logs in one call. both go through the batched transport.
export function getBlockByNumber(n: number): Promise<RawBlock> {
  return rpc<RawBlock>("eth_getBlockByNumber", [toHex(n), true]);
}

export function getBlockReceipts(n: number): Promise<RawReceipt[]> {
  return rpc<RawReceipt[]>("eth_getBlockReceipts", [toHex(n)]);
}

// header-only read for window-floor binary search: cheap, no transactions.
export async function getBlockHeaderTimestamp(n: number): Promise<number> {
  const b = await rpc<{ timestamp: `0x${string}` }>("eth_getBlockByNumber", [
    toHex(n),
    false,
  ]);
  return Number(BigInt(b.timestamp));
}

// cold-path reads: single tx / block / account lookups for data below the
// window. these are not batched hot-path calls, they serve one user query.
export function getTransactionByHash(hash: string): Promise<RawTx | null> {
  return rpc<RawTx | null>("eth_getTransactionByHash", [hash]);
}

export function getTransactionReceipt(hash: string): Promise<RawReceipt | null> {
  return rpc<RawReceipt | null>("eth_getTransactionReceipt", [hash]);
}

export function getBlockByHash(
  hash: string,
  full = true,
): Promise<RawBlock | null> {
  return rpc<RawBlock | null>("eth_getBlockByHash", [hash, full]);
}

// eth_getBlockByNumber can return null for an unknown number; getBlockByNumber
// above assumes it exists (hot path), this variant tolerates a miss.
export function getBlockByNumberOrNull(n: number): Promise<RawBlock | null> {
  return rpc<RawBlock | null>("eth_getBlockByNumber", [toHex(n), true]);
}

export function getBalance(address: string): Promise<`0x${string}`> {
  return rpc<`0x${string}`>("eth_getBalance", [address, "latest"]);
}

export function getTransactionCount(address: string): Promise<`0x${string}`> {
  return rpc<`0x${string}`>("eth_getTransactionCount", [address, "latest"]);
}

export function getCode(address: string): Promise<`0x${string}`> {
  return rpc<`0x${string}`>("eth_getCode", [address, "latest"]);
}
