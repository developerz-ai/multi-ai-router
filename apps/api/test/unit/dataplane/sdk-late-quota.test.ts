import { expect, test } from "bun:test"
import { createSdkConcurrency, createSdkInvoker, createSdkQuotaStore } from "../../../src/providers"
import { claudeSdkDriver } from "../../../src/providers/claude-sdk/driver"
import { createHealthStore } from "../../../src/services/dataplane/health"
import { accountHealthFacts } from "../../../src/services/dataplane/health-observation"
import { runSdkAttempt } from "../../../src/services/dataplane/sdk-attempt"
import { rateLimitCapture } from "../../../src/services/dataplane/sdk-attempt-response"
import { sdkTurn } from "../claude-sdk/fixtures"
import { subscriptionAccount } from "./fixtures"

const now = new Date("2026-10-03T00:00:00Z")
const rejected = {
  status: "rejected",
  rateLimitType: "five_hour",
  utilization: 1,
  resetsAt: now.getTime() / 1000 + 3600,
}
function plan() {
  const upstream = subscriptionAccount("sub")
  return {
    kind: "sdk" as const,
    candidate: {
      account: upstream.snapshot,
      poolId: null,
      weight: 100,
      priority: 0,
      order: 0,
      upstreamModel: "model",
      halfOpen: false,
    },
    account: upstream,
    driver: claudeSdkDriver,
    dialect: "anthropic" as const,
    configDir: "/offline/sub",
    upstreamModel: "model",
    translation: null,
    egressMode: "agent-sdk" as const,
  }
}
for (const mode of ["current", "generation", "revoked"] as const) {
  const accepted = mode === "current"
  test(`actual SDK post-header quota event ${mode}`, async () => {
    const quota = createSdkQuotaStore()
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const gate = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const health = createHealthStore()
    const facts = accountHealthFacts(plan().account)
    const observation = health.captureAttempt("sub", facts)
    const seen: unknown[] = []
    const invoke = createSdkInvoker({
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
            yield { type: "system", subtype: "init", session_id: "offline-session" }
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
            yield { type: "rate_limit_event", rate_limit_info: rejected }
            yield { type: "result", subtype: "success" }
          },
        }
      },
    })
    const outcome = await runSdkAttempt({
      plan: plan(),
      body: new TextEncoder().encode(
        JSON.stringify({
          model: "model",
          stream: true,
          max_tokens: 1,
          messages: [{ role: "user", content: "offline" }],
        }),
      ),
      invoke,
      session: undefined,
      timeoutMs: 1000,
      quota,
      now: () => now,
      rateLimitObserver: {
        accepts: () => health.acceptsObservation("sub", observation),
        observe: (signal, at) => {
          seen.push({ signal, at })
          health.applyRateLimit("sub", signal, at, observation)
        },
      },
    })
    if (outcome.kind !== "success") throw new Error("fixture SDK did not produce headers")
    expect(outcome.response.status).toBe(200)
    const reader = outcome.response.body?.getReader()
    if (!reader) throw new Error("fixture has no SSE body")
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(outcome.rateLimit).toBeNull()
    expect(seen).toHaveLength(0)
    await reached.promise
    if (mode === "generation")
      health.reconcile("sub", { ...facts, recoveryGeneration: crypto.randomUUID() })
    if (mode === "revoked") health.reset("sub")
    gate.resolve()
    const chunks = [first.value]
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      chunks.push(step.value)
    }
    expect(seen).toHaveLength(accepted ? 1 : 0)
    expect(quota.snapshot("sub", now)?.signal.limited ?? false).toBe(accepted)
    const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("")
    expect(text).toContain("pong")
    expect(text).not.toContain("five_hour")
    expect(health.stateOf("sub").quotaWindows.length).toBe(accepted ? 1 : 0)
    expect(concurrency.inFlight).toBe(0)
  })
}
test("closed capture and malformed events never publish or populate SDK state", () => {
  const quota = createSdkQuotaStore()
  let published = 0
  const capture = rateLimitCapture(
    {
      plan: plan(),
      body: null,
      invoke: undefined,
      session: undefined,
      timeoutMs: 1000,
      quota,
      now: () => now,
      rateLimitObserver: {
        accepts: () => true,
        observe: () => {
          published++
        },
      },
    },
    "sub",
  )
  capture.capture(null)
  expect(published).toBe(0)
  capture.close()
  capture.capture(rejected)
  expect(published).toBe(0)
  expect(quota.snapshot("sub", now)).toBeNull()
})
