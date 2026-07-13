// eth/usd dollarization for weth-quoted pools. a pool quoted in weth prices a
// stock token in eth, not dollars. fair value is dollar denominated, so a
// weth pool's price and depth must be multiplied by an eth/usd rate before
// the engine can use them.
//
// the guiding rule: a stale eth/usd rate must never produce a published
// price. it is better to skip the onchain observation for that token (which
// degrades confidence through the freshness and depth subscores) than to
// dollarize with a wrong rate. these helpers are pure; the reader gates on
// ethUsdUsable before calling dollarize, and skips the token when it is not
// usable.

export interface EthUsdTick {
  rate: number;
  tsMs: number;
}

// whether an eth/usd tick can be trusted right now: present, a finite
// positive rate, and no older than the staleness budget.
export function ethUsdUsable(
  tick: EthUsdTick | null | undefined,
  nowMs: number,
  stalenessMs: number
): boolean {
  if (!tick) return false;
  if (!Number.isFinite(tick.rate) || tick.rate <= 0) return false;
  return nowMs - tick.tsMs <= stalenessMs;
}

// convert a quote-denominated value (weth per share, or weth depth) into
// dollars. caller must have already confirmed the rate is usable.
export function dollarize(quoteValue: number, ethUsdRate: number): number {
  return quoteValue * ethUsdRate;
}
