// pnpm verify:balances: prove indexed balances against the chain.
//
// for N random hydrated (or freshly hydrated) tokens, compare the top 20 indexed
// balances against live balanceOf via multicall3 and report mismatches. i want
// the numbers proven, not assumed.

import { erc20Abi } from "viem";
import { client, MULTICALL3_ADDRESS } from "./chain.js";
import { sql, closeDb } from "./db.js";
import { getTopHolders, hydrateToken } from "./holders.js";
import { log } from "./log.js";

const N_TOKENS = Number(process.env.VERIFY_TOKENS ?? 5);
const TOP = Number(process.env.VERIFY_TOP ?? 20);

type Result<T> = { status: "success"; result: T } | { status: "failure" };

async function pickTokens(): Promise<string[]> {
  // explicit override, for targeted verification.
  const override = process.env.VERIFY_ADDRESSES;
  if (override) return override.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  // prefer already-hydrated tokens; fall back to the busiest windowed tokens.
  const hydrated = await sql<{ address: string }[]>`
    select token_address as address from token_hydration
     where status = 'done' and hydrated_at_block is not null
     order by random() limit ${N_TOKENS}
  `;
  if (hydrated.length >= N_TOKENS) return hydrated.map((r) => r.address);

  const busy = await sql<{ token_address: string }[]>`
    select token_address from token_transfers
     where token_type = 'erc20'
     group by token_address order by count(*) desc limit ${N_TOKENS}
  `;
  const set = new Set(hydrated.map((r) => r.address));
  for (const b of busy) set.add(b.token_address);
  return [...set].slice(0, N_TOKENS);
}

async function verifyToken(address: string): Promise<void> {
  // hydrate fresh, then compare AT the hydrated block, not latest: a token being
  // actively traded moves between the snapshot and now, so comparing to live
  // balanceOf would show spurious drift. comparing at the hydrated block isolates
  // whether the replay itself is correct.
  await hydrateToken(address);
  const [hyd] = await sql<{ hydrated_at_block: string | null }[]>`
    select hydrated_at_block from token_hydration where token_address = ${address.toLowerCase()}
  `;
  const atBlock = hyd?.hydrated_at_block != null ? BigInt(hyd.hydrated_at_block) : undefined;

  const holders = await getTopHolders(address, TOP);
  if (holders.length === 0) {
    console.log(`\n${address}: no holders indexed, skipping`);
    return;
  }

  const contracts = holders.map((h) => ({
    address: address as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf" as const,
    args: [h.holderAddress as `0x${string}`],
  }));
  const live = (await client.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: MULTICALL3_ADDRESS,
    ...(atBlock != null ? { blockNumber: atBlock } : {}),
  })) as Result<bigint>[];
  console.log(`(comparing at block ${atBlock})`);

  let mismatches = 0;
  console.log(`\n${address}: top ${holders.length} holders vs live balanceOf`);
  holders.forEach((h, i) => {
    const r = live[i];
    const onchain = r && r.status === "success" ? r.result : null;
    const indexed = BigInt(h.balance);
    const ok = onchain != null && onchain === indexed;
    if (!ok) mismatches += 1;
    if (!ok || i < 3) {
      console.log(
        `  ${ok ? "ok " : "MISMATCH"} ${h.holderAddress} indexed=${indexed} onchain=${onchain ?? "call-failed"}`,
      );
    }
  });
  console.log(`  ${holders.length - mismatches}/${holders.length} match`);
}

async function main() {
  const tokens = await pickTokens();
  if (tokens.length === 0) {
    log.error("no tokens available to verify, run the indexer first");
    await closeDb();
    process.exit(1);
  }
  log.info(`verifying ${tokens.length} token(s), top ${TOP} holders each`);
  for (const t of tokens) {
    try {
      await verifyToken(t);
    } catch (err) {
      console.log(`\n${t}: verify error ${String(err)}`);
    }
  }
  await closeDb();
}

main().catch((e) => {
  log.error(String(e));
  process.exit(1);
});
