// token metadata worker.
//
// finds token addresses seen in token_transfers that have no tokens row, and
// resolves name/symbol/decimals/totalSupply via multicall3 (confirmed deployed
// on this chain). tokens that do not implement the metadata methods get a row
// with null fields written anyway, so their presence stops us from ever
// retrying them.

import { erc20Abi } from "viem";
import { client, MULTICALL3_ADDRESS } from "./chain.js";
import { sql } from "./db.js";
import { log } from "./log.js";

const TOKENS_BATCH = Number(process.env.TOKENS_BATCH ?? 50);
const TOKENS_IDLE_MS = Number(process.env.TOKENS_IDLE_MS ?? 5000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Unknown {
  address: string;
  token_type: string;
}

async function nextUnknownTokens(): Promise<Unknown[]> {
  return sql<Unknown[]>`
    select distinct on (tt.token_address)
           tt.token_address as address,
           tt.token_type
      from token_transfers tt
      left join tokens t on t.address = tt.token_address
     where t.address is null
     limit ${TOKENS_BATCH}
  `;
}

type Result<T> = { status: "success"; result: T } | { status: "failure" };

function ok<T>(r: Result<unknown> | undefined): T | null {
  return r && r.status === "success" ? (r.result as T) : null;
}

async function resolveBatch(tokens: Unknown[]): Promise<void> {
  const contracts = tokens.flatMap((t) => {
    const address = t.address as `0x${string}`;
    return [
      { address, abi: erc20Abi, functionName: "name" } as const,
      { address, abi: erc20Abi, functionName: "symbol" } as const,
      { address, abi: erc20Abi, functionName: "decimals" } as const,
      { address, abi: erc20Abi, functionName: "totalSupply" } as const,
    ];
  });

  const results = (await client.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: MULTICALL3_ADDRESS,
  })) as Result<unknown>[];

  const rows = tokens.map((t, i) => {
    const base = i * 4;
    const name = ok<string>(results[base]);
    const symbol = ok<string>(results[base + 1]);
    const decimals = ok<number | bigint>(results[base + 2]);
    const totalSupply = ok<bigint>(results[base + 3]);
    return {
      address: t.address,
      name: sanitize(name),
      symbol: sanitize(symbol),
      decimals: decimals == null ? null : Number(decimals),
      token_type: t.token_type,
      total_supply: totalSupply == null ? null : totalSupply.toString(),
    };
  });

  await sql`
    insert into tokens ${sql(
      rows,
      "address",
      "name",
      "symbol",
      "decimals",
      "token_type",
      "total_supply",
    )}
    on conflict (address) do nothing
  `;
}

// drop control characters some tokens pack into their name/symbol strings, and
// cap length so a hostile token cannot bloat a row.
function sanitize(s: string | null): string | null {
  if (s == null) return null;
  let out = "";
  for (const ch of s) {
    if ((ch.codePointAt(0) ?? 0) >= 0x20) out += ch;
  }
  out = out.trim();
  return out.length ? out.slice(0, 256) : null;
}

export async function runTokens(stopped: () => boolean = () => false): Promise<void> {
  log.info(`token metadata worker started, batch ${TOKENS_BATCH}`);
  while (!stopped()) {
    try {
      const tokens = await nextUnknownTokens();
      if (tokens.length === 0) {
        await sleep(TOKENS_IDLE_MS);
        continue;
      }
      await resolveBatch(tokens);
      log.info(`resolved metadata for ${tokens.length} token(s)`);
    } catch (err) {
      log.error(`token metadata batch failed, backing off: ${String(err)}`);
      await sleep(TOKENS_IDLE_MS);
    }
  }
  log.info("token metadata worker stopped");
}
