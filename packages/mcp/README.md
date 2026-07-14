# @morrow/mcp-server

```
>>--->  morrow
```

mcp server for morrow, the off-hours fair value oracle for tokenized equities
on robinhood chain. it gives an agent read-only access to morrow's data plus
one thing an ordinary api client cannot do: independently verify any published
price against the on-chain commit registry, trusting nothing morrow says.

this is morrow's agent distribution and it is free. it makes no payments and
touches no settlement path.

## install

nothing to install by hand. the claude configs below run it with `npx`, which
fetches and caches it on first use. to run it directly:

```
npx -y @morrow/mcp-server
```

it speaks mcp over stdio and needs `MORROW_API_URL` set (see configuration).

## tools

| tool | what it does |
| --- | --- |
| `list_tokens` | tracked stock tokens with ids and pool addresses |
| `get_fair_value` | latest fair value, confidence 0-100, band, regime, suspect flag, and decomposition (anchor, drift, onchain twap and spot) for a symbol |
| `get_history` | paginated fair value history for a symbol (from, to, limit, offset) |
| `get_accuracy` | realized error of each off-hours prediction versus the actual next official open, with rolling mean, median, p90 and signed bias |
| `verify_observation` | fetches the merkle proof, recomputes the leaf and root locally, and compares to the root committed on robinhood chain |

## configuration

| env var | required | meaning |
| --- | --- | --- |
| `MORROW_API_URL` | yes | base url of a morrow api deployment |
| `MORROW_API_KEY` | no | api key for higher rate limits, sent as `x-api-key` |
| `MORROW_RPC_URL` | no | robinhood chain json-rpc url; enables the on-chain check in `verify_observation` |
| `MORROW_COMMITS_ADDRESS` | no | contract override; defaults to the address the proof payload advertises |

## claude desktop

add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "morrow": {
      "command": "npx",
      "args": ["-y", "@morrow/mcp-server"],
      "env": {
        "MORROW_API_URL": "https://your-morrow-api.example",
        "MORROW_RPC_URL": "https://your-robinhood-chain-rpc.example",
        "MORROW_API_KEY": "flk_..."
      }
    }
  }
}
```

## claude code

```
claude mcp add morrow \
  -e MORROW_API_URL=https://your-morrow-api.example \
  -e MORROW_RPC_URL=https://your-robinhood-chain-rpc.example \
  -- npx -y @morrow/mcp-server
```

## verify_observation, worked

the point of morrow is that you never have to trust it. `verify_observation`
proves a published price was committed on-chain, using math this package runs
itself and a root it reads from the chain over your own rpc. morrow's api is
the thing being checked, not the source of truth.

call it with a symbol and a cycle id:

```
verify_observation({ symbol: "tsla", cycleId: 2973456 })
```

it returns (abbreviated hashes):

```json
{
  "verified": true,
  "canonicalString": "1|2973456|407.34000000|21|1768335600",
  "recomputedLeaf": "0x9a3f…e11c",
  "leafMatches": true,
  "recomputedRoot": "0x9f3c8e2b…a41e",
  "apiRoot": "0x9f3c8e2b…a41e",
  "rootMatchesApi": true,
  "onchain": {
    "checked": true,
    "onchainRoot": "0x9f3c8e2b…a41e",
    "rootMatchesOnchain": true
  },
  "txHash": "0x77aa1c93…4d10",
  "contract": "0x…",
  "chainId": 4663
}
```

how to read it, and why it is trustworthy:

1. `canonicalString` is the exact record `tokenId|cycleId|fairValue|confidence|timestamp`.
   the server hashes it here, in this package, with keccak256 to get
   `recomputedLeaf`. `leafMatches` confirms that hash equals the leaf the api
   claimed, so the api did not hand you a different preimage.
2. `recomputedRoot` is the sorted-pair keccak256 fold of that leaf up the proof,
   computed here, not taken from the api.
3. `onchainRoot` is read from `MorrowCommits.getCommit(cycleId)` over your rpc.
   this is the only value you have to trust, and it does not come from morrow.
4. `rootMatchesOnchain` is the decisive line: recomputed root equals the root
   the chain holds. when it is true, this exact price was committed on-chain
   for this cycle. if morrow had served a different price, the leaf and the
   recomputed root would change and this check would be false, so `verified`
   would be false.

without `MORROW_RPC_URL` the tool still recomputes the leaf and root and
compares them to the api's claimed root (`rootMatchesApi`), and reports
`onchain.checked: false`. that catches an inconsistent api but not a lying one.
for a real proof, set the rpc so the root comes from the chain.

## the fine print

informational feed. not for use in liquidations, settlement, or as sole
pricing source. no warranty.
