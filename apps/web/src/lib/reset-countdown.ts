import type { AccountStatus, ResetSource } from "@multi-ai-router/core"
import { hasReset } from "./account-status"

// Quota reset rendering. Pure by construction: the caller passes `nowMs`, so
// this is testable against a fixed clock and re-renders on a timer the caller
// owns.
//
// `ResetSource` comes from core. It must: comparing against a locally invented
// spelling would send every provider-reported reset down the `estimated`
// branch and label a fact as a guess — the exact failure
// `docs/idea/05-routing-and-failover.md` says must never happen.
//
// Two rules from the spec are enforced here rather than left to a template: an
// `exhausted` account never shows a countdown (there is nothing to count down
// to), and a reset whose source is `unknown` is never dressed up as a fact.

export interface ResetInput {
  readonly status: AccountStatus
  /**
   * Epoch milliseconds, or null when the provider reported none. Core carries
   * this as an optional `Date` on `QuotaWindowState`; the caller converts once
   * at the edge so this stays a pure number-in, string-out formatter.
   */
  readonly resetsAt: number | null
  readonly resetSource: ResetSource
}

export type ResetKind = "countdown" | "due" | "needs_topup" | "unknown" | "none"

/**
 * How a reset instant is qualified, for the places that must label **every** row.
 *
 * `ResetDisplay.qualifier` goes null for `unknown` because there is no instant to qualify there —
 * the sentence itself already says so. A per-window table is the opposite case: five rows sitting
 * side by side, and one with no badge reads as the trustworthy one. So `unknown` is a value here.
 */
export type ResetQualifier = "reported" | "estimated" | "unknown"

export interface ResetDisplay {
  readonly kind: ResetKind
  /** `"1h 12m"`, or null whenever a countdown would be a lie. */
  readonly countdown: string | null
  /** The sentence rendered next to the absolute timestamp. */
  readonly text: string
  /** Rendered as a badge; null when there is no reset to qualify. */
  readonly qualifier: "reported" | "estimated" | null
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Coarse duration, two units at most: `2d 3h`, `1h 12m`, `4m 30s`, `45s`.
 * Negative and sub-second inputs collapse to `0s` rather than going backwards.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"

  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  const seconds = Math.floor((ms % MINUTE) / SECOND)

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  return `${seconds}s`
}

/**
 * Badge wording per source. A `Record` rather than a ternary on purpose: a
 * ternary needs a fallback branch, and a fallback is what silently relabels an
 * unrecognised source as "estimated". Keyed exhaustively, a source added to
 * core fails this build instead.
 */
const QUALIFIER: Readonly<Record<Exclude<ResetSource, "unknown">, "reported" | "estimated">> = {
  "provider-reported": "reported",
  estimated: "estimated",
}

/**
 * The label for any source, `unknown` included. A narrowing check rather than a fallback: the
 * exhaustive `QUALIFIER` above still fails this build the day core adds a source, which a
 * `?? "estimated"` would not.
 */
export function resetQualifier(source: ResetSource): ResetQualifier {
  return source === "unknown" ? "unknown" : QUALIFIER[source]
}

/**
 * The one display an `exhausted` account may ever have. Exported because the rule has to hold on
 * every surface that renders a reset, not only the ones that route through `describeReset` — a
 * quota window row carries its own instant, and that instant is exactly what would otherwise
 * resurface as a countdown on an account no clock will fix.
 */
export const NEEDS_TOPUP: ResetDisplay = {
  kind: "needs_topup",
  countdown: null,
  text: "Needs top-up — no reset",
  qualifier: null,
}

const NO_RESET: ResetDisplay = { kind: "none", countdown: null, text: "—", qualifier: null }

export function describeReset(input: ResetInput, nowMs: number): ResetDisplay {
  if (input.status === "exhausted") return NEEDS_TOPUP
  // The account-level line answers "when does this account come back", so a status no clock
  // recovers from has nothing to say. A *window* is the other question — see `describeInstant`.
  if (!hasReset(input.status)) return NO_RESET
  return describeInstant(input.resetsAt, input.resetSource, nowMs)
}

/**
 * A reset instant that is already known to be worth rendering, described without consulting a
 * status.
 *
 * Split out for the per-window rows. A quota window refills on its own clock whether or not the
 * account is currently blocked — an `active` subscription at 62% of its five-hour window still has
 * a real reset an hour out, and gating that on `hasReset` would print "—" beside a gauge that is
 * visibly moving. The `exhausted` rule is applied by the caller, before this is reached.
 */
export function describeInstant(
  resetsAt: number | null,
  resetSource: ResetSource,
  nowMs: number,
): ResetDisplay {
  if (resetSource === "unknown" || resetsAt === null) {
    return {
      kind: "unknown",
      countdown: null,
      text: "Unknown — will retry with backoff",
      qualifier: null,
    }
  }

  const qualifier = QUALIFIER[resetSource]
  const remaining = resetsAt - nowMs

  if (remaining <= 0) {
    return { kind: "due", countdown: null, text: "Reset due — re-checking", qualifier }
  }

  const countdown = formatDuration(remaining)
  return { kind: "countdown", countdown, text: `in ${countdown}`, qualifier }
}

/**
 * The absolute half of the pair. Reset is always shown as absolute time *and*
 * countdown; the locale and zone stay the viewer's.
 */
export function formatAbsolute(epochMs: number, locale?: string): string {
  return new Date(epochMs).toLocaleString(locale, {
    dateStyle: "short",
    timeStyle: "short",
  })
}
