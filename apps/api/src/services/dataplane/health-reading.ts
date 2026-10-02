import type { RateLimitSignal } from "../../providers"
import {
  type AttemptFailure,
  type BreakerOptions,
  type BreakerState,
  lengthenRefusal,
  mergeQuotaWindows,
  phase,
  recordFailure,
  refusalStands,
} from "../routing"
import type { AccountHealthState } from "./health"

/**
 * What one response's rate-limit reading means for an account's state — pure, so the precedence
 * rule it encodes is testable without a store, a clock, or a mock.
 *
 * Split from the store because it answers a different question: the store owns *who holds what*,
 * this owns *what a reading does*. It is also the one rule in this layer that is correctness rather
 * than hygiene, and it deserves to be readable on its own.
 *
 * Three things happen, in this order:
 *
 * 1. **The reading is recorded, always.** Limiter windows keep the provider's own names, named
 *    quota windows fold per kind (`mergeQuotaWindows`). Even an account no timer can recover keeps
 *    its reading: an operator inspecting a dead account still deserves to see what its limiter said.
 * 2. **A terminal verdict outranks the header.** `exhausted` and `needs_reauth` mean a human must
 *    act; a cooldown means a clock will fix it, and the two are never conflated (CLAUDE.md
 *    non-negotiable 7). Providers routinely ship `x-ratelimit-remaining-*: 0` *alongside* the `402`
 *    that drained the balance — a header riding a response, not a verdict about it — so folding it
 *    in would rewrite "top this account up" as "retry at 14:32", put a dead balance back in the
 *    rotation on a timer, and answer the client `429 + Retry-After` for it. `blocked` is the
 *    breaker's own name for "no timer will change this", so the two definitions cannot drift apart.
 * 3. **Otherwise the limit becomes a cooldown, through the breaker's own transition.** One
 *    implementation of the never-shorten rule and of provider-reported-reset preference — and one
 *    set of configured numbers, rather than the module defaults this fold used to fall back to.
 *    What the cooldown is *for* stays the verdict's: see {@link keepVerdictReason}. While a refused
 *    key's cooldown is still running the breaker absorbs every failure as a sibling of that
 *    refusal, so a reading takes the one transition that is its own there: `lengthenRefusal`.
 */
export function foldRateLimit(
  state: AccountHealthState,
  signal: RateLimitSignal,
  now: Date,
  breaker: BreakerOptions,
): AccountHealthState {
  const recorded: AccountHealthState = {
    ...state,
    limiterWindows: signal.windows,
    quotaWindows: mergeQuotaWindows(state.quotaWindows, signal.quotaWindows),
    lastSignalAt: now,
  }

  if (!signal.limited) return recorded
  if (phase(state.breaker, now) === "blocked") return recorded

  const reading: AttemptFailure = {
    kind: "rate-limited",
    resetsAt: signal.resetsAt,
    retryAfterSeconds: signal.retryAfterSeconds,
    resetSource: signal.resetSource,
    message: "upstream reported the limit was reached",
  }
  const tripped = refusalStands(state.breaker, now)
    ? lengthenRefusal(state.breaker, reading, now)
    : recordFailure(state.breaker, reading, now, breaker)
  return { ...recorded, breaker: keepVerdictReason(state.breaker, tripped) }
}

/**
 * A reading may lengthen a cooldown; it never re-labels one. When the verdict already in place
 * says the provider refused the key (`credential-rejected`), a limiter header riding that same
 * response says when the limiter refills and nothing about the key — so the label survives even
 * when the reading's reset outlasts the auth cooldown, and the reading is not counted as a second
 * refusal (the streak drives the re-test cadence, `routing/credential-rejection.ts`). While the
 * refusal's cooldown runs, `lengthenRefusal` already kept both and this changes nothing; it is what
 * holds them for a reading that arrives once the cooldown has passed and the breaker built a fresh
 * one. A probe that *was* rate-limited reaches here already unlabeled: its own verdict cleared the
 * label first, so there is nothing to keep.
 */
function keepVerdictReason(before: BreakerState, after: BreakerState): BreakerState {
  if (before.cooldownReason === undefined || after.status !== "cooling_down") return after
  return {
    ...after,
    cooldownReason: before.cooldownReason,
    consecutiveFailures: before.consecutiveFailures,
  }
}
