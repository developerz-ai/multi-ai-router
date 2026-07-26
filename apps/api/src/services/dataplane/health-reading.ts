import type { RateLimitSignal } from "../../providers"
import { type BreakerOptions, mergeQuotaWindows, phase, recordFailure } from "../routing"
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

  return {
    ...recorded,
    breaker: recordFailure(
      state.breaker,
      {
        kind: "rate-limited",
        resetsAt: signal.resetsAt,
        retryAfterSeconds: signal.retryAfterSeconds,
        resetSource: signal.resetSource,
        message: "upstream reported the limit was reached",
      },
      now,
      breaker,
    ),
  }
}
