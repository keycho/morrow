// raw json-rpc block, receipt and log objects -> database row objects.
// all decoding lives here so the workers stay about orchestration.
//
// we read raw rpc (not viem's typed results) so the arbitrum l2 fields survive
// exactly as the chain returns them. hashes and addresses are lowercased text,
// wei amounts are stringified for numeric(78,0), calldata and log data are
// Buffers for bytea.

type Hex = `0x${string}`;

export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  logIndex: Hex;
  transactionHash: Hex;
  blockNumber: Hex;
}

export interface RawReceipt {
  transactionHash: Hex;
  transactionIndex: Hex;
  blockNumber: Hex;
  from: Hex;
  to: Hex | null;
  gasUsed: Hex;
  effectiveGasPrice?: Hex | null;
  gasUsedForL1?: Hex | null;
  l1BlockNumber?: Hex | null;
  contractAddress: Hex | null;
  status?: Hex | null;
  type?: Hex | null;
  logs: RawLog[];
}

export interface RawTx {
  hash: Hex;
  transactionIndex: Hex;
  // present on eth_getTransactionByHash / block transactions, null when pending.
  blockNumber?: Hex | null;
  from: Hex;
  to: Hex | null;
  value: Hex;
  gas: Hex;
  nonce: Hex;
  input: Hex;
  type?: Hex | null;
  maxFeePerGas?: Hex | null;
  maxPriorityFeePerGas?: Hex | null;
}

export interface RawBlock {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  timestamp: Hex;
  miner: Hex;
  gasUsed: Hex;
  gasLimit: Hex;
  baseFeePerGas?: Hex | null;
  size?: Hex | null;
  l1BlockNumber?: Hex | null;
  transactions: RawTx[];
}

export type Row = Record<string, unknown>;

export interface BlockRows {
  block: Row;
  transactions: Row[];
  logs: Row[];
  tokenTransfers: Row[];
  addressTxns: Row[];
  contracts: Row[];
}

// keccak256("Transfer(address,address,uint256)")
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface DecodedTransfer {
  from: string;
  to: string;
  value: string | null;
  tokenId: string | null;
  tokenType: "erc20" | "erc721";
}

// decode a Transfer log's participants and amount. disambiguation is on
// indexed-arg count: from, to and an indexed tokenId means erc-721 (topics
// length 4); from and to with the value in data means erc-20 (topics length 3).
// this is the single source of Transfer decoding, reused by transform and by
// token hydration.
export function decodeTransferLog(
  topics: readonly Hex[],
  data: Hex,
): DecodedTransfer | null {
  if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  if (topics.length === 4) {
    return {
      from: topicToAddress(topics[1]!),
      to: topicToAddress(topics[2]!),
      value: null,
      tokenId: BigInt(topics[3]!).toString(),
      tokenType: "erc721",
    };
  }
  if (topics.length === 3) {
    const word = data && data.length >= 66 ? data.slice(0, 66) : null;
    if (word == null) return null;
    return {
      from: topicToAddress(topics[1]!),
      to: topicToAddress(topics[2]!),
      value: BigInt(word as Hex).toString(),
      tokenId: null,
      tokenType: "erc20",
    };
  }
  return null;
}

// column order for each table's insert. method_id is a generated column and is
// deliberately excluded.
export const COLUMNS = {
  blocks: [
    "number",
    "hash",
    "parent_hash",
    "timestamp",
    "miner",
    "gas_used",
    "gas_limit",
    "base_fee_per_gas",
    "tx_count",
    "size",
    "l1_block_number",
  ],
  transactions: [
    "hash",
    "block_number",
    "block_timestamp",
    "tx_index",
    "from_address",
    "to_address",
    "value",
    "gas_limit",
    "gas_used",
    "effective_gas_price",
    "gas_used_for_l1",
    "max_fee_per_gas",
    "max_priority_fee_per_gas",
    "nonce",
    "input",
    "tx_type",
    "status",
    "contract_address",
  ],
  logs: [
    "block_number",
    "log_index",
    "tx_hash",
    "block_timestamp",
    "address",
    "topic0",
    "topic1",
    "topic2",
    "topic3",
    "data",
  ],
  token_transfers: [
    "block_number",
    "log_index",
    "tx_hash",
    "block_timestamp",
    "token_address",
    "from_address",
    "to_address",
    "value",
    "token_id",
    "token_type",
  ],
  address_transactions: [
    "address",
    "block_number",
    "tx_index",
    "tx_hash",
    "direction",
  ],
  contracts: ["address", "creator", "creation_tx", "creation_block", "bytecode_hash"],
} as const;

const big = (h: Hex): string => BigInt(h).toString();
const optBig = (h?: Hex | null): string | null =>
  h == null ? null : BigInt(h).toString();
const num = (h: Hex): number => Number(BigInt(h));
const optNum = (h?: Hex | null): number | null =>
  h == null ? null : Number(BigInt(h));
const lower = (h: Hex): string => h.toLowerCase();
const optLower = (h?: Hex | null): string | null =>
  h == null ? null : h.toLowerCase();
const buf = (h?: Hex | null): Buffer =>
  Buffer.from((h ?? "0x").slice(2), "hex");
const optTopic = (t?: Hex): string | null => (t == null ? null : t.toLowerCase());
// a 32-byte topic holds a left-padded 20-byte address in its low bytes.
const topicToAddress = (t: Hex): string => ("0x" + t.slice(-40)).toLowerCase();

export function transformBlock(
  block: RawBlock,
  receipts: RawReceipt[],
): BlockRows {
  const blockNumber = big(block.number);
  const ts = new Date(num(block.timestamp) * 1000);

  const rows: BlockRows = {
    block: {
      number: blockNumber,
      hash: lower(block.hash),
      parent_hash: lower(block.parentHash),
      timestamp: ts,
      miner: lower(block.miner),
      gas_used: big(block.gasUsed),
      gas_limit: big(block.gasLimit),
      base_fee_per_gas: optBig(block.baseFeePerGas),
      tx_count: block.transactions.length,
      size: optBig(block.size),
      l1_block_number: optBig(block.l1BlockNumber),
    },
    transactions: [],
    logs: [],
    tokenTransfers: [],
    addressTxns: [],
    contracts: [],
  };

  const receiptByHash = new Map<string, RawReceipt>();
  for (const r of receipts) receiptByHash.set(r.transactionHash.toLowerCase(), r);

  for (const tx of block.transactions) {
    const r = receiptByHash.get(tx.hash.toLowerCase());
    const txIndex = num(tx.transactionIndex);
    const from = lower(tx.from);
    const to = optLower(tx.to);
    const contractAddress = optLower(r?.contractAddress ?? null);

    rows.transactions.push({
      hash: lower(tx.hash),
      block_number: blockNumber,
      block_timestamp: ts,
      tx_index: txIndex,
      from_address: from,
      to_address: to,
      value: big(tx.value),
      gas_limit: optBig(tx.gas),
      gas_used: optBig(r?.gasUsed),
      effective_gas_price: optBig(r?.effectiveGasPrice),
      gas_used_for_l1: optBig(r?.gasUsedForL1),
      max_fee_per_gas: optBig(tx.maxFeePerGas),
      max_priority_fee_per_gas: optBig(tx.maxPriorityFeePerGas),
      nonce: optBig(tx.nonce),
      input: buf(tx.input),
      tx_type: optNum(tx.type),
      status: optNum(r?.status),
      contract_address: contractAddress,
    });

    // one address_transactions row per participant. sender always, recipient
    // when present; for a creation the new contract address is the recipient.
    rows.addressTxns.push({
      address: from,
      block_number: blockNumber,
      tx_index: txIndex,
      tx_hash: lower(tx.hash),
      direction: "from",
    });
    const counterparty = to ?? contractAddress;
    if (counterparty) {
      rows.addressTxns.push({
        address: counterparty,
        block_number: blockNumber,
        tx_index: txIndex,
        tx_hash: lower(tx.hash),
        direction: "to",
      });
    }

    if (contractAddress) {
      rows.contracts.push({
        address: contractAddress,
        creator: from,
        creation_tx: lower(tx.hash),
        creation_block: blockNumber,
        bytecode_hash: null,
      });
    }

    if (!r) continue;
    for (const lg of r.logs) {
      const logIndex = num(lg.logIndex);
      const [t0, t1, t2, t3] = lg.topics;
      rows.logs.push({
        block_number: blockNumber,
        log_index: logIndex,
        tx_hash: lower(tx.hash),
        block_timestamp: ts,
        address: lower(lg.address),
        topic0: optTopic(t0),
        topic1: optTopic(t1),
        topic2: optTopic(t2),
        topic3: optTopic(t3),
        data: buf(lg.data),
      });

      const transfer = decodeTransfer(lg, blockNumber, ts);
      if (transfer) rows.tokenTransfers.push(transfer);
    }
  }

  return rows;
}

// decode a Transfer log into an erc-20 or erc-721 row, or null if it is not a
// standard Transfer. disambiguation is on indexed-arg count: from, to and an
// indexed tokenId means erc-721 (topics length 4); from and to with the value in
// data means erc-20 (topics length 3).
function decodeTransfer(
  lg: RawLog,
  blockNumber: string,
  ts: Date,
): Row | null {
  const d = decodeTransferLog(lg.topics, lg.data);
  if (!d) return null;
  return {
    block_number: blockNumber,
    log_index: num(lg.logIndex),
    tx_hash: lg.transactionHash.toLowerCase(),
    block_timestamp: ts,
    token_address: lg.address.toLowerCase(),
    from_address: d.from,
    to_address: d.to,
    value: d.value,
    token_id: d.tokenId,
    token_type: d.tokenType,
  };
}
