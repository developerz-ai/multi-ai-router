import type { RateLimitSignal, RateLimitWindow, UpstreamResponse } from "../types"
import {
  isEpochSeconds,
  parseDurationSeconds,
  parseEpochMillis,
  parseEpochSeconds,
  parseInstant,
} from "./duration"

/**
 * Rate-limit headers, normalized. Two families cover every HTTP provider in the registry and they
 * do not collide, so one parser reads both — which is also what z.ai needs, since one Account
 * picks the Anthropic surface and the next picks the OpenAI one.
 *
 * | Family | Headers | Reset form |
 * |---|---|---|
 * | Anthropic | `anthropic-ratelimit-<limiter>-{limit,remaining,reset}` | RFC 3339 instant |
 * | OpenAI | `x-ratelimit-{limit,remaining,reset}[-<limiter>]` | duration (`6m0s`), or epoch millis on OpenRouter's unsuffixed header |
 *
 * The parser never invents a reset. `resetSource` is `provider-reported` when the upstream said
 * something and `unknown` when it did not; `estimated` belongs to the circuit breaker, which owns
 * the backoff policy (docs/idea/05-routing-and-failover.md).
 */

const ANTHROPIC_HEADER = /^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/
const OPENAI_HEADER = /^x-ratelimit-(limit|remaining|reset)(?:-(.+))?$/

/** The limiter an unsuffixed `x-ratelimit-*` header refers to (OpenRouter's request budget). */
const DEFAULT_LIMITER = "requests"

interface Draft {
  limit?: number
  remaining?: number
  resetsAt?: Date
  resetAfterSeconds?: number
  /** The reset was epoch seconds on a header documented as a duration: the unit is inferred. */
  inferredUnit?: boolean
}

function draftFor(drafts: Map<string, Draft>, limiter: string): Draft {
  const existing = drafts.get(limiter)
  if (existing) return existing
  const created: Draft = {}
  drafts.set(limiter, created)
  return created
}

function parseCount(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function applyField(
  draft: Draft,
  field: string,
  value: string,
  absoluteReset: boolean,
  reference: Date | null,
): void {
  if (field === "limit") {
    draft.limit = parseCount(value)
    return
  }
  if (field === "remaining") {
    draft.remaining = parseCount(value)
    return
  }
  if (absoluteReset) {
    draft.resetsAt = parseInstant(value) ?? undefined
    return
  }
  const epoch = parseEpochMillis(value)
  if (epoch) {
    draft.resetsAt = epoch
    return
  }
  if (isEpochSeconds(value)) {
    // Never a duration: unchecked against a `Date`, it is no reset at all (`duration.ts`).
    const at = parseEpochSeconds(value, reference)
    if (at !== null) {
      draft.resetsAt = at
      draft.inferredUnit = true
    }
    return
  }
  draft.resetAfterSeconds = parseDurationSeconds(value) ?? undefined
}

function collect(headers: Headers): Map<string, Draft> {
  const drafts = new Map<string, Draft>()
  // The response's own clock: the only one a parser has to check an inferred instant against.
  const date = headers.get("date")
  const reference = date === null ? null : parseInstant(date)

  headers.forEach((value, name) => {
    const anthropic = ANTHROPIC_HEADER.exec(name)
    if (anthropic?.[1] && anthropic[2]) {
      applyField(draftFor(drafts, anthropic[1]), anthropic[2], value, true, reference)
      return
    }
    const openai = OPENAI_HEADER.exec(name)
    if (openai?.[1]) {
      applyField(draftFor(drafts, openai[2] ?? DEFAULT_LIMITER), openai[1], value, false, reference)
    }
  })

  return drafts
}

function toWindow(limiter: string, draft: Draft): RateLimitWindow {
  const reported = draft.resetsAt !== undefined || draft.resetAfterSeconds !== undefined
  const measurable = draft.limit !== undefined && draft.limit > 0 && draft.remaining !== undefined
  const utilization = measurable
    ? Math.min(1, Math.max(0, 1 - (draft.remaining ?? 0) / (draft.limit ?? 1)))
    : undefined

  return {
    limiter,
    limit: draft.limit,
    remaining: draft.remaining,
    utilization,
    // These headers ride every response, so a reading is available all window long.
    utilizationSource: measurable ? "continuous" : "none",
    resetsAt: draft.resetsAt,
    resetAfterSeconds: draft.resetAfterSeconds,
    resetSource: !reported ? "unknown" : draft.inferredUnit ? "estimated" : "provider-reported",
  }
}

interface RetryAfter {
  seconds?: number
  at?: Date
}

/** `retry-after` is seconds or an HTTP-date; `retry-after-ms` is what OpenAI sometimes sends. */
function parseRetryAfter(headers: Headers): RetryAfter {
  const millis = headers.get("retry-after-ms")
  if (millis !== null) {
    const parsed = Number(millis.trim())
    if (millis.trim() !== "" && Number.isFinite(parsed) && parsed > 0)
      return { seconds: parsed / 1000 }
  }

  const value = headers.get("retry-after")
  if (value === null || value.trim() === "") return {}

  const seconds = Number(value.trim())
  if (Number.isFinite(seconds)) return seconds > 0 ? { seconds } : {}

  const at = parseInstant(value)
  return at ? { at } : {}
}

function depletedReset(windows: readonly RateLimitWindow[]): RetryAfter & { estimated: boolean } {
  let at: Date | undefined
  let seconds: number | undefined
  let estimated = false
  for (const window of windows) {
    if (window.remaining === undefined || window.remaining > 0) continue
    if (window.resetsAt && (!at || window.resetsAt > at)) {
      at = window.resetsAt
      estimated = window.resetSource === "estimated"
    }
    if (window.resetAfterSeconds !== undefined && window.resetAfterSeconds > 0)
      seconds = Math.max(seconds ?? 0, window.resetAfterSeconds)
  }
  return { at, seconds, estimated }
}

export function parseRateLimitHeaders(response: UpstreamResponse): RateLimitSignal | null {
  const windows = [...collect(response.headers)]
    .map(([limiter, draft]) => toWindow(limiter, draft))
    .sort((left, right) => left.limiter.localeCompare(right.limiter))
  const retryAfter = parseRetryAfter(response.headers)
  const limitedByStatus = response.status === 429

  if (windows.length === 0 && retryAfter.seconds === undefined && !retryAfter.at) {
    // A bare 429 is still a signal, just one with no reset attached.
    if (!limitedByStatus) return null
    return { limited: true, resetSource: "unknown", windows: [] }
  }

  const effective =
    retryAfter.at || retryAfter.seconds !== undefined
      ? { ...retryAfter, estimated: false }
      : depletedReset(windows)
  const resetsAt = effective.at
  const reported = resetsAt !== undefined || effective.seconds !== undefined

  return {
    limited: limitedByStatus || windows.some((window) => window.remaining === 0),
    retryAfterSeconds: effective.seconds,
    resetsAt,
    resetSource: !reported ? "unknown" : effective.estimated ? "estimated" : "provider-reported",
    windows,
  }
}
