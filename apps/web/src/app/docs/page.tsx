// docs page: what the feed is, methodology, api reference, mcp install,
// the disclaimer. static server component.

import { DISCLAIMER, MARK } from "@/lib/constants";

export default function DocsPage() {
  return (
    <div>
      <h1>what morrow is</h1>
      <p className="dim">
        tokenized equities on robinhood chain trade around the clock, but their underlying
        stocks only price during nyse and nasdaq hours. morrow publishes a fair value estimate
        per tracked stock token while the underlying market is closed, with a confidence band,
        and commits a merkle root of every observation on robinhood chain so each published
        price is later verifiable. a morrower makes arrows. {MARK}
      </p>

      <h2>methodology, short version</h2>
      <div className="panel">
        <div className="kv">
          <span className="k">anchor</span>
          <span className="v">last official market close per token</span>
          <span className="k">drift</span>
          <span className="v">
            weighted blend of 24/7 proxy signal returns since that close, capped; stale proxies
            are excluded
          </span>
          <span className="k">onchain</span>
          <span className="v">
            liquidity-weighted twap of the selected uniswap pool over the trailing window. the
            pool can live in uniswap v2, v3, or v4; each venue&apos;s price and ±2% depth are
            read into one common measure, so the depth floor means the same thing everywhere.
            weight scales down as depth falls below the floor; the twap is clamped to a maximum
            deviation around anchor+drift so a thin pool cannot drag fair value
          </span>
          <span className="k">fair value</span>
          <span className="v">depth-scaled blend of the onchain twap and anchor+drift</span>
          <span className="k">confidence</span>
          <span className="v">0-100 from input freshness, pool depth, and proxy agreement</span>
          <span className="k">band</span>
          <span className="v">widens as confidence falls</span>
          <span className="k">spike guard</span>
          <span className="v">
            an onchain move beyond the spike threshold inside one window with flat proxies is
            clamped to the band edge and published with suspect=true, never hidden
          </span>
          <span className="k">regimes</span>
          <span className="v">
            market_open (passthrough, official prices live), after_hours, weekend, holiday.
            nyse calendar computed in America/New_York including half days
          </span>
        </div>
      </div>

      <h2>anchors</h2>
      <p className="dim">
        the anchor is the last official close per token; the next-open print feeds the accuracy
        stats. the indexer can maintain both automatically: a configurable delay after the
        16:00 et close (13:00 on half days) it inserts the close, and a delay after the 09:30 et
        open it inserts the open print, skipping weekends and holidays. an automated price that
        jumps more than the deviation threshold from the previous anchor is rejected unless a
        corporate action explains it, and a missing anchor past its deadline pages the operator.
        when an expected close is missed, the engine keeps publishing but caps confidence and
        widens the band (a stale-anchor cycle), rather than going dark. the admin endpoints
        remain the manual override for both close and open:
      </p>
      <pre className="block">{`POST /v1/admin/anchors   (bearer ADMIN_TOKEN)
  { "symbol": "tsla", "kind": "close", "price": 250.10,
    "marketTs": "2026-07-10T20:00:00Z" }`}</pre>

      <h2>verification</h2>
      <p className="dim">
        each cycle, every observation becomes a canonical leaf:
        tokenId|cycleId|fairValue|confidence|timestamp, hashed with keccak256. leaves build a
        sorted-pair merkle tree; the root is committed to the MorrowCommits contract. fetch a
        proof from /v1/proof, recompute the root yourself, and compare against
        getCommit(cycleId) on-chain. the commits page runs this check in your browser; the mcp
        tool verify_observation also checks the chain over rpc.
      </p>

      <h2>spreads and alerts</h2>
      <p className="dim">
        the <a href="/spreads">mispricings board</a> ranks tokens by the absolute spread between
        the onchain pool price (multiplier-adjusted and dollarized) and morrow fair value,
        refreshed live. a public telegram channel posts when a token&apos;s absolute spread crosses
        a threshold, with hysteresis and a per-token cooldown so it does not spam on oscillation.
        messages are data statements only, with an &quot;informational feed, not trading advice&quot;
        footer. the alert bot is generation-gated by a dry-run flag until the operator wires the
        channel.
      </p>

      <h2>chainlink, and what morrow is not</h2>
      <p className="dim">
        chainlink is robinhood chain&apos;s official oracle and feeds stock token prices. morrow
        does not compete with that feed. morrow&apos;s product is the off-hours fair value blend
        and the verifiable commit trail, a different object. do not frame morrow as a chainlink
        replacement.
      </p>

      <h2>accuracy receipts</h2>
      <p className="dim">
        each week morrow scores its pre-open fair value against the actual next-open print, per
        token, and publishes a card with the mean absolute error, the best call, and the cycles
        committed on-chain. the <a href="/receipts">receipts</a> page lists them, newest first;
        the api serves the markdown and a rendered png. receipts are generated only, never
        auto-posted.
      </p>

      <h2>api reference</h2>
      <table className="data">
        <thead>
          <tr>
            <th>endpoint</th>
            <th>returns</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>GET /v1/tokens</td>
            <td className="dim">tracked tokens with ids and pools</td>
          </tr>
          <tr>
            <td>GET /v1/prices</td>
            <td className="dim">latest fair value for all tokens</td>
          </tr>
          <tr>
            <td>GET /v1/prices/:symbol</td>
            <td className="dim">latest plus 24h history</td>
          </tr>
          <tr>
            <td>GET /v1/prices/:symbol/history?from&amp;to&amp;limit&amp;offset</td>
            <td className="dim">paginated history</td>
          </tr>
          <tr>
            <td>GET /v1/commits, /v1/commits/:cycleId</td>
            <td className="dim">commit records with roots and tx hashes</td>
          </tr>
          <tr>
            <td>GET /v1/proof/:symbol/:cycleId</td>
            <td className="dim">merkle proof payload for independent verification</td>
          </tr>
          <tr>
            <td>GET /v1/accuracy/:symbol</td>
            <td className="dim">realized error vs actual next-open prints</td>
          </tr>
          <tr>
            <td>GET /v1/spreads</td>
            <td className="dim">onchain vs fair spread per token, sorted by divergence</td>
          </tr>
          <tr>
            <td>GET /v1/receipts, /v1/receipts/:week</td>
            <td className="dim">weekly accuracy cards; card.png for the rendered image</td>
          </tr>
          <tr>
            <td>GET /health</td>
            <td className="dim">per-subsystem status, cycle age, per-source staleness</td>
          </tr>
        </tbody>
      </table>
      <p className="dim">
        anonymous calls are rate limited. send an api key in x-api-key for higher limits. when
        x402 is enabled, price endpoints answer 402 with payment requirements for agent
        pay-per-query.
      </p>

      <h2>mcp install</h2>
      <p className="dim">
        the morrow-oracle-mcp package gives agents read access plus independent verification.
        claude desktop config:
      </p>
      <pre className="block">{`{
  "mcpServers": {
    "morrow": {
      "command": "npx",
      "args": ["-y", "morrow-oracle-mcp"],
      "env": {
        "MORROW_API_URL": "https://your-morrow-api.example",
        "MORROW_RPC_URL": "https://your-robinhood-chain-rpc.example"
      }
    }
  }
}`}</pre>

      <h2>the fine print</h2>
      <p className="dim">{DISCLAIMER}</p>
    </div>
  );
}
