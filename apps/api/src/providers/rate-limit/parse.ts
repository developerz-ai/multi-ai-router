import type { RateLimitSignal, RateLimitWindow, UpstreamResponse } from "../types"
import { parseDurationSeconds, parseEpochMillis, parseInstant } from "./duration"

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
}

function draftFor(drafts: Map<string, Draft>, limiter: string): Draft {
  const existing = drafts.get(limiter)
  if (existing) return existing
  const created: Draft = {}
  drafts.set(limiter, created)
  return created
}

function parseCount(value: string): number | undefined {
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

function applyField(draft: Draft, field: string, value: string, absoluteReset: boolean): void {
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
  draft.resetAfterSeconds = parseDurationSeconds(value) ?? undefined
}

function collect(headers: Headers): Map<string, Draft> {
  const drafts = new Map<string, Draft>()

  headers.forEach((value, name) => {
    const anthropic = ANTHROPIC_HEADER.exec(name)
    if (anthropic?.[1] && anthropic[2]) {
      applyField(draftFor(drafts, anthropic[1]), anthropic[2], value, true)
      return
    }
    const openai = OPENAI_HEADER.exec(name)
    if (openai?.[1]) {
      applyField(draftFor(drafts, openai[2] ?? DEFAULT_LIMITER), openai[1], value, false)
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
    resetSource: reported ? "provider-reported" : "unknown",
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
    if (Number.isFinite(parsed)) return { seconds: Math.max(0, parsed / 1000) }
  }

  const value = headers.get("retry-after")
  if (value === null) return {}

  const seconds = Number(value.trim())
  if (Number.isFinite(seconds)) return { seconds: Math.max(0, seconds) }

  const at = parseInstant(value)
  return at ? { at } : {}
}

function earliest(windows: readonly RateLimitWindow[]): Date | undefined {
  let soonest: Date | undefined
  for (const window of windows) {
    const candidate = window.resetsAt
    if (candidate && (!soonest || candidate.getTime() < soonest.getTime())) soonest = candidate
  }
  return soonest
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

  const resetsAt = earliest(windows) ?? retryAfter.at
  const reported = resetsAt !== undefined || retryAfter.seconds !== undefined

  return {
    limited: limitedByStatus || windows.some((window) => window.remaining === 0),
    retryAfterSeconds: retryAfter.seconds,
    resetsAt,
    resetSource: reported ? "provider-reported" : "unknown",
    windows,
  }
}
