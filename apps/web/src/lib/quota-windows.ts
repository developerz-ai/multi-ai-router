import type { AccountStatus, QuotaWindowKind } from "@multi-ai-router/core"
import type { QuotaUtilizationSource, QuotaWindowView } from "./api/types"
import { MEASURED_NOTE, measuredFraction, measuredSeries, measuredText } from "./quota-measured"
import {
  type UtilizationQualifier,
  utilizationNote,
  utilizationQualifier,
} from "./quota-utilization"
import {
  describeInstant,
  NEEDS_TOPUP,
  type ResetDisplay,
  type ResetQualifier,
  resetQualifier,
} from "./reset-countdown"

export {
  type UtilizationQualifier,
  utilizationNote,
  utilizationQualifier,
} from "./quota-utilization"

// Per-window quota, prepared for rendering. Pure: the caller passes `nowMs`, so this is testable
// against a fixed clock and re-renders on a timer the caller owns.
//
// **Windows are never collapsed into one number.** A Claude subscription runs five of them
// concurrently on independent clocks, and the account is blocked by whichever is spent — so a
// single "resets at" would name one and silently drop the other four, which is the exact question
// an operator opens this screen to answer (docs/idea/05-routing-and-failover.md).
//
// Two labels travel with every row, and neither is optional:
//
//   - **The reset source** — `reported`, `estimated` or `unknown`. Every row carries one, because
//     five rows where four have a badge and one does not reads as "that one is the certain one".
//   - **The utilization source** — a gauge sitting empty is *correct* for a threshold-triggered
//     source, which reports nothing until consumption nears the limit. Unexplained, it reads as
//     broken, and the operator's next move is to distrust the four gauges that do work.
//
// An `exhausted` account never gets a countdown here either. `describeReset` enforces that for the
// account as a whole; this module carries it down to the window rows, which is where a stale
// per-window `resetsAt` would otherwise resurface as a promise that a clock fixes this.

/**
 * Reading order — presentation data, not a second definition of the domain.
 *
 * Shortest window first, because that is the one that most often blocks a request and the one an
 * operator checks first. `overage` is last: it is the paid allowance *beyond* the included
 * windows and never blocks an account by itself.
 *
 * `satisfies` rejects any value core does not have, and a unit test asserts this is a permutation
 * of `QuotaWindowKind.options` — so a window added upstream cannot be silently dropped here.
 */
export const QUOTA_WINDOW_DISPLAY_ORDER = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "overage",
] as const satisfies readonly QuotaWindowKind[]

interface WindowNaming {
  /** The column label. Terse — it sits in a table cell beside four siblings. */
  readonly label: string
  /** The long form, on hover and as the accessible name. */
  readonly title: string
}

// Keyed by core's union, so a window added upstream fails this build until it has a name.
const NAMING: Readonly<Record<QuotaWindowKind, WindowNaming>> = {
  five_hour: { label: "5h", title: "Five-hour rolling window" },
  seven_day: { label: "7d", title: "Seven-day window, all models" },
  seven_day_opus: { label: "7d Opus", title: "Seven-day window, Opus only" },
  seven_day_sonnet: { label: "7d Sonnet", title: "Seven-day window, Sonnet only" },
  overage: { label: "Overage", title: "Paid allowance beyond the included windows" },
}

export function quotaWindowLabel(window: QuotaWindowKind): string {
  return NAMING[window].label
}

export function quotaWindowTitle(window: QuotaWindowKind): string {
  return NAMING[window].title
}

export interface QuotaWindowDisplay {
  readonly window: QuotaWindowKind
  readonly label: string
  readonly title: string
  /** `0..1`, or null where the source reported nothing. Null is a reading, not a zero. */
  readonly utilization: number | null
  /** `"62%"`, or `"—"` when there is no reading. Always rendered, so no gauge is colour-only. */
  readonly utilizationText: string
  readonly utilizationSource: QuotaUtilizationSource
  readonly utilizationNote: string
  /** Whose figure the bar shows — see `utilizationQualifier`. Null with no reading. */
  readonly utilizationQualifier: UtilizationQualifier | null
  /** Status-aware: `exhausted` yields `needs_topup` and never a countdown. */
  readonly reset: ResetDisplay
  /** Epoch ms, or null. Null whenever rendering the absolute instant would be a lie. */
  readonly resetsAtMs: number | null
  /** Stated on every row — `reported`, `estimated` or `unknown`. */
  readonly resetLabel: ResetQualifier
  /** Whether this window is one of the ones currently blocking the account. */
  readonly spent: boolean
  readonly lastCheckedAtMs: number | null
  /**
   * How the window was consumed across its own span, oldest first — the sparkline beside the bar.
   *
   * **Empty whenever the bar is not the router's own measurement.** These slices sum to the
   * measured total, so drawing them next to a *provider-reported* percentage would put a curve
   * about one accounting beside a number from another. Empty is also what a window with no
   * configured ceiling gets, which is the ordinary case.
   */
  readonly tokenSeries: readonly number[]
}

export interface QuotaWindowsInput {
  readonly status: AccountStatus
  readonly windows: readonly QuotaWindowView[]
}

/** The part of a window's description that changes with its data, not with the clock. */
export type QuotaWindowStatic = Omit<QuotaWindowDisplay, "reset" | "resetsAtMs">

/** The clock-driven part: the reset sentence and the instant it is about. */
export type QuotaWindowReset = Pick<QuotaWindowDisplay, "reset" | "resetsAtMs">

/**
 * Every window this account holds, in reading order.
 *
 * A window core knows about but this account has no reading for is **not** invented: absent stays
 * absent. Padding the list with five unknown rows would make an account that reports one window
 * look like one that reports five and failed at four.
 */
export function orderedQuotaWindows(
  windows: readonly QuotaWindowView[],
): readonly QuotaWindowView[] {
  const byKind = new Map(windows.map((window) => [window.window, window]))
  return QUOTA_WINDOW_DISPLAY_ORDER.map((kind) => byKind.get(kind)).filter(isPresent)
}

/** `orderedQuotaWindows`, each fully described at `nowMs`. */
export function describeQuotaWindows(
  input: QuotaWindowsInput,
  nowMs: number,
): readonly QuotaWindowDisplay[] {
  return orderedQuotaWindows(input.windows).map((window) =>
    describeQuotaWindow(input.status, window, nowMs),
  )
}

export function describeQuotaWindow(
  status: AccountStatus,
  window: QuotaWindowView,
  nowMs: number,
): QuotaWindowDisplay {
  return {
    ...describeQuotaWindowStatic(window),
    ...describeQuotaWindowReset(status, window, nowMs),
  }
}

/**
 * Everything but the reset. Split from the clock-driven half because `/accounts` ticks once a
 * second: the labels, notes, gauge and series are rebuilt only when the window's data changes.
 */
export function describeQuotaWindowStatic(window: QuotaWindowView): QuotaWindowStatic {
  const measured = measuredFraction(window)
  return {
    window: window.window,
    label: quotaWindowLabel(window.window),
    title: quotaWindowTitle(window.window),
    // The provider's reading wins whenever it exists — it is the only figure that reflects the
    // provider's own accounting. The measured fraction is the fallback for the long stretches
    // where a threshold-triggered source reports nothing at all, which is most of every window.
    utilization: window.utilization ?? measured,
    utilizationText:
      window.utilization === null
        ? (measuredText(window) ?? formatUtilization(null))
        : formatUtilization(window.utilization),
    utilizationSource: window.utilizationSource,
    utilizationNote:
      window.utilization === null && measured !== null
        ? MEASURED_NOTE
        : utilizationNote(window.utilizationSource),
    utilizationQualifier: utilizationQualifier(window, measured),
    resetLabel: resetQualifier(window.resetSource),
    spent: window.spent,
    lastCheckedAtMs: parseInstant(window.lastCheckedAt),
    // Carried only where the bar itself is ours. Beside a provider-reported percentage the curve
    // would describe a different measurement than the number above it.
    tokenSeries: window.utilization === null && measured !== null ? measuredSeries(window) : [],
  }
}

/** The reset sentence at `nowMs`, and the instant beside it where the sentence is about one. */
export function describeQuotaWindowReset(
  status: AccountStatus,
  window: QuotaWindowView,
  nowMs: number,
): QuotaWindowReset {
  const resetsAtMs = parseInstant(window.resetsAt)

  // `exhausted` is the one status that overrides the window's own instant, and it is checked
  // first: a row whose stored `resetsAt` survived from before the credits ran out would otherwise
  // count down to a recovery that will not happen. Every other status defers to the window —
  // an `active` subscription's five-hour window still refills on its own clock, and printing "—"
  // beside a gauge that is visibly moving is the other way to be wrong here.
  const baseReset =
    status === "exhausted" ? NEEDS_TOPUP : describeInstant(resetsAtMs, window.resetSource, nowMs)

  // A window that has told us nothing — no provider reading, no measurement of our own, no known
  // reset — on an account that is otherwise healthy is NOT "retrying": nothing is. The backoff
  // sentence belongs to a blocked account's recovery loop, and printing it here invents one (#69).
  const reset: ResetDisplay =
    status === "active" &&
    window.utilization === null &&
    measuredFraction(window) === null &&
    baseReset.kind === "unknown"
      ? { ...baseReset, text: "Unknown — no reading yet" }
      : baseReset

  return {
    reset,
    // Carried only where the *description* is about that instant. "Unknown" beside a printed
    // timestamp, or "needs top-up" beside one, are two ways of contradicting the sentence next
    // to it — so the instant travels with `countdown` and `due` and with nothing else.
    resetsAtMs: reset.kind === "countdown" || reset.kind === "due" ? resetsAtMs : null,
  }
}

/**
 * A percentage, never rounded to `0%` or `100%` when it is neither: a window at 0.4% reads
 * `0.4%`, because `0%` beside a spent account looks like a broken meter, and `100%` on a window
 * with headroom left is the reading that gets an account taken out of a pool by hand.
 */
export function formatUtilization(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  const percent = value * 100
  if (percent > 0 && percent < 1) return `${percent.toFixed(1)}%`
  if (percent < 100 && percent > 99) return `${percent.toFixed(1)}%`
  return `${Math.round(percent)}%`
}

/** The one place a spent window becomes a tone. Utilization alone is not it — a reading of 1.0 on
 * a refilled window is not blocking anything, which is why `spent` is computed server-side. */
export function quotaWindowTone(display: QuotaWindowStatic): "danger" | "warn" | "neutral" {
  if (display.spent) return "danger"
  if (display.utilization !== null && display.utilization >= 0.8) return "warn"
  return "neutral"
}

/**
 * ISO string → epoch ms, or null. Exported because every surface that hands an instant to a
 * countdown must make the same choice: a malformed timestamp becomes *no instant*, never a `NaN`
 * that renders as "Invalid Date" beside "in 0s".
 */
export function parseInstant(iso: string | null): number | null {
  if (iso === null) return null
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? null : parsed
}

function isPresent(window: QuotaWindowView | undefined): window is QuotaWindowView {
  return window !== undefined
}
