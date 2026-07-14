# spcx: pricing an asset with no reference price

a design note, not a spec, and not a plan to build. discovery keeps reporting
spcx (tokenized spacex) as the deepest pool on robinhood chain, deeper than
tsla, aapl and nvda combined. spacex is private: no exchange, no official
close, no next-open print. morrow's model has no anchor to hang spcx on, so it
cannot price it today, and it refuses to rather than publish a number it cannot
stand behind.

this note lays out what pricing spcx would actually take, what confidence such
a feed could honestly claim, why the pool being deep makes it more dangerous
not less, and the risks that would gate any decision to build it. read it and
decide. nothing here is implemented.

## why the current model does not apply

morrow prices a listed token as anchor + drift + onchain twap:

- the **anchor** is the last official close. it is a real, arm's-length price
  that exists every trading day.
- **drift** nudges the anchor with 24/7 proxy returns since that close.
- the **onchain twap** is blended in, but only up to a depth-scaled weight, and
  it is clamped to a maximum deviation around anchor+drift. that clamp is the
  anti-manipulation guardrail: a thin or pushed pool cannot drag fair value far
  from a price the market actually printed.

spcx removes the anchor. with no anchor there is nothing to drift from and,
more importantly, nothing to clamp the pool against. the one guardrail that
stops the pool from dragging the feed depends on the very thing spcx does not
have. so spcx is not "the same model without a close." it is a different
problem: estimate the current value of a private company from indirect signals,
none of which is a real-time price.

## what a no-reference model would need, and what each signal is worth

there is no single input that solves this. a defensible model would blend
several weak signals and be honest that the result is a range, not a price.

### last funding round valuation, as a pseudo-anchor

spacex's value is periodically set by primary raises and employee tender
offers (widely reported around the mid-hundreds of billions as of late 2024
into 2025; any real use must pull the current, sourced figure, not a number
recalled here). this is the closest thing to an arm's-length anchor.

- worth: it fixes the order of magnitude and a coarse level, arguably good to
  something like plus or minus 20 to 30 percent.
- limits: it is stale between rounds (months old), it is a step function that
  jumps at each round rather than moving continuously, and the shares that
  transact at that price are a tiny, gated slice. it anchors the level, not the
  day-to-day mark.

### comparables basket, as the drift

between rounds, a basket of public proxies could stand in for direction:
launch and space names, satellite and broadband operators as a stand-in for
starlink, and broad growth or tech beta. the basket's return since the last
hard reference would play the role drift plays for a listed token.

- worth: it can supply direction and a rough magnitude of change between
  rounds, the same idea as morrow's proxy drift.
- limits: the weights are a judgment call, the correlations are unproven and
  unstable, and no public company is a clean comp for spacex. this is genuine
  model risk, and it should be treated as a low-to-moderate-confidence signal,
  never as fact.

### secondary-market marks, as a pseudo-spot

private secondary venues (forge, equityzen, hiive, nasdaq private market,
caplight and similar) publish indicative bids and asks and completed-trade
marks for spacex. this is the nearest thing to an off-exchange price.

- worth: potentially the best continuous pseudo-spot, and the only signal that
  could act as an external reference to clamp the onchain pool against.
- limits: thin, wide bid/ask, delayed, often self-reported, and almost
  certainly licensed with redistribution restrictions. the data-rights problem
  is as large as the data-quality problem, and it is a legal question before it
  is an engineering one.

### fund marks, as a monthly cross-check

some mutual funds that hold spacex publish periodic nav marks for the position.

- worth: an independent, arm's-length fair-value mark from a sophisticated
  holder, useful as a monthly sanity check on the pseudo-anchor.
- limits: lagged, sparse (monthly at best), and not a trading price.

the shape of a model, if one were ever built: pseudo-anchor from the last
funding round, corrected between rounds by the comparables drift, cross-checked
and ideally clamped by licensed secondary marks and fund marks, with the
onchain pool used lightly if at all and never as the primary reference.

## what confidence it could honestly claim, and how it should degrade

structurally lower than any listed token, and the ui must say so.

- a listed token has a real close every day, so its freshness is high and its
  confidence can legitimately reach the top of the scale. spcx's freshest hard
  reference is a funding round (months old) or a thin secondary mark (days to
  weeks old, wide spread). the freshness input is structurally weak, so the
  confidence ceiling must be capped far lower. a spcx feed should probably never
  present confidence above roughly the low-to-mid range of morrow's 0-100 scale,
  no matter how calm the inputs look.
- confidence should decay with the age of the last hard reference and widen the
  band aggressively. the honest band is wide, on the order of plus or minus 10
  to 25 percent, and the feed should never show a tight band it cannot justify.
- the honest framing is that this is an estimate of a range, not a price. the
  product copy has to carry that, prominently, not in a footnote.

## the manipulation surface

this is the part that should stop the project short.

with no external reference, the onchain pool is the only continuous signal, and
a pool can be moved with capital. if the model leans on the pool, then whoever
moves the pool moves the published fair value. that is textbook oracle
manipulation, and morrow would be the oracle.

- for listed tokens the twap is clamped to a band around anchor+drift, so a
  funded push into a thin pool cannot drag the number. spcx has no anchor, so
  that clamp does not exist. the single guardrail that protects the listed feed
  is gone precisely here.
- the deepest-pool observation is a red flag, not a green light. a deep pool
  with no external reference is exactly the setup for manipulation: deep enough
  to look legitimate and pass a depth floor, with no reference price to
  contradict a push. depth that would be reassuring for a listed token is the
  opposite here.
- the usual mitigations are all weak without a reference. a longer twap window
  slows a push but does not stop a funded one. a depth requirement is met by the
  attacker who is providing the depth. deviation circuit breakers need a
  trustworthy level to deviate from, which is the missing piece. the only real
  defense is an external reference to clamp against, licensed secondary marks,
  which drags the whole data-licensing and legal problem back in.

put plainly: under anything like the current model, a spcx feed is structurally
manipulable, and the fix requires exactly the licensed external data that is the
hardest part to obtain.

## the honest risks

- **legal, and this is the gating one.** publishing a valuation for a private
  company is a materially different act from estimating the off-hours price of a
  listed one. for a listed stock there is a public last-sale price and morrow
  only interpolates between official prints. spacex has no public price, so
  publishing "spacex is worth x" is closer to producing an independent
  valuation of a private security and distributing it on-chain to anyone. that
  raises securities-law questions (who may rely on it, whether it functions as a
  benchmark, how it is marketed and to whom) that are out of scope for
  engineering judgment. this needs legal review before a single line of code.
- **data licensing.** secondary-market and fund-mark data almost certainly carry
  usage and redistribution restrictions. deriving an on-chain mark from them and
  committing it publicly may breach those terms. a licensing review sits next to
  the legal review.
- **the commit trail does not save it.** morrow's merkle-verifiable trail proves
  that the number published is the number that was committed. it says nothing
  about whether the number was a good estimate. for a reference-less,
  manipulable asset, verifiability is necessary and nowhere near sufficient. a
  provably-committed wrong price is still a wrong price, and here there is no
  official print to later reconcile against, so a bad mark may never be caught.
- **reputational.** a wrong or manipulated spacex mark is more damaging than a
  listed-token miss, because there is no correct answer to point back to. it
  would put morrow's credibility, which rests on the verifiable trail, behind a
  number that the trail cannot vouch for.

## recommendation

do not price spcx on the current model, and do not treat pool depth as a reason
to. if it is ever pursued, it is a separate product with its own model
(pseudo-anchor plus comparables plus licensed external marks), a hard confidence
ceiling, an explicit range-not-a-price framing throughout the ui, and a
mandatory legal and licensing review as a gate before any implementation begins.
the strength of the pool signal is a reason for more caution, not less.
