# fletch-oracle-mcp

```
>>--->  fletch
```

mcp server for fletch, the off-hours fair value oracle for tokenized
equities on robinhood chain. read-only data tools plus independent merkle
verification of any published price against the on-chain commit registry.

## tools

| tool | what it does |
| --- | --- |
| `list_tokens` | tracked stock tokens with ids and pool addresses |
| `get_fair_value` | latest fair value, confidence, band, regime, suspect flag for a symbol |
| `get_history` | paginated fair value history (from, to, limit, offset) |
| `get_accuracy` | realized error of off-hours predictions vs actual next-open prints |
| `verify_observation` | fetches the merkle proof, recomputes leaf and root locally, compares to the root committed on robinhood chain |

`verify_observation` reimplements the hash math in this package on purpose:
leaf = keccak256 of the canonical string `tokenId|cycleId|fairValue|confidence|timestamp`,
interior nodes are sorted-pair keccak256. it trusts nothing the api says
without recomputation, and with an rpc configured it also reads
`FletchCommits.getCommit(cycleId)` straight from the chain.

## configuration

| env var | required | meaning |
| --- | --- | --- |
| `FLETCH_API_URL` | yes | base url of a fletch api deployment |
| `FLETCH_API_KEY` | no | api key for higher rate limits, sent as `x-api-key` |
| `FLETCH_RPC_URL` | no | robinhood chain json-rpc url, enables the on-chain check |
| `FLETCH_COMMITS_ADDRESS` | no | contract override; defaults to the address the proof payload advertises |

## claude desktop

add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "fletch": {
      "command": "npx",
      "args": ["-y", "fletch-oracle-mcp"],
      "env": {
        "FLETCH_API_URL": "https://your-fletch-api.example",
        "FLETCH_RPC_URL": "https://your-robinhood-chain-rpc.example",
        "FLETCH_API_KEY": "flk_..."
      }
    }
  }
}
```

## claude code

```
claude mcp add fletch -e FLETCH_API_URL=https://your-fletch-api.example -- npx -y fletch-oracle-mcp
```

## the fine print

informational feed. not for use in liquidations, settlement, or as sole
pricing source. no warranty.
