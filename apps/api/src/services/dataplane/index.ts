/**
 * The data plane's public surface: router key verification, the passthrough dispatcher, the health
 * store the routing snapshot is built from, and the per-key model listing.
 *
 * Transport imports from here; nothing outside this directory reaches into a module inside it.
 *
 * What this build serves: **same-dialect passthrough**. Cross-dialect translation and the
 * Agent-SDK path are refused explicitly by name in `egress/mode.ts`, before any upstream call, and
 * that module is the seam both land on.
 */

export type { AttemptOutcome, AttemptPlan, UpstreamError } from "./attempt"
export { runAttempt } from "./attempt"
export { createTtlCache, type TtlCache, type TtlCacheOptions } from "./auth/cache"
export { bearerToken, credentialStyle, presentedRouterKey } from "./auth/presented"
export {
  createScopeLoader,
  type KeyScopeLoader,
  type KeyScopeTargets,
  type KeyTargetSource,
  keyScopeSnapshot,
  NO_TARGETS,
  repositoryScopeLoader,
  unscopedLoader,
} from "./auth/scope"
export {
  createRouterKeyVerifier,
  DEFAULT_KEY_CACHE_MAX_ENTRIES,
  DEFAULT_KEY_CACHE_NEGATIVE_TTL_MS,
  DEFAULT_KEY_CACHE_TTL_MS,
  type RouterKeyCacheOptions,
  type RouterKeyVerifier,
  type RouterKeyVerifierDeps,
  type VerifiedKey,
} from "./auth/verifier"
export {
  type BodyReadOptions,
  DEFAULT_MAX_BODY_BYTES,
  fingerprintSessionKey,
  type RequestBody,
  readRequestBody,
  rewriteModel,
} from "./body/read"
export {
  type ByteSpan,
  createRoutingScanner,
  DEFAULT_CONVERSATION_PREFIX_BYTES,
  type RoutingScanner,
  type ScanResult,
} from "./body/scanner"
export {
  DEFAULT_SESSION_HEADERS,
  type ResolvedSessionKey,
  resolveSessionKey,
  type SessionKeySource,
} from "./body/session"
export { accountCredential } from "./egress/credential"
export { upstreamModelsUrl, upstreamUrl } from "./egress/endpoint"
export { clientHeaders, upstreamHeaders } from "./egress/headers"
export {
  type EgressDecision,
  type EgressRejection,
  type EgressRejectionReason,
  egressRejectionError,
  type PassthroughEgress,
  resolveEgress,
} from "./egress/mode"
export {
  type AccountHealthState,
  breakerOptionsFor,
  buildSnapshot,
  createHealthStore,
  type HealthStore,
  overlayHealth,
} from "./health"
export {
  createRateLimiter,
  DEFAULT_RATE_LIMIT_MAX_KEYS,
  type RateLimitDecision,
  type RateLimitedKey,
  type RateLimiter,
  type RateLimiterOptions,
} from "./limits"
export { type ReachableModel, reachableModels } from "./models"
export {
  createDispatcher,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  type Dispatcher,
  type DispatcherDeps,
  type DispatchInput,
  type DispatchOptions,
} from "./orchestrator"
export { type CandidatePlan, planCandidates, type ServableCandidate } from "./plan"
export { type RelayObserver, relayResponse } from "./relay"
export {
  type DataPlaneClock,
  type FetchLike,
  type IngressDialect,
  type RequestObserver,
  type RequestSample,
  type RoutableAccount,
  type RoutingCatalog,
  routingView,
  SYSTEM_CLOCK,
} from "./types"
