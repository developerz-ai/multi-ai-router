import { expect, test } from "bun:test"
import { createHealthStore } from "../../../src/services/dataplane/health"
import { overlayHealth } from "../../../src/services/dataplane/snapshot"
import { runPolicy } from "../../../src/services/routing"
import { account, candidate, continuous, ids, limiter, NOW } from "../routing/fixtures"

for (const kind of ["named", "limiter"] as const) {
  test(`quota policy ignores expired ${kind} gauge using injected request time`, () => {
    const stale = account(
      "stale",
      kind === "named"
        ? { quotaWindows: [{ ...continuous(0.1), resetsAt: NOW }] }
        : { limiterWindows: [limiter(0.1, "requests", { resetsAt: NOW })] },
    )
    const fresh = account("fresh", {
      quotaWindows: [{ ...continuous(0.9), resetsAt: new Date(NOW.getTime() + 1000) }],
    })
    const result = runPolicy("quota-aware", {
      candidates: [candidate(stale), candidate(fresh)],
      now: NOW,
      options: {},
      rotationCounter: 0,
      sessionKey: "session",
    })
    expect(ids(result.ordered)).toEqual(["fresh", "stale"])
    expect(result.notes).toContainEqual({
      kind: "policy-degraded",
      from: "quota-aware",
      to: "round-robin",
      reason: "no-continuous-quota-signal",
      accountIds: ["stale"],
    })
  })
}

test("warm overlay preserves catalog retirement over stale local evidence", () => {
  const local = createHealthStore().stateOf("a")
  const old = {
    ...continuous(1),
    lastCheckedAt: new Date(NOW.getTime() - 1000),
    resetsAt: new Date(NOW.getTime() - 1),
  }
  const retired = {
    ...old,
    utilization: undefined,
    utilizationSource: "none" as const,
    resetsAt: undefined,
    resetSource: "unknown" as const,
    revision: 2,
    retiredAt: NOW,
    evidenceState: "expired" as const,
    blocksRouting: false,
  }
  const overlaid = overlayHealth(account("a", { quotaWindows: [retired] }), {
    ...local,
    quotaWindows: [old],
  })
  expect(overlaid.quotaWindows?.[0]).toEqual(retired)
})
test("limiter reset survives warm snapshot mapping for expiry-aware ranking", () => {
  const local = createHealthStore().stateOf("a")
  const reset = new Date(NOW.getTime() - 1)
  const overlaid = overlayHealth(account("a"), {
    ...local,
    limiterWindows: [
      {
        limiter: "requests",
        utilization: 1,
        utilizationSource: "continuous",
        resetSource: "provider-reported",
        resetsAt: reset,
      },
    ],
  })
  expect(overlaid.limiterWindows?.[0]?.resetsAt).toEqual(reset)
})
