// @fletch/engine public surface. pure fair value math, the market calendar,
// cycle arithmetic, erc-8056 scaled-ui helpers, and the merkle commitment
// scheme. no i/o anywhere.

export {
  type Regime,
  type CalendarConfig,
  type WallTime,
  defaultCalendarConfig,
  wallTimeAt,
  wallTimeToUtc,
  dateKey,
  easterSunday,
  marketHolidays,
  isHolidayDate,
  isHalfDayDate,
  isTradingDay,
  regimeAt,
  lastCloseTime,
  nextOpenTime,
} from "./calendar.js";

export {
  type ModelConfig,
  type EngineObservation,
  type ProxyInput,
  type FairValueInput,
  type FairValueComponents,
  type FairValueResult,
  type FairValueFailure,
  type FairValueOutcome,
  type DriftResult,
  type ConfidenceInput,
  applyCorporateActionFilter,
  liquidityWeightedTwap,
  blendedDrift,
  scoreConfidence,
  computeFairValue,
} from "./fairvalue.js";

export {
  type DecodedMultiplier,
  UI_MULTIPLIER_ONE,
  decodeUiMultiplier,
  effectivePerSharePrice,
  multipliersDiffer,
} from "./scaledui.js";

export { type EthUsdTick, ethUsdUsable, dollarize } from "./dollarize.js";

export {
  type LeafInput,
  type MerkleTree,
  canonicalLeafString,
  hashLeaf,
  buildTree,
  proofForIndex,
  verifyProof,
} from "./merkle.js";

export { cycleIdFor, cycleStartMs, cycleEndMs } from "./cycle.js";
