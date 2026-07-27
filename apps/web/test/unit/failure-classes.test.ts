import { describe, expect, test } from "bun:test"
import { UsageOutcome, usageOutcomeFault } from "@multi-ai-router/core"
import {
  FAILURE_CLASSES,
  type FailureCount,
  failureClassFor,
  groupFailures,
  HEADLINE_FAILURE_CLASSES,
} from "../../src/lib/failure-classes"

/**
 * The finer axis, and the drift gates that keep it honest.
 *
 * The console groups failures more finely than core's `UsageFault` does, because
 * `quota_exhausted` and `credits_exhausted` are both `capacity` and their
 * remedies are opposites — one is a window a clock refills, the other a balance a
 * human refills (CLAUDE.md non-negotiable 7). The rule this file enforces is that
 * the finer axis may **split** a fault and may never **contradict** one, and that
 * every outcome core defines has somewhere to land.
 *
 * The gates may import core freely: tests are not bundled, so the Zod-free rule
 * the module itself follows does not apply here — which is the whole point of
 * putting the check in a test rather than trusting a comment.
 */

function count(outcome: FailureCount["outcome"], attempts: number): FailureCount {
  return { outcome, attempts }
}

const FAILURES = UsageOutcome.options.filter(
  (outcome): outcome is FailureCount["outcome"] => outcome !== "success",
)

describe("the class table", () => {
  test("every outcome core defines has a class — an added one fails this build first", () => {
    for (const outcome of FAILURES) {
      const klass = failureClassFor(outcome)
      expect(klass).toBeDefined()
      expect(klass.label.length).toBeGreaterThan(0)
      expect(klass.hint.length).toBeGreaterThan(0)
    }
  })

  test("a class never contradicts the fault core assigns the outcomes in it", () => {
    for (const outcome of FAILURES) {
      expect(failureClassFor(outcome).fault).toBe(usageOutcomeFault(outcome))
    }
  })

  test("the three non-negotiable-7 remedies are three classes with three statuses", () => {
    expect(failureClassFor("quota_exhausted").status).toBe(429)
    expect(failureClassFor("credits_exhausted").status).toBe(402)
    expect(failureClassFor("scope_violation").status).toBe(403)

    // Same coarse fault, deliberately different rows: waiting will never fix the second.
    expect(usageOutcomeFault("quota_exhausted")).toBe(usageOutcomeFault("credits_exhausted"))
    expect(failureClassFor("quota_exhausted").id).not.toBe(failureClassFor("credits_exhausted").id)
  })

  test("a key's own ceiling is its own class, not the provider's rate limit", () => {
    // Both are 429. One is a setting the operator changes; the other is a wait.
    expect(failureClassFor("key_rate_limited").status).toBe(429)
    expect(failureClassFor("key_rate_limited").id).not.toBe(failureClassFor("quota_exhausted").id)
  })

  test("a class with more than one real status says so rather than picking one", () => {
    // 400, 413 and a relayed upstream 4xx all land in `bad_request`.
    expect(failureClassFor("client_error").status).toBeNull()
    expect(failureClassFor("request_too_large").id).toBe(failureClassFor("client_error").id)
  })

  test("every id in the table is the id of its own entry", () => {
    for (const [id, klass] of Object.entries(FAILURE_CLASSES)) expect(klass.id).toBe(id)
  })

  test("the headline classes are real classes, in the order non-negotiable 7 names them", () => {
    expect(HEADLINE_FAILURE_CLASSES).toEqual(["rate_limited", "out_of_credits", "out_of_scope"])
    for (const id of HEADLINE_FAILURE_CLASSES) expect(FAILURE_CLASSES[id]).toBeDefined()
  })
})

describe("groupFailures", () => {
  test("shows the three headline classes at zero — an absence is an answer", () => {
    const groups = groupFailures([])

    expect(groups.map((group) => group.klass.id)).toEqual([...HEADLINE_FAILURE_CLASSES])
    for (const group of groups) expect(group.attempts).toBe(0)
  })

  test("keeps the headline three first even when something else is far bigger", () => {
    const groups = groupFailures([count("upstream_error", 900), count("quota_exhausted", 1)])

    expect(groups.slice(0, 3).map((group) => group.klass.id)).toEqual([...HEADLINE_FAILURE_CLASSES])
    expect(groups[3]?.klass.id).toBe("upstream_failed")
  })

  test("sums the outcomes inside a class and keeps them listed", () => {
    const groups = groupFailures([
      count("upstream_error", 4),
      count("upstream_timeout", 9),
      count("upstream_auth_failed", 2),
    ])
    const upstream = groups.find((group) => group.klass.id === "upstream_failed")

    expect(upstream?.attempts).toBe(15)
    // Biggest first, so "which upstream failure" is answered by reading down.
    expect(upstream?.outcomes.map((row) => row.outcome)).toEqual([
      "upstream_timeout",
      "upstream_error",
      "upstream_auth_failed",
    ])
  })

  test("never merges quota into credits, whatever their counts", () => {
    const groups = groupFailures([count("quota_exhausted", 5), count("credits_exhausted", 5)])
    const rateLimited = groups.find((group) => group.klass.id === "rate_limited")
    const outOfCredits = groups.find((group) => group.klass.id === "out_of_credits")

    expect(rateLimited?.attempts).toBe(5)
    expect(outOfCredits?.attempts).toBe(5)
    // 10 is the forbidden number: a "capacity" bucket nobody can act on.
    expect(groups.some((group) => group.attempts === 10)).toBe(false)
  })

  test("omits a non-headline class that did not happen", () => {
    const groups = groupFailures([count("router_error", 1)])

    expect(groups.map((group) => group.klass.id)).toEqual([
      ...HEADLINE_FAILURE_CLASSES,
      "router_bug",
    ])
    expect(groups.some((group) => group.klass.id === "upstream_failed")).toBe(false)
  })

  test("ignores a zero count, so a class is never listed for having happened never", () => {
    expect(groupFailures([count("upstream_error", 0)]).map((g) => g.klass.id)).toEqual([
      ...HEADLINE_FAILURE_CLASSES,
    ])
  })

  test("ranks the rest biggest first", () => {
    const groups = groupFailures([
      count("client_error", 2),
      count("upstream_error", 30),
      count("router_error", 9),
    ])

    expect(groups.slice(3).map((group) => group.klass.id)).toEqual([
      "upstream_failed",
      "router_bug",
      "bad_request",
    ])
  })

  test("ties break on the class id, so the order never wobbles between refreshes", () => {
    const rows = [count("upstream_error", 5), count("router_error", 5), count("client_error", 5)]

    const forwards = groupFailures(rows).map((group) => group.klass.id)
    const backwards = groupFailures([...rows].reverse()).map((group) => group.klass.id)

    expect(forwards.slice(3)).toEqual(["bad_request", "router_bug", "upstream_failed"])
    expect(backwards).toEqual(forwards)
  })

  test("does not reorder the caller's array — it is shared query state", () => {
    const rows = [count("upstream_timeout", 1), count("upstream_error", 9)]
    const original = rows.map((row) => row.outcome)

    groupFailures(rows)

    expect(rows.map((row) => row.outcome)).toEqual(original)
  })

  test("every failure outcome core defines lands in a group", () => {
    const groups = groupFailures(FAILURES.map((outcome) => count(outcome, 1)))
    const placed = groups.flatMap((group) => group.outcomes.map((row) => row.outcome))

    expect(new Set(placed)).toEqual(new Set(FAILURES))
    expect(groups.reduce((sum, group) => sum + group.attempts, 0)).toBe(FAILURES.length)
  })
})
