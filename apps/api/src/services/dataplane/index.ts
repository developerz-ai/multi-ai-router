/**
 * The data plane's public surface: router key verification, the passthrough dispatcher, the health
 * store the routing snapshot is built from, and the per-key model listing.
 *
 * Transport imports from here; nothing outside this directory reaches into a module inside it.
 *
 * Three egress modes, decided in `egress/mode.ts`: **same-dialect passthrough**, cross-dialect
 * **translation**, and **Agent-SDK re-synthesis** for Claude subscriptions. A dialect pair with no
 * translator and a provider with no implementation are refused there by name, before any upstream
 * call. Which transport an attempt takes is the `kind` on a `ServableCandidate`; both answer with
 * one `AttemptOutcome`, so everything downstream of `chain.ts` is written once.
 */

export type { AttemptOutcome, AttemptPlan, UpstreamError } from "./attempt"
export { attemptDeadline, runAttempt } from "./attempt"
export { createTtlCache, type TtlCache, type TtlCacheOptions } from "./auth/cache"
export { stampLastUsed } from "./auth/last-used"
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
export { answeredFailure, type ChainFailure, foldChainFailure, routerFailure } from "./chain-error"
export { accountCredential } from "./egress/credential"
export {
  upstreamCountTokensUrl,
  upstreamEmbeddingsUrl,
  upstreamModelsUrl,
  upstreamUrl,
} from "./egress/endpoint"
export { clientHeaders, upstreamHeaders } from "./egress/headers"
export {
  type AgentSdkEgress,
  type EgressDecision,
  type EgressRejection,
  type EgressRejectionReason,
  egressRejectionError,
  type PassthroughEgress,
  resolveEgress,
  type TranslateEgress,
} from "./egress/mode"
export {
  type AccountHealthState,
  breakerOptionsFor,
  createHealthStore,
  DEFAULT_PROBE_HOLD_MS,
  type HealthStore,
  type HealthStoreOptions,
  type ProbeAdmission,
} from "./health"
export {
  createRateLimiter,
  DEFAULT_RATE_LIMIT_MAX_KEYS,
  keyRateLimitedError,
  type RateLimitDecision,
  type RateLimitedKey,
  type RateLimiter,
  type RateLimiterOptions,
} from "./limits"
export { type ReachableModel, reachableModel, reachableModels } from "./models"
export {
  createDispatcher,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  type Dispatcher,
  type DispatcherDeps,
  type DispatchInput,
  type DispatchOptions,
  type TranslationOptions,
} from "./orchestrator"
export {
  type CandidatePlan,
  type HttpServableCandidate,
  planCandidates,
  type SdkServableCandidate,
  type ServableCandidate,
} from "./plan"
export { admitHalfOpenProbe, type HalfOpenProbe } from "./probe"
export {
  createQuotaWindowWriter,
  type QuotaWindowWriter,
  type QuotaWindowWriterDeps,
  type QuotaWindowWriterStats,
} from "./quota-writer"
export { type RelayObserver, relayResponse } from "./relay"
export { relayUpstreamError } from "./relay-error"
export { relayTranslatedResponse, type TranslatedRelayInput } from "./relay-translate"
export { runSdkAttempt, type SdkAttemptInput, type SdkSessionContext } from "./sdk-attempt"
export {
  type SessionBindings,
  type SessionStoreEnvDeps,
  sessionBindings,
  sessionStoreFromEnv,
} from "./session-binding"
export { buildSnapshot, overlayHealth } from "./snapshot"
export { createTranslatedRequestBody, type TranslatedRequestBody } from "./translate-body"
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
  type UpstreamOperation,
} from "./types"
