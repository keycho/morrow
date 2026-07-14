// cold-path resolver, exported as a library the frontend calls (not a worker).
//
// anything below the window must still resolve. order of preference:
//   1. read from postgres (in-window, fast path)
//   2. fall back to live rpc, decoding with the same transform.ts code
//   3. cache the rpc result back into the same tables with cold = true, so a
//      hash looked up once is fast next time and the pruner leaves it alone.
//
// every return value carries source: 'indexed' | 'rpc'. the ui does not display
// it, it is for debugging. address history can never be reconstructed from rpc,
// so an address always returns live header data plus historyTruncated and the
// window floor, and its list comes only from the index.

import {
  getBalance,
  getBlockByHash,
  getBlockByNumberOrNull,
  getBlockReceipts,
  getCode,
  getTransactionByHash,
  getTransactionCount,
} from "./chain.js";
import { sql, writeBlocks } from "./db.js";
import { transformBlock, type Row } from "./transform.js";
import { getSyncValue, WINDOW_FLOOR_KEY } from "./window.js";

export type Source = "indexed" | "rpc";

export interface TxView {
  hash: string;
  blockNumber: number;
  blockTimestamp: string;
  txIndex: number;
  from: string;
  to: string | null;
  value: string;
  gasLimit: number | null;
  gasUsed: number | null;
  effectiveGasPrice: string | null;
  gasUsedForL1: number | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  nonce: number | null;
  input: string;
  methodId: string | null;
  txType: number | null;
  status: number | null;
  contractAddress: string | null;
}

export interface LogView {
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
}

export interface TransferView {
  logIndex: number;
  tokenAddress: string;
  from: string;
  to: string;
  value: string | null;
  tokenId: string | null;
  tokenType: string;
}

export interface BlockView {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: string;
  miner: string;
  gasUsed: number;
  gasLimit: number;
  baseFeePerGas: string | null;
  txCount: number;
  size: number | null;
  l1BlockNumber: number | null;
}

export interface TxResult {
  source: Source;
  found: boolean;
  tx: TxView | null;
  logs: LogView[];
  tokenTransfers: TransferView[];
}

export interface BlockResult {
  source: Source;
  found: boolean;
  block: BlockView | null;
  transactions: TxView[];
}

export interface AddressResult {
  source: Source;
  address: string;
  balance: string;
  nonce: number;
  isContract: boolean;
  codeSize: number;
  creation: { creator: string | null; creationTx: string | null; creationBlock: number | null } | null;
  transactions: { blockNumber: number; txIndex: number; txHash: string; direction: string }[];
  historyTruncated: true;
  windowFloor: number | null;
}

const ADDRESS_LIST_LIMIT = Number(process.env.ADDRESS_LIST_LIMIT ?? 50);

const nOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const sOrNull = (v: unknown): string | null => (v == null ? null : String(v));
const toHex = (b: unknown): string =>
  b == null ? "0x" : "0x" + Buffer.from(b as Buffer).toString("hex");
const toIso = (d: unknown): string =>
  (d instanceof Date ? d : new Date(d as string)).toISOString();

// one mapper for both the postgres row shape and the transform.ts row shape,
// which use identical column names, so decoding never forks.
function txView(row: Row): TxView {
  const input = row.input as Buffer | null;
  const methodId =
    input && input.length >= 4 ? "0x" + Buffer.from(input.subarray(0, 4)).toString("hex") : null;
  return {
    hash: row.hash as string,
    blockNumber: Number(row.block_number),
    blockTimestamp: toIso(row.block_timestamp),
    txIndex: Number(row.tx_index),
    from: row.from_address as string,
    to: (row.to_address as string | null) ?? null,
    value: String(row.value),
    gasLimit: nOrNull(row.gas_limit),
    gasUsed: nOrNull(row.gas_used),
    effectiveGasPrice: sOrNull(row.effective_gas_price),
    gasUsedForL1: nOrNull(row.gas_used_for_l1),
    maxFeePerGas: sOrNull(row.max_fee_per_gas),
    maxPriorityFeePerGas: sOrNull(row.max_priority_fee_per_gas),
    nonce: nOrNull(row.nonce),
    input: toHex(input),
    methodId,
    txType: nOrNull(row.tx_type),
    status: nOrNull(row.status),
    contractAddress: (row.contract_address as string | null) ?? null,
  };
}

function logView(row: Row): LogView {
  return {
    logIndex: Number(row.log_index),
    address: row.address as string,
    topics: [row.topic0, row.topic1, row.topic2, row.topic3].filter(
      (t): t is string => t != null,
    ),
    data: toHex(row.data),
  };
}

function transferView(row: Row): TransferView {
  return {
    logIndex: Number(row.log_index),
    tokenAddress: row.token_address as string,
    from: row.from_address as string,
    to: row.to_address as string,
    value: sOrNull(row.value),
    tokenId: sOrNull(row.token_id),
    tokenType: row.token_type as string,
  };
}

function blockView(row: Row): BlockView {
  return {
    number: Number(row.number),
    hash: row.hash as string,
    parentHash: row.parent_hash as string,
    timestamp: toIso(row.timestamp ?? row.block_timestamp),
    miner: row.miner as string,
    gasUsed: Number(row.gas_used),
    gasLimit: Number(row.gas_limit),
    baseFeePerGas: sOrNull(row.base_fee_per_gas),
    txCount: Number(row.tx_count),
    size: nOrNull(row.size),
    l1BlockNumber: nOrNull(row.l1_block_number),
  };
}

// fetch a full block plus receipts, transform, and cache it cold. shared by the
// tx and block rpc fallbacks so a single lookup warms the whole block.
async function cacheColdBlock(blockNumber: number, rawBlock?: Row) {
  const block =
    rawBlock ?? (await getBlockByNumberOrNull(blockNumber));
  if (!block) return null;
  const receipts = await getBlockReceipts(blockNumber);
  const rows = transformBlock(block as never, receipts);
  await sql.begin((tx) => writeBlocks(tx, [rows], { cold: true }));
  return rows;
}

export async function resolveTx(hash: string): Promise<TxResult> {
  const h = hash.toLowerCase();

  const rows = await sql<Row[]>`select * from transactions where hash = ${h}`;
  if (rows[0]) {
    const logs = await sql<Row[]>`select * from logs where tx_hash = ${h} order by log_index`;
    const transfers = await sql<Row[]>`select * from token_transfers where tx_hash = ${h} order by log_index`;
    return {
      source: "indexed",
      found: true,
      tx: txView(rows[0]),
      logs: logs.map(logView),
      tokenTransfers: transfers.map(transferView),
    };
  }

  const raw = await getTransactionByHash(h);
  if (!raw || raw.blockNumber == null) {
    return { source: "rpc", found: false, tx: null, logs: [], tokenTransfers: [] };
  }
  const blockNumber = Number(BigInt(raw.blockNumber));
  const cached = await cacheColdBlock(blockNumber);
  if (!cached) {
    return { source: "rpc", found: false, tx: null, logs: [], tokenTransfers: [] };
  }
  const txRow = cached.transactions.find((t) => t.hash === h);
  if (!txRow) {
    return { source: "rpc", found: false, tx: null, logs: [], tokenTransfers: [] };
  }
  return {
    source: "rpc",
    found: true,
    tx: txView(txRow),
    logs: cached.logs.filter((l) => l.tx_hash === h).map(logView),
    tokenTransfers: cached.tokenTransfers.filter((t) => t.tx_hash === h).map(transferView),
  };
}

export async function resolveBlock(idOrHash: string | number): Promise<BlockResult> {
  const isHash = typeof idOrHash === "string" && idOrHash.startsWith("0x");
  const num = isHash ? null : Number(idOrHash);

  const rows = isHash
    ? await sql<Row[]>`select * from blocks where hash = ${String(idOrHash).toLowerCase()}`
    : await sql<Row[]>`select * from blocks where number = ${num}`;
  if (rows[0]) {
    const bn = Number(rows[0].number);
    const txs = await sql<Row[]>`select * from transactions where block_number = ${bn} order by tx_index`;
    return { source: "indexed", found: true, block: blockView(rows[0]), transactions: txs.map(txView) };
  }

  const raw = isHash
    ? await getBlockByHash(String(idOrHash), true)
    : await getBlockByNumberOrNull(num as number);
  if (!raw) return { source: "rpc", found: false, block: null, transactions: [] };

  const bn = Number(BigInt(raw.number));
  const cached = await cacheColdBlock(bn, raw as unknown as Row);
  if (!cached) return { source: "rpc", found: false, block: null, transactions: [] };
  return {
    source: "rpc",
    found: true,
    block: blockView(cached.block),
    transactions: cached.transactions.map(txView),
  };
}

export async function resolveAddress(address: string): Promise<AddressResult> {
  const a = address.toLowerCase();
  const windowFloor = await getSyncValue(WINDOW_FLOOR_KEY);

  // balance, nonce and code are current chain state, always read live.
  const [balanceHex, nonceHex, code] = await Promise.all([
    getBalance(a),
    getTransactionCount(a),
    getCode(a),
  ]);
  const isContract = code != null && code !== "0x";
  const codeSize = isContract ? (code.length - 2) / 2 : 0;

  // the tx list comes only from the index and only covers the window.
  const txns = await sql<Row[]>`
    select block_number, tx_index, tx_hash, direction
      from address_transactions
     where address = ${a}
     order by block_number desc, tx_index desc
     limit ${ADDRESS_LIST_LIMIT}
  `;

  let creation: AddressResult["creation"] = null;
  if (isContract) {
    const c = await sql<Row[]>`
      select creator, creation_tx, creation_block from contracts where address = ${a}
    `;
    if (c[0]) {
      creation = {
        creator: (c[0].creator as string | null) ?? null,
        creationTx: (c[0].creation_tx as string | null) ?? null,
        creationBlock: nOrNull(c[0].creation_block),
      };
    }
  }

  return {
    source: "indexed",
    address: a,
    balance: BigInt(balanceHex).toString(),
    nonce: Number(BigInt(nonceHex)),
    isContract,
    codeSize,
    creation,
    transactions: txns.map((r) => ({
      blockNumber: Number(r.block_number),
      txIndex: Number(r.tx_index),
      txHash: r.tx_hash as string,
      direction: r.direction as string,
    })),
    historyTruncated: true,
    windowFloor,
  };
}

export type QueryResult =
  | { kind: "tx"; result: TxResult }
  | { kind: "block"; result: BlockResult }
  | { kind: "address"; result: AddressResult }
  | { kind: "unknown" };

// dispatch an arbitrary user query. a 32-byte hash is ambiguous, so we try tx
// first and fall back to block.
export async function resolveQuery(input: string): Promise<QueryResult> {
  const q = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    return { kind: "address", result: await resolveAddress(q) };
  }
  if (/^[0-9]+$/.test(q)) {
    return { kind: "block", result: await resolveBlock(Number(q)) };
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
    const tx = await resolveTx(q);
    if (tx.found) return { kind: "tx", result: tx };
    const block = await resolveBlock(q);
    if (block.found) return { kind: "block", result: block };
    return { kind: "tx", result: tx };
  }
  return { kind: "unknown" };
}
