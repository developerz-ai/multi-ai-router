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

export function describeReset(input: ResetInput, nowMs: number): ResetDisplay {
  if (input.status === "exhausted") {
    return {
      kind: "needs_topup",
      countdown: null,
      text: "Needs top-up — no reset",
      qualifier: null,
    }
  }

  if (!hasReset(input.status)) {
    return { kind: "none", countdown: null, text: "—", qualifier: null }
  }

  if (input.resetSource === "unknown" || input.resetsAt === null) {
    return {
      kind: "unknown",
      countdown: null,
      text: "Unknown — will retry with backoff",
      qualifier: null,
    }
  }

  const qualifier = QUALIFIER[input.resetSource]
  const remaining = input.resetsAt - nowMs

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
