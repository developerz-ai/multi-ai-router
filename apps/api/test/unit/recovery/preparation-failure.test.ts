import { expect, test } from "bun:test"
import { createSdkConcurrency, createSdkInvoker } from "../../../src/providers"
import { createHealthStore, planCandidates } from "../../../src/services/dataplane"
import { type ChainContext, runChain } from "../../../src/services/dataplane/chain"
import type { RecoveryAttempt } from "../../../src/services/dataplane/recovery-access"
import { createRuntime } from "../../../src/services/dataplane/runtime"
import type { UsageRecord } from "../../../src/services/usage"
import { catalog, cipher, clock, subscriptionAccount } from "../dataplane/fixtures"
import { candidate } from "../routing/fixtures"

for (const designated of [false, true]) {
  for (const preparation of ["missing-cli", "slot-deadline"] as const) {
    test(`${designated ? "probe" : "ordinary"} SDK ${preparation} before start is router refusal`, async () => {
      const upstream = subscriptionAccount("a")
      const c = catalog([upstream])
      const plan = planCandidates([candidate(upstream.snapshot)], c, "anthropic", "messages")
      const health = createHealthStore({ jitter: () => 0 })
      const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
      const held =
        preparation === "slot-deadline"
          ? await concurrency.acquire("blocker", new AbortController().signal)
          : undefined
      let starts = 0
      let cliChecks = 0
      let finished = 0
      const invoker = createSdkInvoker({
        concurrency,
        resolveCli: () => {
          cliChecks++
          return preparation === "slot-deadline"
            ? { ok: true, source: "platform_package", path: "/fixture/claude", bytes: 1000 }
            : { ok: false, attempts: [] }
        },
        runQuery: () => {
          throw new Error("must not invoke SDK")
        },
      })
      const rows: UsageRecord[] = []
      let started = false
      const attempt: RecoveryAttempt = {
        designated,
        started: () => started,
        beforeUpstreamStart: () => {
          started = true
          starts++
        },
        finish: () => {
          finished++
        },
      }
      const runtime = createRuntime({
        health,
        cipher: cipher(),
        call: async () => {
          throw new Error("must not fetch")
        },
        invokeSdk: invoker,
        sessionKeySource: "fingerprint",
        clock: clock(),
        timeoutMs: 10,
        record: (row) => {
          rows.push(row)
        },
        correlationId: crypto.randomUUID(),
        clientRequestId: null,
        apiKeyId: crypto.randomUUID(),
        sessionKey: "session",
        model: "claude",
        ingressDialect: "anthropic",
        operation: "messages",
        requestStarted: 0,
        recovery: {
          retryAfterMs: 1000,
          quotaStaleAfterMs: 1000,
          catalog: c,
          currentSnapshot: () => upstream.snapshot,
          hint: () => {},
          prepare: () => attempt,
          forget: () => {},
        },
      })
      const body = new TextEncoder().encode(
        JSON.stringify({
          model: "claude",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      )
      const context: ChainContext = {
        runtime,
        plan: plan.servable,
        request: new Request("http://router.test", { method: "POST" }),
        bodyBytes: body,
        modelSpan: null,
        translation: { created: 0, model: "claude", fallbackId: "test" },
        translated: { bodyFor: () => body },
        failover: undefined,
        log: undefined,
      }
      try {
        await expect(runChain(context)).rejects.toMatchObject({ status: 503 })
        expect(starts).toBe(0)
        expect(finished).toBe(0)
        expect(health.stateOf("a").breaker.consecutiveFailures).toBe(0)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.accountId).toBeNull()
        expect(rows[0]?.errorClass).toBe("NoHealthyAccountError")
        expect(cliChecks).toBe(1)
      } finally {
        held?.release()
      }
    })
  }
}
