import type { QuotaWindowKind, QuotaWindowState } from "@multi-ai-router/core"
import { z } from "zod"
import type { RateLimitSignal, RateLimitWindow, UpstreamResponse } from "../types"

/**
 * The Codex usage gauge, parsed off the headers the ChatGPT backend already returns on every
 * reply. Sibling of `openai-oauth-models.ts` and `openai-oauth-device.ts` because the parent
 * `openai-oauth.ts` is at the 300-line limit.
 *
 * Headers (six constants, primary and secondary, used-percent + window-minutes + reset-at):
 *
 *   x-codex-primary-used-percent       0..100
 *   x-codex-primary-window-minutes     e.g. 300 (five_hour) or 10_080 (seven_day)
 *   x-codex-primary-reset-at           epoch seconds
 *   x-codex-secondary-used-percent
 *   x-codex-secondary-window-minutes
 *   x-codex-secondary-reset-at
 *
 * Provenance: openai/codex `codex-rs/codex-api/src/rate_limits.rs` (lines 70..79 when read on
 * 2026-10-10). Blast radius: every ChatGPT account. A renamed or removed header makes every
 * Codex account lose its usage gauge silently; the routing decision still has the eligible-window
 * path on the upstream's own 429, so this is a display regression, not a routing one.
 *
 * The reset-at is epoch seconds. A complete set (all three) maps to a `QuotaWindowState`:
 * utilization is `used_percent / 100` clamped to 0..1, resetsAt from the epoch, resetSource
 * `provider-reported`. Window length 300 → `five_hour`, 10_080 → `seven_day`; anything else
 * travels in `windows` as a generic `RateLimitWindow` (no router kind, no advisory).
 *
 * The reading's time is the reply's `Date` header. `parseCodexQuotaHeaders` takes no clock, so
 * this is the only honest source — and it keeps the change inside this one file. No `Date`
 * header → no named window.
 *
 * Every named window this function builds carries `advisory: true`: the `openai-luna` pool has
 * one member, and dropping it on a header reading would switch Luna off for up to seven days on
 * the router's own say-so. See `services/routing/quota.ts` for how the marker is read; the
 * upstream's own 429 path on the breaker is unchanged.
 */

// The header names are pinned here, not on the configuration, because changing them is a
// blast-radius-broadcasting event and the search engine the next reader runs is git grep.
export const CODEX_PRIMARY_USED_PERCENT_HEADER = "x-codex-primary-used-percent"
export const CODEX_PRIMARY_WINDOW_MINUTES_HEADER = "x-codex-primary-window-minutes"
export const CODEX_PRIMARY_RESET_AT_HEADER = "x-codex-primary-reset-at"
export const CODEX_SECONDARY_USED_PERCENT_HEADER = "x-codex-secondary-used-percent"
export const CODEX_SECONDARY_WINDOW_MINUTES_HEADER = "x-codex-secondary-window-minutes"
export const CODEX_SECONDARY_RESET_AT_HEADER = "x-codex-secondary-reset-at"

const FIVE_HOUR_MINUTES = 300
const SEVEN_DAY_MINUTES = 10_080

const NumberString = z
  .string()
  .transform((value) => Number(value))
  .refine((n) => Number.isFinite(n), { message: "not finite" })

/**
 * Reads the Codex headers off `response` and folds them into the router's quota-window vocabulary.
 *
 * Returns:
 *   - `quotaWindows`: named `QuotaWindowState`s when a complete (used%, minutes, reset-at) set
 *     is present, every value is in range, and the minutes match a known `QuotaWindowKind`.
 *     Each is `advisory: true`.
 *   - `windows`: every reading that does not map onto a named kind — minutes ≠ 300/10_080.
 *     Carries `RateLimitWindow` shape, no advisory.
 *
 * A reply with no parseable `Date` header carries no named windows: the timestamp the function
 * would otherwise use is unknown, and "unknown" must not be invented. An incomplete or out-of-range
 * set (e.g. a non-numeric percent, a reset-at that would build an Invalid Date) produces neither
 * a named window nor a generic one — partial or malformed signals must not be turned into numbers
 * the routing layer would rank on.
 */
export function parseCodexQuotaHeaders(response: UpstreamResponse): {
  readonly quotaWindows: readonly QuotaWindowState[]
  readonly windows: readonly RateLimitWindow[]
} {
  const dateRaw = response.headers.get("date")
  if (dateRaw === null) return { quotaWindows: [], windows: [] }
  const lastCheckedAt = new Date(dateRaw.trim())
  if (Number.isNaN(lastCheckedAt.getTime())) return { quotaWindows: [], windows: [] }

  const quotaWindows: QuotaWindowState[] = []
  const windows: RateLimitWindow[] = []

  for (const slot of ["primary", "secondary"] as const) {
    const usedHeader = readHeader(
      response,
      slot === "primary" ? CODEX_PRIMARY_USED_PERCENT_HEADER : CODEX_SECONDARY_USED_PERCENT_HEADER,
    )
    const minutesHeader = readHeader(
      response,
      slot === "primary"
        ? CODEX_PRIMARY_WINDOW_MINUTES_HEADER
        : CODEX_SECONDARY_WINDOW_MINUTES_HEADER,
    )
    const resetHeader = readHeader(
      response,
      slot === "primary" ? CODEX_PRIMARY_RESET_AT_HEADER : CODEX_SECONDARY_RESET_AT_HEADER,
    )

    const usedPercent = parsePercent(usedHeader)
    const windowMinutes = parseMinutes(minutesHeader)
    const resetAtEpochSeconds = parseEpochSeconds(resetHeader)

    // An incomplete or out-of-range set produces no window at all. A partial header set cannot
    // claim a kind, and an out-of-range number (e.g. an epoch that builds an Invalid Date) would
    // throw a RangeError downstream (`availability.ts` / `quota-window-mutations.ts`).
    if (usedPercent === null || windowMinutes === null || resetAtEpochSeconds === null) {
      continue
    }

    const kind = kindFromMinutes(windowMinutes)
    if (kind === null) {
      windows.push({
        limiter: `${slot}-${windowMinutes}m`,
        utilization: clamp01(usedPercent / 100),
        utilizationSource: "continuous",
        resetsAt: new Date(resetAtEpochSeconds * 1000),
        resetSource: "provider-reported",
      })
      continue
    }

    quotaWindows.push({
      window: kind,
      utilization: clamp01(usedPercent / 100),
      utilizationSource: "continuous",
      resetsAt: new Date(resetAtEpochSeconds * 1000),
      resetSource: "provider-reported",
      lastCheckedAt,
      // Display-only: see file docstring. The `advisory` flag makes `isWindowSpent` return
      // false for this reading, so a 100% utilization cannot drop the account out of rotation.
      // A 429 still cools the account through the breaker — that path is unchanged and triggers
      // on the upstream's own rate-limit response, not on this header reading.
      advisory: true,
    })
  }

  return { quotaWindows, windows }
}

function readHeader(response: UpstreamResponse, name: string): string | null {
  const raw = response.headers.get(name)
  if (raw === null) return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

function parsePercent(value: string | null): number | null {
  if (value === null) return null
  const parsed = NumberString.safeParse(value)
  if (!parsed.success) return null
  const n = parsed.data
  // Used-percent is a float: openai/codex `codex-rs/codex-api/src/rate_limits.rs` declares
  // `used_percent: f64` and its own fixture sends `12.5`. Downstream `clamp01(usedPercent/100)`
  // caps any value above 100 at 1, so out-of-range isn't a parse concern; negative and
  // non-finite are, because either would poison the gauge or trip an Invalid Date elsewhere.
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

function parseMinutes(value: string | null): number | null {
  if (value === null) return null
  const parsed = NumberString.safeParse(value)
  if (!parsed.success) return null
  const n = parsed.data
  // Minutes must be a positive integer — a zero-minute window is meaningless and a float would
  // survive into the kind lookup below. Upstream publishes integers.
  if (!Number.isSafeInteger(n) || n <= 0) return null
  return n
}

function parseEpochSeconds(value: string | null): number | null {
  if (value === null) return null
  const parsed = NumberString.safeParse(value)
  if (!parsed.success) return null
  const n = parsed.data
  // Epoch seconds must build a real Date; `99999999999999999 * 1000` overflows `Date`'s range
  // and produces an Invalid Date, which then throws a RangeError at `.toISOString()` time. The
  // extra Date check is the only thing that catches that case without doing arithmetic on the
  // resulting Date in the caller.
  if (!Number.isSafeInteger(n) || n <= 0) return null
  if (!Number.isFinite(new Date(n * 1000).getTime())) return null
  return n
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function kindFromMinutes(minutes: number): QuotaWindowKind | null {
  if (minutes === FIVE_HOUR_MINUTES) return "five_hour"
  if (minutes === SEVEN_DAY_MINUTES) return "seven_day"
  return null
}

const ResetsIn = z.object({
  error: z.object({ resets_in_seconds: z.number().nonnegative() }).optional(),
  resets_in_seconds: z.number().nonnegative().optional(),
})

function resetsInSeconds(body: unknown): number | null {
  const parsed = ResetsIn.safeParse(body)
  if (!parsed.success) return null
  return parsed.data.error?.resets_in_seconds ?? parsed.data.resets_in_seconds ?? null
}

/**
 * Assembles the Codex driver's full rate-limit signal: the x-ratelimit header reading (already
 * parsed by {@link parseRateLimitHeaders}), the x-codex usage gauge, and any `resets_in_seconds`
 * the 429 body carried.
 *
 * Returns `null` when nothing meaningful was reported — no x-ratelimit headers, no x-codex
 * usage gauge, and no `resets_in_seconds`. `applyRateLimit` short-circuits on null, so a
 * 200 with none of these is a no-op (the prior behaviour).
 */
export function codexSignal(
  fromHeaders: RateLimitSignal | null,
  response: UpstreamResponse,
): RateLimitSignal | null {
  const seconds = resetsInSeconds(response.body)
  const { quotaWindows, windows: extraWindows } = parseCodexQuotaHeaders(response)

  // No header signal, no quota windows, no extra windows, no resets_in_seconds → nothing to say.
  // Returning null preserves the prior contract: a 200 carrying none of these signals does not
  // fold into the breaker's reading, so an idle account stays idle.
  if (
    fromHeaders === null &&
    quotaWindows.length === 0 &&
    extraWindows.length === 0 &&
    seconds === null
  ) {
    return null
  }

  // `extraWindows` are the unmatched-minute-count readings; they ride on `windows` whether or
  // not the upstream also reported a 429. A successful reply still has them.
  const baseSignal: RateLimitSignal =
    fromHeaders === null
      ? { limited: false, resetSource: "unknown", windows: extraWindows }
      : { ...fromHeaders, windows: [...fromHeaders.windows, ...extraWindows] }
  const signalWithQuota: RateLimitSignal =
    quotaWindows.length === 0 ? baseSignal : { ...baseSignal, quotaWindows }
  if (seconds === null) return signalWithQuota

  return {
    ...signalWithQuota,
    limited: true,
    retryAfterSeconds: signalWithQuota.retryAfterSeconds ?? seconds,
    resetSource: "provider-reported",
  }
}
