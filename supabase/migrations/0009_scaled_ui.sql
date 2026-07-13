-- erc-8056 scaled-ui support. additive only.
--
-- robinhood stock tokens carry a uiMultiplier() that scales raw amounts into
-- effective shares and changes on corporate actions. the indexer stores the
-- effective per-share price in observations.pool_spot and records the
-- multiplier that produced it here, plus a flag for tokens that do not expose
-- the function. the engine flags a cycle corporate_action when the multiplier
-- changed within its window.

-- multiplier in force at the observation, as m = uiMultiplier / 1e18
-- (1.0 = no scaling, 10.0 = after a 10:1 split). defaults to 1 so existing
-- rows and non-erc-8056 tokens read as unscaled.
alter table observations
  add column if not exists ui_multiplier numeric(40, 18) not null default 1;

-- true when the token did not expose uiMultiplier() and the multiplier was
-- assumed to be 1.
alter table observations
  add column if not exists ui_multiplier_missing boolean not null default false;

-- set when the ui multiplier changed within the cycle window. the engine
-- excludes pre-change ticks from the twap and widens the band for the cycle.
alter table fair_values
  add column if not exists corporate_action boolean not null default false;
