import { expect, test } from "bun:test"
import { runAttempt } from "../../../src/services/dataplane/attempt"
import { createHealthStore } from "../../../src/services/dataplane/health"
import { planCandidates } from "../../../src/services/dataplane/plan"
import { createRecoveryAccess } from "../../../src/services/dataplane/recovery-access"
import { createRecoveryCapabilities } from "../../../src/services/dataplane/recovery-capability"
import { account, catalog, cipher, NOW } from "../dataplane/fixtures"
import { candidate } from "../routing/fixtures"
import { fixture } from "./fixtures"

for (const designated of [false, true]) {
  test(`${designated ? "designated revision mismatch" : "ordinary fresh quota"} honors custom threshold at final guard`, async () => {
    const upstream = account("a")
    upstream.snapshot = {
      ...upstream.snapshot,
      quotaWindows: [
        {
          window: "five_hour",
          utilization: 0.97,
          utilizationSource: "continuous",
          resetSource: "provider-reported",
          resetsAt: new Date(NOW.getTime() + 60000),
          lastCheckedAt: NOW,
          revision: 2,
        },
      ],
      ...(designated
        ? {
            recovery: {
              revision: 1,
              generation: "g",
              lifecycleVersion: 0,
              state: "issued" as const,
              quotaRevisions: { five_hour: 1 },
              nextAllowedAt: NOW,
            },
          }
        : {}),
    }
    const c = catalog([upstream])
    const health = createHealthStore()
    const caps = createRecoveryCapabilities("boot", () => ({
      lifecycleVersion: upstream.lifecycleVersion,
      authMaterial: upstream.authMaterial,
      status: "active",
      generation: "g",
      recoveryRevision: 1,
    }))
    if (designated)
      expect(
        caps.install({
          revision: 1,
          accountId: "a",
          generation: "g",
          permitId: "p",
          ownerBootId: "boot",
          ownershipEpoch: 1,
          expected: {
            lifecycleVersion: upstream.lifecycleVersion,
            authMaterial: upstream.authMaterial,
            status: "active",
          },
          quotaRevisions: { five_hour: 1 },
        }),
      ).toBe(true)
    const access = createRecoveryAccess({
      catalog: c,
      readAccount: () => upstream,
      coordinator: fixture().coordinator,
      health,
      capabilities: caps,
      now: () => NOW,
      retryAfterMs: 1000,
      quotaStaleAfterMs: 1000,
      quotaSpentThreshold: 0.95,
    })
    const selected = candidate(upstream.snapshot, 0, { halfOpen: designated })
    const plan = planCandidates([selected], c, "anthropic", "messages").servable[0]
    if (plan?.kind !== "http") throw new Error("missing HTTP fixture")
    const attempt = access.prepare(upstream, selected, 0.95)
    let fetches = 0
    const result = await runAttempt({
      plan,
      method: "POST",
      clientHeaders: new Headers(),
      body: null,
      cipher: cipher(),
      timeoutMs: 1000,
      beforeUpstreamStart: attempt.beforeUpstreamStart,
      fetch: async () => {
        fetches++
        return new Response()
      },
    })
    expect(result.kind).toBe("admission-refused")
    expect(attempt.started()).toBe(false)
    expect(fetches).toBe(0)
    expect(health.stateOf("a").breaker.consecutiveFailures).toBe(0)
    if (designated) expect(caps.available("a")).toBeDefined()
  })
}
