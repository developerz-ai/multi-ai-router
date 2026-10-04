/**
 * Usage accounting. One record per upstream attempt, enqueued in memory and batch-written off the
 * request path by a background writer — docs/idea/08-observability.md#usagerecord.
 *
 * Callers import from here; nothing outside this directory reaches into a module inside it.
 */

export {
  createUsageRecorderFromEnv,
  type UsageRecorderFromEnvDeps,
} from "./fromEnv"
export { type BoundedQueue, createBoundedQueue } from "./queue"
export {
  errorClassOf,
  NO_TOKENS,
  outcomeOf,
  toUsageRecordRow,
  USAGE_SUCCESS,
  type UsageRecord,
} from "./record"
export {
  createNullUsageRecorder,
  createUsageRecorder,
  DEFAULT_USAGE_BATCH_SIZE,
  DEFAULT_USAGE_FLUSH_INTERVAL_MS,
  DEFAULT_USAGE_QUEUE_MAX,
  type UsageRecorder,
  type UsageRecorderOptions,
  type UsageStats,
  type UsageWriteFailure,
  type UsageWriter,
} from "./recorder"
export type { UsageRequestTerminal } from "./request-terminal"
export { createResponseObserver } from "./response-observer"
export type {
  ResponseObservationFacts,
  ResponseObservationSpec,
  ResponseObserver,
} from "./response-observer-types"
export {
  createTokenObserver,
  NO_TOKEN_OBSERVER,
  type TokenCounts,
  type TokenObserver,
  ZERO_TOKENS,
} from "./tokens"
