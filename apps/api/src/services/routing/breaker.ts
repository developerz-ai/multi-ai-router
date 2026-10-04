/**
 * The circuit breaker, as pure state transitions over an injected clock.
 *
 * | State | Meaning | Exit |
 * |---|---|---|
 * | `active` | Eligible for selection. | — |
 * | `cooling_down` | Excluded. **Temporary — a clock will fix it.** | Reset instant passes, then a half-open probe. |
 * | half-open | One request through as a probe. | Success -> `active`. Failure -> `cooling_down` at the next backoff step. |
 * | `exhausted` | Excluded. **Permanent until a human acts.** The breaker never schedules a retry. | An operator tops up, then a re-check or a successful probe. |
 * | `cooling_down` + `credential-rejected` | An API key the provider refused. Excluded, reported as needing a human — and still re-tested on a long clock that doubles per refused re-test, up to a cap. Nothing else in flight moves it (`credential-rejection.ts`). | Cooldown passes, then a half-open probe. A fixed key (or a misread limit) serves; a dead one cools again, for longer. |
 *
 * `cooling_down` and `exhausted` are never conflated, and the difference is mechanical rather
 * than cosmetic: `exhausted` carries **no** `cooldownUntil`, so no amount of clock advance moves
 * it. {@link phase} returns `blocked` for it forever. That is the invariant the tests pin.
 *
 * Backoff prefers the provider-reported reset — it is the truth. Exponential backoff is the
 * fallback for when nothing was reported, and it is labeled `unknown` rather than dressed up as
 * a fact. Jitter is a caller-supplied fraction, so this module reads no randomness either.
 */

import type { AccountStatus, AuthKind, ResetSource } from "@multi-ai-router/core"
import { backoffMs, reportedReset } from "./backoff"
import { refusalStands, rejectCredential } from "./credential-rejection"
import type { AttemptFailure } from "./failover"

/**
 * Why a cooldown is not an ordinary one. Absent on every cooldown a limit or a failure streak formed.
 *
 * `credential-rejected`: the provider refused this account's key. Routing treats it like any
 * cooldown — out until the instant, then one probe — but everything that *reports* it says a human
 * should look at the key, because that is the likelier truth.
 */
export type CooldownReason = "credential-rejected"

export interface BreakerState {
  readonly status: AccountStatus
  /** Absent on `active`, and absent on `exhausted` **by definition**. */
  readonly cooldownUntil?: Date
  readonly cooldownSource: ResetSource
  /** {@link CooldownReason}. Only ever present on `cooling_down`. */
  readonly cooldownReason?: CooldownReason
  readonly consecutiveFailures: number
}

export const HEALTHY: BreakerState = {
  status: "active",
  cooldownSource: "unknown",
  consecutiveFailures: 0,
}

export interface BreakerOptions {
  /** First backoff step. Doubles per consecutive failure. */
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
  /** Consecutive 5xx / connection failures before the breaker trips. */
  readonly failureThreshold?: number
  /** Actual designated recovery attempts retrip on an account failure. */
  readonly recoveryProbe?: boolean
  /** Jitter fraction in `[0, 1)`, supplied by the caller. 0 keeps the math deterministic. */
  readonly jitter?: number
  /** Decides where an auth failure lands — see {@link AUTH_FAILURE_LANDING}. */
  readonly authKind?: AuthKind
  /**
   * How long a rejected API key sits out before it is re-tested, on its first refusal.
   * `ROUTING_AUTH_FAILURE_COOLDOWN_MS`. Doubles per refused re-test.
   */
  readonly authFailureCooldownMs?: number
  /** Ceiling on that doubling. `ROUTING_AUTH_FAILURE_MAX_COOLDOWN_MS`. */
  readonly authFailureMaxCooldownMs?: number
}

/**
 * Where an auth failure lands, by what the account authenticates with.
 *
 * A refreshable token (`oauth`) can be *re*-authorized, and nothing else will bring it back:
 * `needs_reauth`, a standing block a completed login ends.
 *
 * A key — or a local endpoint that presents no credential at all and is suddenly behind something
 * that checks one — lands on a long `cooling_down` labeled `credential-rejected`. Through 2.14.0 it
 * landed on `disabled`, the operator's own word for "switched off", which no clock or probe ever
 * left. Two things were wrong with that, and production paid for both on 2026-10-02: an upstream
 * that answers a *spent plan* with `403` (Kimi does, in at least three wordings) parked a healthy
 * account until a human noticed, and the router told every caller the account was `disabled` while
 * its stored row said `active`. A rejected key is still reported as needing a human — it most
 * likely does — but the account is re-tested on a clock, and one probe is all a dead key costs.
 *
 * Total over `AuthKind`, so a new one is decided here rather than defaulting into the wrong state.
 */
const AUTH_FAILURE_LANDING: Readonly<Record<AuthKind, "needs-reauth" | "credential-rejected">> = {
  oauth: "needs-reauth",
  "api-key": "credential-rejected",
  none: "credential-rejected",
}

export const DEFAULT_FAILURE_THRESHOLD = 3

export type BreakerPhase =
  /** Eligible. */
  | "closed"
  /** Cooling down, reset still ahead. */
  | "open"
  /** Reset passed: one probe may go through. */
  | "half-open"
  /** No timer will change this. Only an operator. */
  | "blocked"

export function phase(state: BreakerState, now: Date): BreakerPhase {
  if (state.status === "exhausted" || state.status === "needs_reauth") return "blocked"
  if (state.status === "disabled") return "blocked"
  if (state.status !== "cooling_down") return "closed"
  if (state.cooldownUntil === undefined) return "open"
  return state.cooldownUntil.getTime() > now.getTime() ? "open" : "half-open"
}

export function recordFailure(
  state: BreakerState,
  failure: AttemptFailure,
  now: Date,
  options: BreakerOptions = {},
): BreakerState {
  switch (failure.kind) {
    // Faults whose cause is the **request**, not the account. They say nothing about this
    // account's health, so they leave its streak and its status exactly where they were.
    //
    // `busy-session` is the one that had to be learned. It reached here as `server-error` and so
    // counted toward the failure threshold — three of them in a row on one account and a
    // subscription that was answering fine went `cooling_down`. Under an agent workload those
    // collisions arrive fast and land on account after account, so a per-request fault could walk
    // a healthy pool into a cooldown cascade and answer the next caller as though there were no
    // capacity (2026-09-06). A conversation whose session is busy is a fact about that
    // conversation; the account it happened on just served, and will serve again.
    //
    // `model-unsupported` is the same shape: an upstream refusing a name it never served (prod,
    // 2026-10-04 — `k3` on a Claude subscription struck it into a probe, and the conversation's
    // binding then waited on that probe) says nothing about whether it serves its own models.
    case "client-error":
    case "stale-session":
    case "busy-session":
    case "model-unsupported":
      return state

    // No clock refills a drained balance. No reset instant is recorded, deliberately.
    case "credits-exhausted":
      return {
        status: "exhausted",
        cooldownSource: "unknown",
        consecutiveFailures: state.consecutiveFailures + 1,
      }

    case "auth":
      // Unstated is the conservative read: an account that may hold a token to refresh.
      if (
        options.authKind === undefined ||
        AUTH_FAILURE_LANDING[options.authKind] === "needs-reauth"
      ) {
        return {
          status: "needs_reauth",
          cooldownSource: "unknown",
          consecutiveFailures: state.consecutiveFailures + 1,
        }
      }
      return rejectCredential(state, now, options)

    // A refused key's cooldown is one incident. Whatever else was in flight when the refusal
    // landed — a `429`, a `5xx`, a timeout — comes back inside it, and none of it is a re-test:
    // counted, each stepped the next refused probe past the wait it had earned (15 -> 60 minutes
    // where 30 was due). Until the probe, the refusal's count, instant and label all stand. A `402`
    // above is not absorbed: it authenticated, and a drained balance is the truer, terminal state.
    case "rate-limited":
      if (refusalStands(state, now)) return state
      return trip(state, failure, now, options, state.consecutiveFailures + 1)

    default: {
      if (refusalStands(state, now)) return state
      const failures = state.consecutiveFailures + 1
      if (
        !options.recoveryProbe &&
        phase(state, now) !== "half-open" &&
        failures < (options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)
      ) {
        return { ...state, consecutiveFailures: failures }
      }
      return trip(state, failure, now, options, failures)
    }
  }
}

/**
 * The first success resets the streak and returns the account to `active` — including from
 * `exhausted`, because the only request that can reach an `exhausted` account is the operator's
 * "Re-check now" probe, which is the same code path as the half-open probe. Nothing here
 * *schedules* that; it is human action, exactly as the state machine requires.
 */
export function recordSuccess(): BreakerState {
  return HEALTHY
}

function trip(
  state: BreakerState,
  failure: AttemptFailure,
  now: Date,
  options: BreakerOptions,
  failures: number,
): BreakerState {
  const reported = reportedReset(failure, now)
  const until = reported ?? new Date(now.getTime() + backoffMs(failures, options))
  // `estimated`, not `unknown`: when the provider reported nothing we still computed an instant
  // from the backoff schedule, and that is precisely what "estimated" means. Calling it unknown
  // would understate what we know, and the console renders this qualifier next to the countdown —
  // an operator has to be able to tell a provider's own reset from our arithmetic.
  const source: ResetSource =
    reported === null ? "estimated" : (failure.resetSource ?? "provider-reported")

  // A later mark may extend an entry; an earlier one never shortens it, so two concurrent
  // failures cannot un-learn the longer reset.
  const existing = state.status === "cooling_down" ? state.cooldownUntil : undefined
  // Either way the cooldown is an ordinary one. A labeled state only gets here from its probe —
  // inside the labeled cooldown `recordFailure` absorbs the failure first — and a probe that was
  // rate-limited was *authenticated*, so the `credential-rejected` label is no longer true,
  // whichever instant stands. (A limiter *reading* is not a probe: `foldRateLimit` keeps the label
  // for it, `dataplane/health-reading.ts`.)
  if (existing !== undefined && existing.getTime() >= until.getTime()) {
    return {
      status: "cooling_down",
      cooldownUntil: existing,
      cooldownSource: state.cooldownSource,
      consecutiveFailures: failures,
    }
  }

  return {
    status: "cooling_down",
    cooldownUntil: until,
    cooldownSource: source,
    consecutiveFailures: failures,
  }
}
