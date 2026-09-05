/**
 * The routing engine's public API.
 *
 * Every export here is a **pure function over an injected snapshot**: the clock, account health,
 * pool membership, the key's scope, and any existing Session -> Account binding all arrive as
 * arguments. Nothing reads a clock, opens a socket, touches Postgres, or takes a lock — the
 * router sits in the hot path of every request, and `01-architecture.md`'s overhead budget makes
 * that a requirement rather than a preference.
 *
 * The chain, in the order a request walks it:
 *
 * 1. {@link resolveScope} — key scope ∩ pool membership, per pool, never widened.
 * 2. {@link filterCandidates} — active, not cooling, not exhausted, has quota, supports the model.
 * 3. {@link decideBinding} — an existing binding is honored, blocked, or invalidated. Never moved.
 * 4. {@link runPolicy} — one of six orderings, all of which respect the binding.
 * 5. {@link planNextAttempt} — bounded failover, and nothing at all once bytes are on the wire.
 * 6. {@link recordFailure} / {@link recordSuccess} — the breaker's state transitions.
 *
 * {@link selectAccounts} runs 1-4 in one call and returns the ordered candidates plus the
 * decision behind them.
 */

export { decideBinding } from "./binding"
export {
  type BreakerOptions,
  type BreakerPhase,
  type BreakerState,
  backoffMs,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_MAX_BACKOFF_MS,
  HEALTHY,
  JITTER_FRACTION,
  phase,
  recordFailure,
  recordSuccess,
} from "./breaker"
export {
  type AttemptFailure,
  classifyStatus,
  DEFAULT_MAX_IN_PLACE_RETRIES,
  type FailoverDecision,
  type FailoverOptions,
  type FailoverProgress,
  type FailoverStopReason,
  type FailureKind,
  isRetryable,
  markStreamed,
  maxAttempts,
  NO_ATTEMPTS,
  planNextAttempt,
  RETRYABLE_FAILURE_KINDS,
  recordAttempt,
} from "./failover"
export {
  type CandidateVerdict,
  evaluateCandidate,
  type FilterResult,
  filterCandidates,
} from "./filter"
export { rendezvousRank, rendezvousScore, scoreWithSeed, sessionSeed } from "./hash"
export { advertisedModels, type ModelResolution, resolveModel } from "./model"
export {
  DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS,
  type NoCandidatesInput,
  noCandidatesError,
} from "./no-candidates"
export {
  leastUsed,
  POLICIES,
  type Policy,
  type PolicyInput,
  type PolicyOptions,
  type PolicyOutput,
  priorityFailover,
  quotaAware,
  roundRobin,
  runPolicy,
  sticky,
  weighted,
} from "./policies"
export {
  continuousHeadroom,
  DEFAULT_QUOTA_SPENT_THRESHOLD,
  earliestReset,
  findSpentWindow,
  isWindowSpent,
  mergeQuotaWindows,
} from "./quota"
export type {
  BindingDecision,
  BindingInvalidationReason,
  FilterReason,
  GroupDecision,
  PolicyNote,
  RecoverableFilterReason,
  RejectedCandidate,
  ScopeDiagnostics,
  SelectionDecision,
  SelectionFailure,
  SelectionResult,
  SelectionSuccess,
} from "./result"
export { isRecoverableFilterReason, RECOVERABLE_FILTER_REASONS } from "./result"
export { isInScope, resolveScope, type ScopeResolution } from "./scope"
export { selectAccounts } from "./select"
export type {
  AccountHealth,
  AccountSnapshot,
  BoundCooldownBehavior,
  Candidate,
  KeyScopeSnapshot,
  LeastUsedMeasure,
  LimiterReading,
  PoolMembership,
  PoolSnapshot,
  RoutingSnapshot,
  ScopedAccount,
  ScopeGroup,
  SelectionOptions,
  SelectionRequest,
  SessionBinding,
} from "./types"
