import { expect, test } from "bun:test"
import { createSdkConcurrency, createSdkInvoker, createSdkQuotaStore } from "../../../src/providers"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import type { RecoveryAccess } from "../../../src/services/dataplane/recovery-access"
import { sdkTurn } from "../claude-sdk/fixtures"
import { catalog, cipher, clock, subscriptionAccount } from "./fixtures"

for (const mode of ["ordinary", "probe", "early-reading"] as const) {
  const designated = mode === "probe"
  const early = mode === "early-reading"
  test(`dispatcher late SDK rejection retains cooldown atEOF (${mode})`, async () => {
    const timer = clock(new Date("2026-10-03T00:00:00Z"))
    const entries = catalog([subscriptionAccount("sub")])
    const gate = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const quota = createSdkQuotaStore()
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const finishes: string[] = []
    let writes = 0,
      started = false
    const health = createHealthStore({
      onQuotaWindows: () => {
        writes++
      },
    })
    const recovery: RecoveryAccess = {
      retryAfterMs: 1000,
      quotaStaleAfterMs: 60000,
      catalog: entries,
      currentSnapshot: () => entries.accounts()[0]?.snapshot,
      hint: () => {},
      forget: () => {},
      prepare: () => ({
        designated,
        started: () => started,
        beforeUpstreamStart: () => {
          started = true
        },
        finish: (outcome) => {
          finishes.push(outcome)
        },
      }),
    }
    const invokeSdk = createSdkInvoker({
      concurrency,
      resolveCli: () => ({
        ok: true,
        source: "env_override",
        path: "/offline/claude",
        bytes: 1000,
      }),
      runQuery: ({ prompt }) => {
        void (async () => {
          for await (const _ of prompt) {
          }
        })()
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "offline" }
            if (early)
              yield {
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "allowed",
                  rateLimitType: "five_hour",
                  utilization: 0.8,
                },
              }
            yield* sdkTurn({
              blocks: [
                [
                  { type: "text", text: "" },
                  { type: "text_delta", text: "pong" },
                ],
              ],
            })
            reached.resolve()
            await gate.promise
            yield {
              type: "rate_limit_event",
              rate_limit_info: {
                status: "rejected",
                rateLimitType: "five_hour",
                utilization: 1,
                resetsAt: timer.now().getTime() / 1000 + 3600,
              },
            }
            yield { type: "result", subtype: "success" }
          },
        }
      },
    })
    const dispatcher = createDispatcher({
      usage: { record: () => {} },
      catalog: entries,
      recovery,
      health,
      quota,
      cipher: cipher(),
      clock: timer,
      invokeSdk,
    })
    const response = await dispatcher.dispatch({
      ingress: "anthropic",
      requestId: crypto.randomUUID(),
      key: {
        id: "key",
        name: "offline",
        prefix: "offline",
        scope: { kind: "accounts", accountIds: ["sub"] },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      request: new Request("http://router.test/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude",
          stream: true,
          max_tokens: 1,
          messages: [{ role: "user", content: "offline" }],
        }),
      }),
    })
    expect(response.status).toBe(200)
    expect(writes).toBe(early ? 1 : 0)
    const drained = response.text()
    await reached.promise
    expect(health.stateOf("sub").breaker.status).toBe("active")
    gate.resolve()
    const wire = await drained
    expect(wire).toContain("pong")
    expect(wire).not.toContain("five_hour")
    expect(health.stateOf("sub").breaker.status).toBe("cooling_down")
    expect(health.stateOf("sub").quotaWindows[0]).toMatchObject({
      window: "five_hour",
      utilization: 1,
    })
    expect(writes).toBe(early ? 2 : 1)
    expect(finishes).toEqual(["failed"])
    expect(health.stateOf("sub").inFlight).toBe(0)
    expect(concurrency.inFlight).toBe(0)
  })
}
