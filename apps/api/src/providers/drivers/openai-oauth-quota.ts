import type { QuotaWindowKind, QuotaWindowState } from "@multi-ai-router/core"
import { z } from "zod"
import type { RateLimitWindow, UpstreamResponse } from "../types"

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
 * Codex account lose its usage gauge silently; the quota-window-spent path still works against
 * the 429 fallback, so this is a display regression, not a routing one.
 *
 * The reset-at is epoch seconds. A complete set (all three) maps to a `QuotaWindowState`:
 * utilization is `used_percent / 100` clamped to 0..1, resetsAt from the epoch, resetSource
 * `provider-reported`. Window length 300 → `five_hour`, 10_080 → `seven_day`; anything else
 * travels in `windows` as a generic `RateLimitWindow` (no router kind, no advisory).
 *
 * The reading's time is the reply's `Date` header. `parseRateLimit` takes no clock, so this is
 * the only honest source — and it keeps the change inside this one file. No `Date` header → no
 * named window.
 *
 * Every named window this function builds carries `advisory: true`: the `openai-luna` pool has
 * one member, and dropping it on a header reading would switch Luna off for up to seven days on
 * the router's own say-so. See `services/routing/quota.ts` for how the marker is read; the
 * limited-signal path on the upstream's own 429 is unchanged.
 */

// The header names are pinned here, not on the configuration, because changing them is a
// blast-radius-broadcasting event and the search engine the next reader runs is git grep.
export const CODEX_PRIMARY_USED_PERCENT_HEADER = "x-codex-primary-used-percent"
export const CODEX_PRIMARY_WINDOW_MINUTES_HEADER = "x-codex-primary-window-minutes"
export const CODEX_PRIMARY_RESET_AT_HEADER = "x-codex-primary-reset-at"
export const CODEX_SECONDARY_USED_PERCENT_HEADER = "x-codex-secondary-used-percent"
export const CODEX_SECONDARY_WINDOW_MINUTES_HEADER = "x-codex-secondary-window-minutes"
export const CODEX_SECONDARY_RESET_AT_HEADER = "x-codex-secondary-reset-at"

const WINDOW_MINUTES_MS = 60_000
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
 *     is present and the minutes match a known `QuotaWindowKind`. Each is `advisory: true`.
 *   - `windows`: every reading that does not map onto a named kind — minutes ≠ 300/10_080, or
 *     one or two of the three headers missing. Carries `RateLimitWindow` shape, no advisory.
 *
 * A reply with no parseable `Date` header carries no named windows: the timestamp the function
 * would otherwise use is unknown, and "unknown" must not be invented.
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

    if (usedPercent === null || windowMinutes === null || resetAtEpochSeconds === null) {
      // A partial set: travel as a generic `RateLimitWindow` under its own limiter name. Not all
      // three and we cannot claim a kind.
      if (usedPercent !== null || windowMinutes !== null || resetAtEpochSeconds !== null) {
        if (resetAtEpochSeconds !== null) {
          windows.push({
            limiter: slot,
            ...(usedPercent === null ? {} : { utilization: clamp01(usedPercent / 100) }),
            utilizationSource: "continuous",
            resetsAt: new Date(resetAtEpochSeconds * 1000),
            resetSource: "provider-reported",
          })
        } else if (usedPercent !== null) {
          windows.push({
            limiter: slot,
            utilization: clamp01(usedPercent / 100),
            utilizationSource: "continuous",
            resetSource: "unknown",
          })
        }
      }
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
      // Display-only: see file docstring. Routing still has the eligible-window-spent gate on the
      // upstream's own 429, so a stale 100% reading cannot masquerade as a healthy router.
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
  return parsed.success ? parsed.data : null
}

function parseMinutes(value: string | null): number | null {
  if (value === null) return null
  const parsed = NumberString.safeParse(value)
  return parsed.success ? parsed.data : null
}

function parseEpochSeconds(value: string | null): number | null {
  if (value === null) return null
  const parsed = NumberString.safeParse(value)
  return parsed.success ? parsed.data : null
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

// Re-export the window-minute in ms as a label the parser refuses to lie about. Keeps the
// number-of-minutes pairs a future reader can grep for in one place.
export const CODEX_KNOWN_WINDOW_MINUTES: ReadonlySet<number> = new Set([
  FIVE_HOUR_MINUTES,
  SEVEN_DAY_MINUTES,
])

// Exported so the test can read the same constants without re-deriving the header name.
export const CODEX_QUOTA_HEADERS = [
  CODEX_PRIMARY_USED_PERCENT_HEADER,
  CODEX_PRIMARY_WINDOW_MINUTES_HEADER,
  CODEX_PRIMARY_RESET_AT_HEADER,
  CODEX_SECONDARY_USED_PERCENT_HEADER,
  CODEX_SECONDARY_WINDOW_MINUTES_HEADER,
  CODEX_SECONDARY_RESET_AT_HEADER,
] as const

// Silence the unused-import warning for WINDOW_MINUTES_MS in environments where TS isn't strict
// enough to notice it. (Kept for the future: a "the window has at most this many minutes"
// assertion, never today.)
void WINDOW_MINUTES_MS
