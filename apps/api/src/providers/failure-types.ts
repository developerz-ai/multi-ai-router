import type { QuotaWindowState, ResetSource, UtilizationSource } from "@multi-ai-router/core"

/**
 * What an upstream response *means*, provider-independently: rate-limit readings, failure kinds and
 * classifications. Split out of `types.ts` (the driver contract) by responsibility; `types.ts`
 * re-exports every name, so importers are unchanged.
 */

/**
 * One limiter's reading. `limiter` is the provider's own name for the window (`requests`,
 * `tokens`, `input-tokens`, …) rather than an enum, because the set differs per provider and
 * inventing a mapping would lose information the operator needs.
 */
export interface RateLimitWindow {
  readonly limiter: string
  readonly limit?: number
  readonly remaining?: number
  /** Fraction of the window consumed, 0..1. Absent when the provider reported no headroom. */
  readonly utilization?: number
  readonly utilizationSource: UtilizationSource
  readonly resetsAt?: Date
  readonly resetAfterSeconds?: number
  readonly resetSource: ResetSource
}

/**
 * Normalized rate-limit / quota reading. `resetSource` is `provider-reported` when the upstream said
 * something and `unknown` when it did not. `estimated` marks a reset that is ours, and only two
 * places mint one: a classification rule's pinned re-test cadence for a limit that names no instant
 * (`failure/classify.ts`, `withEstimatedReset` — Kimi, OpenRouter), and an inferred epoch-seconds
 * unit (`rate-limit/duration.ts`). Every other "unknown" becomes a backoff guess in the circuit
 * breaker, not here.
 */
export interface RateLimitSignal {
  /** The upstream says this credential is limited *now*. */
  readonly limited: boolean
  readonly retryAfterSeconds?: number
  readonly resetsAt?: Date
  readonly resetSource: ResetSource
  readonly windows: readonly RateLimitWindow[]
  /**
   * The same reading in the router's own window vocabulary, for the providers that speak it.
   *
   * This is the **only** channel by which an Account's `quotaWindows` are ever written: the health
   * store folds it in exactly as it folds in `windows`, and everything downstream — the filter's
   * `quota-window-spent`, `quota-aware`'s ranking, the console's per-window countdowns — reads what
   * lands there and nothing else.
   *
   * Absent on every HTTP reply **except** Codex's: `openai-oauth-quota.ts` parses the
   * `x-codex-primary-*` / `-secondary-*` headers it already returns on every reply and maps them
   * onto `five_hour` and `seven_day` (an unmatched minute count travels in {@link windows}).
   * Each named window it builds is `advisory: true`, so it never blocks routing — see the field
   * doc on `QuotaWindowState.advisory` and `services/routing/quota.ts`. Absent differs from
   * empty: absent says "nothing to report about named windows" and leaves what is already known
   * standing, where `[]` would claim this account has none.
   */
  readonly quotaWindows?: readonly QuotaWindowState[]
}

/**
 * The outcomes an upstream failure can have. `rate-limited` and `credits-exhausted` are separate
 * for the same reason `QuotaExhaustedError` and `CreditsExhaustedError` are: a clock fixes the
 * first, only a human fixes the second.
 *
 * The last three exist only on the Agent-SDK transport, and they are named rather than folded into
 * `server-error` because each one has a *different recovery* — replay this account, wait then fork,
 * or give up on the subprocess (docs/idea/11-anthropic-agent-sdk.md §9). A single `server-error`
 * would make all three retry the same wrong way.
 */
export const UPSTREAM_FAILURE_KINDS = [
  "rate-limited",
  "credits-exhausted",
  "auth",
  "invalid-request",
  /**
   * This account's upstream does not serve the model asked for. Not `invalid-request`: the request
   * may be perfectly good at the next account, which serves a different vendor's names. Retryable,
   * and never held against the account's health — it answered, about a name it was never meant for.
   */
  "model-unsupported",
  "server-error",
  /**
   * The provider's shared backend is busy — OpenCode Go's `[overloaded] the server is overloaded`
   * (sent as a `429`), Anthropic's `overloaded_error`, Kimi's `engine_overloaded_error`. About the
   * provider, not this credential: retried with backoff, never a breaker strike, a cooldown or a
   * recovery permit, and never answered as `quota_exhausted` (`docs/idea/05-routing-and-failover.md`).
   */
  "overloaded",
  /** The SDK no longer holds the session we resumed. Evict the binding, replay once in place. */
  "stale-session",
  /** The SDK session is still running as a background agent. Bounded waits, then fork it. */
  "busy-session",
  /** The `claude` subprocess died. Reported honestly, never re-read as an auth failure. */
  "subprocess-crash",
  "unknown",
] as const

export type UpstreamFailureKind = (typeof UPSTREAM_FAILURE_KINDS)[number]

/** The provider-independent facts read out of a provider-shaped error body. */
export interface UpstreamErrorFacts {
  readonly type?: string
  readonly code?: string
  readonly message?: string
}

export interface FailureClassification {
  readonly kind: UpstreamFailureKind
  readonly status: number
  /**
   * Whether the router may try the **next candidate account**. Never the same account, and never
   * once bytes have reached the client (docs/idea/05-routing-and-failover.md).
   */
  readonly retryable: boolean
  /**
   * Which signal decided this — `http-status:429`, `openai:insufficient_quota`,
   * `minimax:base_resp-1008`. Recorded so a misclassification is debuggable rather than a mystery.
   */
  readonly signal: string
  /** The upstream's own message, when it gave one. Never rendered into a client-facing error. */
  readonly message?: string
  readonly rateLimit: RateLimitSignal | null
  /**
   * The refusal is caused by the request, not the account's capacity: the same request fails the
   * same way on every account (`claude-sdk:extra-usage-gated`, provoked by a client's harness
   * fingerprint — `claude-sdk/scrub.ts`). Failover may still try the next account, but the attempt
   * must not cool or strike this one. Absent means account-attributable as before.
   */
  readonly requestAttributable?: boolean
  /**
   * The refusal can never succeed for this request on this pool, however long the client waits:
   * the Agent SDK's `claude-sdk:structured-output-unsupported` (no carrier for the field, on any
   * clock) and the third-party wording of `claude-sdk:extra-usage-gated` (the fingerprint is in the
   * body the client resends).
   * A chain whose every account refused it this way ends as the request wall even when fewer than
   * `REQUEST_WALL_AFTER` were tried (`routing/failover.ts`, `walled`). A refusal that clears with
   * time must not carry it (developerz.ai plan 101 slice 09, R1).
   */
  readonly permanentForRequest?: boolean
  /**
   * A `rate-limited` refusal about the **model** on this account, not the account: OpenRouter's
   * relay of an upstream provider's throttle (`Provider returned error`, `… is temporarily
   * rate-limited upstream`). That model is held off this account until its reset; the account keeps
   * serving every other model (`HealthStore.throttleModel`). Absent: about the account, as before.
   */
  readonly modelScoped?: boolean
  /**
   * An `invalid-request` about **this vendor's wire**, not the request: Gemini refusing a tool call
   * another vendor's model made (no thought signature), or a field its schema does not name. Every
   * account of the same provider answers alike, so the chain drops that provider's remaining
   * candidates and goes on to the next one; another vendor may serve the body as it stands. No
   * strike, and no hold on the model: the next request is a different body. With no candidate left,
   * the upstream's own `4xx` is the answer. Absent: a bad request is bad at every account.
   */
  readonly providerScoped?: boolean
  /**
   * An `invalid-request` about **this account's own settings**: an OpenRouter provider filter or data
   * policy that leaves no endpoint, one request larger than the account's in-flight budget. The next
   * account, of the same provider included, may serve the body as it stands. No strike, no hold on
   * the model. With no candidate left, the upstream's own `4xx` is the answer. Absent: a bad request
   * is bad at every account.
   */
  readonly accountScoped?: boolean
  /**
   * A spend refusal that may be the **key's own cap**: it names the key, or it names neither the key
   * nor the prepaid balance. Only then does a near-spent key reading explain it and lend its reset
   * (`routing/plan-reset.ts`). Never set on a refusal that names the balance: no key reset refills
   * one, and calling it a clock would answer `429` for a wall only a top-up clears (non-negotiable 7).
   */
  readonly keyCap?: boolean
  /**
   * A spend refusal that names the **prepaid balance** itself: OpenRouter's
   * `limit_source: openrouter_credits`, `Insufficient credits`, `settings/credits`. The opposite
   * evidence to {@link keyCap}: no key reset refills a balance, so it borrows no cap's reset,
   * not even a fully spent one's, and stays `exhausted` until a human tops up. Absent on a refusal
   * that says nothing either way, which is the only kind the spent-cap fallback is for.
   */
  readonly namesBalance?: boolean
}

/** Parsed bounded successful-body evidence; no I/O, raw body logging, or response replacement. */
export interface ResponseObservationDescriptor {
  readonly terminalPolicy: "evidence-only" | "require-completion"
  readonly inspectPayload?: (
    payload: unknown,
    event: string | undefined,
  ) => FailureClassification | null
  /**
   * The upstream ends a long stream itself, by dropping it with no terminal frame, at a cap of its
   * own. A transport failure of a stream that never completed, after at least the router's cap
   * minimum (`UPSTREAM_STREAM_CAP_MIN_SECONDS`), is recorded under `signal` rather than the
   * generic `upstream_error`, and the failure line counts the event types that arrived. The router
   * adds no cut of its own.
   */
  readonly streamCap?: { readonly signal: string }
}
