// @fletch/engine public surface. pure fair value math, the market calendar,
// cycle arithmetic, and the merkle commitment scheme. no i/o anywhere.

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
  liquidityWeightedTwap,
  blendedDrift,
  scoreConfidence,
  computeFairValue,
} from "./fairvalue.js";

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
