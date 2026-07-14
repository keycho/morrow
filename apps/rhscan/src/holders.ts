// token holders: on-demand hydration plus incremental maintenance.
//
// with a window measured in days, a token's transfer history almost always
// predates the window, so holders cannot come from indexed transfers. instead we
// hydrate one token at a time: pull that single token's whole Transfer history
// via chunked eth_getLogs from block 1 to head, replay it to a balance set, and
// store it in token_balances. after that the balances are maintained
// incrementally from windowed transfers (see applyTransferDeltas in db.ts, which
// only applies deltas for rows actually inserted, so a retried range never double
// applies). hydration is authoritative and idempotent (delete then replay), so
// re-hydrating corrects any drift.
//
// the zero address is stored as a real row (mint and burn) and excluded from
// holder counts and top-holder lists at read time.

import { getHead, getLogs } from "./chain.js";
import { sql, insertBatch, ZERO_ADDRESS } from "./db.js";
import { decodeTransferLog, TRANSFER_TOPIC, type Row } from "./transform.js";
import { log } from "./log.js";

const LOG_CHUNK = Number(process.env.LOG_CHUNK ?? 10_000);
const EAGER_TOP_N = Number(process.env.EAGER_TOP_N ?? 25);
const HOLDERS_IDLE_MS = Number(process.env.HOLDERS_IDLE_MS ?? 4000);
const TOP_HOLDERS_LIMIT = Number(process.env.TOP_HOLDERS_LIMIT ?? 100);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// enqueue a token for hydration and make sure a tokens row exists. safe to call
// on every page request: it never blocks and never re-queues a done token.
export async function requestHydration(address: string): Promise<void> {
  const a = address.toLowerCase();
  // hydration state is tracked in token_hydration only. we do NOT create a
  // tokens row here: the metadata worker treats a bare tokens row as "metadata
  // already attempted", so creating one would stop it ever resolving name/symbol.
  await sql`
    insert into token_hydration (token_address, status)
    values (${a}, 'pending')
    on conflict (token_address) do nothing
  `;
}

interface Replay {
  balances: Map<string, bigint>;
  lastBlock: Map<string, number>;
  transferCount: number;
  firstBlock: number | null;
}

function applyDelta(r: Replay, holder: string, amount: bigint, block: number): void {
  r.balances.set(holder, (r.balances.get(holder) ?? 0n) + amount);
  const prev = r.lastBlock.get(holder);
  if (prev == null || block > prev) r.lastBlock.set(holder, block);
}

// pull and replay every Transfer log for one token over [from, to], adapting the
// chunk size down on provider errors and back up on success.
async function replayRange(
  address: string,
  from: number,
  to: number,
  r: Replay,
): Promise<void> {
  let cursor = from;
  let chunk = LOG_CHUNK;
  while (cursor <= to) {
    const end = Math.min(cursor + chunk - 1, to);
    let logs;
    try {
      logs = await getLogs({
        address,
        fromBlock: cursor,
        toBlock: end,
        topics: [TRANSFER_TOPIC],
      });
    } catch (err) {
      // providers cap eth_getLogs by result count (this chain: 10000 logs) and
      // sometimes by range, so shrink the block window and retry. keep halving
      // all the way to a single block, since the cap is on results not range.
      if (chunk > 1) {
        chunk = Math.max(1, Math.floor(chunk / 2));
        continue;
      }
      throw err;
    }
    for (const lg of logs) {
      const d = decodeTransferLog(lg.topics, lg.data);
      if (!d) continue;
      const block = Number(BigInt(lg.blockNumber));
      r.transferCount += 1;
      if (r.firstBlock == null || block < r.firstBlock) r.firstBlock = block;
      const amount = d.tokenType === "erc721" ? 1n : BigInt(d.value ?? "0");
      if (amount !== 0n) {
        applyDelta(r, d.from, -amount, block);
        applyDelta(r, d.to, amount, block);
      }
    }
    cursor = end + 1;
    if (chunk < LOG_CHUNK) chunk = Math.min(LOG_CHUNK, chunk * 2);
  }
}

export async function hydrateToken(address: string): Promise<void> {
  const a = address.toLowerCase();
  await sql`
    insert into token_hydration (token_address, status, started_at)
    values (${a}, 'hydrating', now())
    on conflict (token_address) do update set status = 'hydrating', started_at = now(), error = null
  `;

  try {
    const r: Replay = {
      balances: new Map(),
      lastBlock: new Map(),
      transferCount: 0,
      firstBlock: null,
    };
    // start at the token's known deployment block when we have it, so we do not
    // scan empty history below it. falls back to block 1 otherwise.
    const [c] = await sql<{ creation_block: string | null }[]>`
      select creation_block from contracts where address = ${a}
    `;
    const start = c?.creation_block != null ? Math.max(1, Number(c.creation_block)) : 1;

    let head = await getHead();
    await replayRange(a, start, head, r);
    // one reconcile pass to shrink the gap opened while we were reading.
    const head2 = await getHead();
    if (head2 > head) {
      await replayRange(a, head + 1, head2, r);
      head = head2;
    }

    const rows = [...r.balances.entries()].map(([holder, bal]) => ({
      token_address: a,
      holder_address: holder,
      balance: bal.toString(),
      last_updated_block: r.lastBlock.get(holder) ?? head,
    }));

    await sql.begin(async (tx) => {
      // authoritative snapshot: replace any prior balances for this token.
      await tx`delete from token_balances where token_address = ${a}`;
      await insertBatch(
        tx,
        "token_balances",
        ["token_address", "holder_address", "balance", "last_updated_block"],
        rows,
      );
      await tx`
        update token_hydration
           set status = 'done', done_at = now(),
               hydrated_at_block = ${head}, transfer_count = ${r.transferCount}
         where token_address = ${a}
      `;
      await tx`
        insert into token_stats (token_address, transfer_count, first_transfer_block, updated_at)
        values (${a}, ${r.transferCount}, ${r.firstBlock}, now())
        on conflict (token_address) do update
          set transfer_count = excluded.transfer_count,
              first_transfer_block = excluded.first_transfer_block
      `;
    });

    await refreshStats(a);
    log.info(
      `hydrated ${a}: ${r.transferCount} transfers, ${rows.length} balance rows, head ${head}`,
    );
  } catch (err) {
    await sql`
      update token_hydration set status = 'failed', error = ${String(err)}
       where token_address = ${a}
    `;
    log.error(`hydration failed for ${a}: ${String(err)}`);
  }
}

// recompute the balance-derived stats (holder_count, shares) from token_balances.
// transfer_count and first_transfer_block are set at hydration and preserved.
export async function refreshStats(address: string): Promise<void> {
  const a = address.toLowerCase();
  const [agg] = await sql<{ holder_count: string; sum_positive: string }[]>`
    select count(*) filter (where balance > 0 and holder_address <> ${ZERO_ADDRESS}) as holder_count,
           coalesce(sum(balance) filter (where balance > 0 and holder_address <> ${ZERO_ADDRESS}), 0) as sum_positive
      from token_balances where token_address = ${a}
  `;
  const [supplyRow] = await sql<{ total_supply: string | null }[]>`
    select total_supply from tokens where address = ${a}
  `;
  const top = await sql<{ balance: string }[]>`
    select balance from token_balances
     where token_address = ${a} and holder_address <> ${ZERO_ADDRESS} and balance > 0
     order by balance desc limit 10
  `;
  const [dep] = await sql<{ creator: string | null }[]>`
    select creator from contracts where address = ${a}
  `;
  const deployer = dep?.creator ?? null;
  let deployerBal = 0n;
  if (deployer) {
    const [b] = await sql<{ balance: string }[]>`
      select balance from token_balances where token_address = ${a} and holder_address = ${deployer}
    `;
    if (b) deployerBal = BigInt(b.balance);
  }

  const total =
    supplyRow?.total_supply != null && BigInt(supplyRow.total_supply) > 0n
      ? BigInt(supplyRow.total_supply)
      : BigInt(agg?.sum_positive ?? "0");
  const share = (part: bigint): number | null => {
    if (total <= 0n) return null;
    // 6 decimal places of precision, avoiding float overflow on huge supplies.
    return Number((part * 1_000_000n) / total) / 1_000_000;
  };
  const top10 = top.reduce((s, r) => s + BigInt(r.balance), 0n);

  await sql`
    insert into token_stats
      (token_address, holder_count, deployer_address, deployer_balance_share, top10_share, updated_at)
    values (${a}, ${Number(agg?.holder_count ?? 0)}, ${deployer},
            ${share(deployerBal)}, ${share(top10)}, now())
    on conflict (token_address) do update
      set holder_count = excluded.holder_count,
          deployer_address = excluded.deployer_address,
          deployer_balance_share = excluded.deployer_balance_share,
          top10_share = excluded.top10_share,
          updated_at = now()
  `;
}

// enqueue the top tokens by windowed transfer count that are not yet hydrated.
async function eagerEnqueue(): Promise<void> {
  const rows = await sql<{ token_address: string }[]>`
    select tt.token_address
      from token_transfers tt
      left join token_hydration th on th.token_address = tt.token_address
     where th.token_address is null
     group by tt.token_address
     order by count(*) desc
     limit ${EAGER_TOP_N}
  `;
  for (const r of rows) await requestHydration(r.token_address);
}

async function nextPending(): Promise<string | null> {
  const rows = await sql<{ token_address: string }[]>`
    select token_address from token_hydration
     where status = 'pending' order by requested_at limit 1
  `;
  return rows[0]?.token_address ?? null;
}

export async function runHolders(stopped: () => boolean = () => false): Promise<void> {
  log.info(`holders worker started, eager top ${EAGER_TOP_N}`);
  while (!stopped()) {
    try {
      await eagerEnqueue();
      const next = await nextPending();
      if (next) {
        await hydrateToken(next);
        continue;
      }
      // nothing to hydrate: refresh the stalest hydrated token so shares track
      // incremental balance changes, then idle.
      const [stale] = await sql<{ token_address: string }[]>`
        select ts.token_address from token_stats ts
        join token_hydration th on th.token_address = ts.token_address
        where th.hydrated_at_block is not null
        order by ts.updated_at asc limit 1
      `;
      if (stale) await refreshStats(stale.token_address);
      await sleep(HOLDERS_IDLE_MS);
    } catch (err) {
      log.error(`holders loop error: ${String(err)}`);
      await sleep(HOLDERS_IDLE_MS);
    }
  }
  log.info("holders worker stopped");
}

// ---------------------------------------------------------------------------
// read helpers the frontend calls (never block on hydration)
// ---------------------------------------------------------------------------

export interface Holder {
  holderAddress: string;
  balance: string;
  lastUpdatedBlock: number | null;
}

export interface TokenOverview {
  address: string;
  hydrating: boolean;
  hydratedAtBlock: number | null;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  tokenType: string | null;
  totalSupply: string | null;
  stats: {
    holderCount: number;
    transferCount: number;
    firstTransferBlock: number | null;
    deployerAddress: string | null;
    deployerBalanceShare: number | null;
    top10Share: number | null;
  } | null;
  topHolders: Holder[];
}

export async function getTopHolders(
  address: string,
  limit = TOP_HOLDERS_LIMIT,
): Promise<Holder[]> {
  const a = address.toLowerCase();
  const rows = await sql<{ holder_address: string; balance: string; last_updated_block: string | null }[]>`
    select holder_address, balance, last_updated_block
      from token_balances
     where token_address = ${a} and holder_address <> ${ZERO_ADDRESS} and balance > 0
     order by balance desc limit ${limit}
  `;
  return rows.map((r) => ({
    holderAddress: r.holder_address,
    balance: r.balance,
    lastUpdatedBlock: r.last_updated_block == null ? null : Number(r.last_updated_block),
  }));
}

// token page: triggers hydration lazily, returns what we have plus a hydrating
// flag, never blocks on the hydration itself.
export async function getTokenOverview(address: string): Promise<TokenOverview> {
  const a = address.toLowerCase();
  const [tok] = await sql<Row[]>`select * from tokens where address = ${a}`;
  const [hyd] = await sql<{ status: string; hydrated_at_block: string | null }[]>`
    select status, hydrated_at_block from token_hydration where token_address = ${a}
  `;
  const [st] = await sql<Row[]>`select * from token_stats where token_address = ${a}`;

  const hydrated = hyd?.hydrated_at_block != null;
  const hydrating = !hydrated;
  if (!hydrated && hyd?.status !== "hydrating") await requestHydration(a);

  return {
    address: a,
    hydrating,
    hydratedAtBlock: hyd?.hydrated_at_block == null ? null : Number(hyd.hydrated_at_block),
    name: (tok?.name as string | null) ?? null,
    symbol: (tok?.symbol as string | null) ?? null,
    decimals: tok?.decimals == null ? null : Number(tok.decimals),
    tokenType: (tok?.token_type as string | null) ?? null,
    totalSupply: tok?.total_supply == null ? null : String(tok.total_supply),
    stats: st
      ? {
          holderCount: Number(st.holder_count),
          transferCount: Number(st.transfer_count),
          firstTransferBlock: st.first_transfer_block == null ? null : Number(st.first_transfer_block),
          deployerAddress: (st.deployer_address as string | null) ?? null,
          deployerBalanceShare: st.deployer_balance_share == null ? null : Number(st.deployer_balance_share),
          top10Share: st.top10_share == null ? null : Number(st.top10_share),
        }
      : null,
    topHolders: hydrated ? await getTopHolders(a) : [],
  };
}

export interface NewToken {
  address: string;
  creator: string | null;
  creationTx: string | null;
  creationBlock: number | null;
  name: string | null;
  symbol: string | null;
}

// new token feed: contract deployments newest first, token metadata joined. a
// deployment is a tx with no `to` whose receipt carried a contract_address.
export async function newTokens(limit = 50, sinceBlock?: number): Promise<NewToken[]> {
  const rows = await sql<Row[]>`
    select c.address, c.creator, c.creation_tx, c.creation_block, t.name, t.symbol
      from contracts c
      left join tokens t on t.address = c.address
     where c.creation_block is not null
       ${sinceBlock != null ? sql`and c.creation_block >= ${sinceBlock}` : sql``}
     order by c.creation_block desc
     limit ${limit}
  `;
  return rows.map((r) => ({
    address: r.address as string,
    creator: (r.creator as string | null) ?? null,
    creationTx: (r.creation_tx as string | null) ?? null,
    creationBlock: r.creation_block == null ? null : Number(r.creation_block),
    name: (r.name as string | null) ?? null,
    symbol: (r.symbol as string | null) ?? null,
  }));
}

// everything a deployer has launched.
export async function deployerTokens(deployer: string, limit = 50): Promise<NewToken[]> {
  const d = deployer.toLowerCase();
  const rows = await sql<Row[]>`
    select c.address, c.creator, c.creation_tx, c.creation_block, t.name, t.symbol
      from contracts c
      left join tokens t on t.address = c.address
     where c.creator = ${d}
     order by c.creation_block desc nulls last
     limit ${limit}
  `;
  return rows.map((r) => ({
    address: r.address as string,
    creator: (r.creator as string | null) ?? null,
    creationTx: (r.creation_tx as string | null) ?? null,
    creationBlock: r.creation_block == null ? null : Number(r.creation_block),
    name: (r.name as string | null) ?? null,
    symbol: (r.symbol as string | null) ?? null,
  }));
}
