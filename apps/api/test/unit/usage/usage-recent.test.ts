import { describe, expect, test } from "bun:test"
import { UsageOutcome } from "@multi-ai-router/core"
import type { RecentAttemptQuery, RecentAttemptRow } from "@multi-ai-router/db"
import {
  createUsageService,
  outcomesFor,
  RECENT_LIMIT_DEFAULT,
  RECENT_LIMIT_MAX,
  recentQuery,
} from "../../../src/services/usage-read"

/**
 * The live request feed — the "why did my request fail" surface.
 *
 * Three properties carry the weight. The outcome filter is derived from core's enum rather than
 * from a list written here, so a "failures only" view cannot quietly hide the newest kind of
 * failure. An attempt whose key or account has since been deleted still renders, marked, for the
 * same reason a breakdown row does. And `limit` is echoed as asked for, never as the row count,
 * so a quiet router is never reported as a truncated page.
 */

const NOW = new Date("2026-03-15T14:30:00.000Z")

function attemptRow(over: Partial<RecentAttemptRow> = {}): RecentAttemptRow {
  return {
    id: "row-1",
    correlationId: "11111111-1111-4111-8111-111111111111",
    clientRequestId: null,
    attempt: 1,
    apiKeyId: "key-1",
    accountId: "acct-1",
    poolId: "pool-1",
    provider: "anthropic",
    model: "claude-sonnet-5",
    upstreamModel: "claude-sonnet-5",
    ingressDialect: "anthropic",
    egressMode: "passthrough",
    outcome: "success",
    httpStatus: 200,
    errorClass: null,
    latencyMs: 812,
    ttfbMs: 91,
    routerOverheadMs: 2,
    streamed: true,
    tokensIn: 1_200,
    tokensOut: 340,
    createdAt: NOW,
    ...over,
  }
}

/** Captures what the service asked the repository for, which is half of what these tests assert. */
function service(rows: readonly RecentAttemptRow[]) {
  const asked: RecentAttemptQuery[] = []
  const unreached = () => {
    throw new Error("the feed must not read an aggregate")
  }

  const usage = createUsageService({
    usage: {
      totals: unreached,
      latency: unreached,
      series: unreached,
      seriesByDimension: unreached,
      breakdown: unreached,
    },
    recent: {
      recent: async (query) => {
        asked.push(query)
        return [...rows]
      },
    },
    daily: { totals: unreached, breakdown: unreached },
    scheduledTasks: { lastSuccess: unreached },
    labels: async () => ({
      keys: new Map([["key-1", "dev-laptops"]]),
      accounts: new Map([["acct-1", "claude-max-01"]]),
      pools: new Map([["pool-1", "default"]]),
    }),
    now: () => NOW,
  })

  return { usage, asked }
}

describe("the recent query", () => {
  test("defaults to a bounded page and no filter at all", () => {
    const parsed = recentQuery.parse({})

    expect(parsed.limit).toBe(RECENT_LIMIT_DEFAULT)
    expect(parsed.outcome).toBeUndefined()
    expect(parsed.failed).toBeUndefined()
    expect(outcomesFor(parsed)).toBeUndefined()
  })

  test("a limit out of range is refused, never silently clamped", () => {
    // A console that asked for 1000 and got 200 without being told would render a
    // truncated page as a complete one.
    expect(recentQuery.safeParse({ limit: "1000" }).success).toBe(false)
    expect(recentQuery.safeParse({ limit: "0" }).success).toBe(false)
    expect(recentQuery.safeParse({ limit: String(RECENT_LIMIT_MAX) }).success).toBe(true)
  })

  test("an outcome and a failed flag are two spellings of one filter, so both is a 400", () => {
    expect(recentQuery.safeParse({ outcome: "upstream_error", failed: "true" }).success).toBe(false)
    expect(recentQuery.safeParse({ outcome: "upstream_error" }).success).toBe(true)
    expect(recentQuery.safeParse({ failed: "true" }).success).toBe(true)
  })

  test("an unknown outcome is refused rather than matching nothing", () => {
    expect(recentQuery.safeParse({ outcome: "exploded" }).success).toBe(false)
  })

  test("a request id may be the caller's own label, not only a uuid", () => {
    expect(recentQuery.parse({ requestId: "req-42" }).requestId).toBe("req-42")
    // The same charset and ceiling the ingress `requestId()` accepts — anything
    // else cannot be on a row, so accepting it would only widen what reaches SQL.
    expect(recentQuery.safeParse({ requestId: "req 42" }).success).toBe(false)
    expect(recentQuery.safeParse({ requestId: "x".repeat(129) }).success).toBe(false)
  })
})

describe("the outcome filter", () => {
  test("failed=true is every non-success outcome, derived from core's enum", () => {
    const outcomes = outcomesFor(recentQuery.parse({ failed: "true" }))

    // Derived, not listed: an outcome added to core is filtered here without
    // anyone remembering to come back, which is the whole point.
    expect(outcomes).toEqual(UsageOutcome.options.filter((outcome) => outcome !== "success"))
    expect(outcomes).toContain("quota_exhausted")
    expect(outcomes).toContain("credits_exhausted")
  })

  test("failed=false is successes only — the boolean is a filter, not a switch", () => {
    expect(outcomesFor(recentQuery.parse({ failed: "false" }))).toEqual(["success"])
  })

  test("a named outcome narrows to exactly it", () => {
    expect(outcomesFor(recentQuery.parse({ outcome: "upstream_timeout" }))).toEqual([
      "upstream_timeout",
    ])
  })

  test("quota_exhausted and credits_exhausted are separately selectable", () => {
    // Non-negotiable 7: they are never one filter, because one is a clock and the
    // other needs a human with a credit card.
    expect(outcomesFor(recentQuery.parse({ outcome: "quota_exhausted" }))).toEqual([
      "quota_exhausted",
    ])
    expect(outcomesFor(recentQuery.parse({ outcome: "credits_exhausted" }))).toEqual([
      "credits_exhausted",
    ])
  })
})

describe("the feed", () => {
  test("passes the parsed filter straight through to one bounded read", async () => {
    const { usage, asked } = service([attemptRow()])

    await usage.recent(recentQuery.parse({ limit: "10", failed: "true", requestId: "req-42" }))

    expect(asked).toHaveLength(1)
    expect(asked[0]?.limit).toBe(10)
    expect(asked[0]?.requestId).toBe("req-42")
    expect(asked[0]?.outcomes).not.toContain("success")
  })

  test("names the key, account and pool behind an attempt", async () => {
    const { usage } = service([attemptRow()])

    const result = await usage.recent(recentQuery.parse({}))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [attempt] = result.value.attempts
    expect(attempt?.key).toEqual({ id: "key-1", label: "dev-laptops", note: null })
    expect(attempt?.account).toEqual({ id: "acct-1", label: "claude-max-01", note: null })
    expect(attempt?.pool).toEqual({ id: "pool-1", label: "default", note: null })
  })

  test("an attempt whose subject is gone still renders, marked deleted", async () => {
    const { usage } = service([attemptRow({ accountId: "acct-gone" })])

    const result = await usage.recent(recentQuery.parse({}))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Usage rows outlive what they name. Hiding the attempt would hide the failure.
    expect(result.value.attempts[0]?.account).toEqual({
      id: "acct-gone",
      label: null,
      note: "deleted",
    })
  })

  test("an attempt that never reached an account is 'none', not 'deleted'", async () => {
    const { usage } = service([
      attemptRow({
        accountId: null,
        poolId: null,
        outcome: "scope_violation",
        httpStatus: null,
        errorClass: "ScopeViolationError",
      }),
    ])

    const result = await usage.recent(recentQuery.parse({}))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [attempt] = result.value.attempts
    expect(attempt?.account).toEqual({ id: null, label: null, note: "none" })
    // Never reached: the two nulls are what say so, and they are not zeros.
    expect(attempt?.httpStatus).toBeNull()
    expect(attempt?.errorClass).toBe("ScopeViolationError")
  })

  test("carries the diagnosis an aggregate cannot: ids, error class, latency split", async () => {
    const { usage } = service([
      attemptRow({
        attempt: 2,
        clientRequestId: "req-42",
        outcome: "upstream_timeout",
        httpStatus: null,
        errorClass: "UpstreamTimeoutError",
        streamed: false,
        ttfbMs: null,
      }),
    ])

    const result = await usage.recent(recentQuery.parse({}))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.attempts[0]).toMatchObject({
      attempt: 2,
      correlationId: "11111111-1111-4111-8111-111111111111",
      clientRequestId: "req-42",
      outcome: "upstream_timeout",
      errorClass: "UpstreamTimeoutError",
      latencyMs: 812,
      routerOverheadMs: 2,
      // No byte was ever relayed, so there is no time-to-first-byte. Not zero.
      ttfbMs: null,
      at: NOW.toISOString(),
    })
  })

  test("resolves whose problem the outcome is, so the console needs no copy of the taxonomy", async () => {
    const { usage } = service([
      attemptRow({ outcome: "quota_exhausted" }),
      attemptRow({ id: "row-2", outcome: "upstream_error" }),
      attemptRow({ id: "row-3", outcome: "client_error" }),
      attemptRow({ id: "row-4", outcome: "success" }),
    ])

    const result = await usage.recent(recentQuery.parse({}))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Straight from core's `usageOutcomeFault` — the same mapping the metrics group by.
    expect(result.value.attempts.map((row) => row.fault)).toEqual([
      "capacity",
      "upstream",
      "client",
      "none",
    ])
  })

  test("carries no field that could hold credential material", async () => {
    const { usage } = service([attemptRow()])

    const result = await usage.recent(recentQuery.parse({}))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const serialized = JSON.stringify(result.value)
    // The row is assembled from a named column list; `sessionKey` and the cost
    // columns are not on it, and no body is stored anywhere to leak.
    expect(serialized).not.toContain("sessionKey")
    expect(Object.keys(result.value.attempts[0] ?? {})).not.toContain("sessionKey")
  })

  test("echoes the limit that was asked for, not the number of rows that existed", async () => {
    const { usage } = service([attemptRow()])

    const result = await usage.recent(recentQuery.parse({ limit: "25" }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.attempts).toHaveLength(1)
    // A quiet router has truncated nothing; "at most 1" would describe the traffic.
    expect(result.value.limit).toBe(25)
  })
})
