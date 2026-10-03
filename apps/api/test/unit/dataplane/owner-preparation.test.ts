import { expect, test } from "bun:test"
import { ownedCredentialMetadataReader } from "../../../src/composition/credential-ownership"
import { createSdkConcurrency, createSdkInvoker, createSdkQuotaStore } from "../../../src/providers"
import { createCredentialFreshness } from "../../../src/providers/claude-sdk/credential-freshness"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import type { UsageRecord } from "../../../src/services/usage"
import { catalog, cipher, subscriptionAccount } from "./fixtures"

for (const designated of [false, true]) {
  for (const failure of ["setup", "ready", "prepare", "metadata"] as const) {
    test(`${designated ? "designated" : "ordinary"} owner ${failure} failure refuses before admission`, async () => {
      const upstream = subscriptionAccount("a")
      const routing = catalog([upstream])
      const health = createHealthStore()
      const rows: UsageRecord[] = []
      const quota = createSdkQuotaStore()
      let starts = 0
      let outcomes = 0
      let activated = 0
      let cancelled = 0
      let queries = 0
      let iterations = 0
      const reader = ownedCredentialMetadataReader(
        {
          read: async () => {
            throw new Error("must not read unowned metadata")
          },
        },
        {
          ownerLaunch: () => {
            throw new Error("must not launch metadata fixture")
          },
          provisionAccount: async () => {
            throw new Error("must not provision")
          },
          revokeDeletedAccount: async () => {},
          cleanupDeletedAccount: async () => "deferred",
          withMetadataOwner: async () => {
            throw new UpstreamAdmissionRefused()
          },
          closeAdmission: () => {},
          stop: async () => {},
        },
        "/data/accounts",
      )
      const freshness = createCredentialFreshness({
        reader,
        configDirs: { pathFor: (id) => `/data/accounts/${id}` },
        skewMs: 300000,
        coldMarginMs: 300000,
        maxWaitMs: 1000,
        pollMs: 10,
        now: () => new Date(),
      })
      const invokeSdk = createSdkInvoker({
        ...(failure === "metadata" ? { freshness } : {}),
        concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
        resolveCli: () => ({
          ok: true,
          source: "platform_package",
          path: "/offline/claude",
          bytes: 1000,
        }),
        ownerLaunch: () => {
          if (failure === "setup") throw new Error("offline guardian setup failed")
          return {
            spawn: () => {
              throw new Error("must not spawn a real CLI")
            },
            ready:
              failure === "ready"
                ? Promise.reject(new Error("offline guardian readiness failed"))
                : Promise.resolve(),
            started: Promise.resolve(),
            release: () => {
              throw new Error("no owner metadata release in query")
            },
            prepare: async () => {
              throw new Error("offline guardian preparation failed")
            },
            assertReady: () => {
              throw new Error("must not reach final guard after preparation failure")
            },
            exited: Promise.resolve(),
            activate: () => {
              activated++
            },
            cancel: () => {
              cancelled++
            },
          }
        },
        runQuery: () => {
          queries++
          return {
            [Symbol.asyncIterator]() {
              iterations++
              throw new Error("must not iterate a failed owner query")
            },
          }
        },
      })
      const dispatcher = createDispatcher({
        catalog: routing,
        health,
        cipher: cipher(),
        usage: {
          record: (row) => {
            rows.push(row)
          },
        },
        fetch: async () => {
          throw new Error("must not fetch")
        },
        invokeSdk,
        quota,
        recovery: {
          catalog: routing,
          retryAfterMs: 1000,
          quotaStaleAfterMs: 1000,
          currentSnapshot: () => upstream.snapshot,
          hint: () => {},
          forget: () => {},
          prepare: () => ({
            designated,
            started: () => starts > 0,
            beforeUpstreamStart: () => {
              starts++
            },
            finish: () => {
              outcomes++
            },
          }),
        },
      })
      await expect(
        dispatcher.dispatch({
          ingress: "anthropic",
          requestId: crypto.randomUUID(),
          key: {
            id: "key",
            name: "offline",
            prefix: "offline",
            scope: { kind: "accounts", accountIds: ["a"] },
            rateLimitRequests: null,
            rateLimitWindowSeconds: null,
            expiresAt: null,
          },
          request: new Request("http://router.test/v1/messages", {
            method: "POST",
            body: JSON.stringify({
              model: "claude",
              max_tokens: 1,
              messages: [{ role: "user", content: "offline" }],
            }),
          }),
        }),
      ).rejects.toMatchObject({ status: 503 })
      expect({ starts, outcomes, activated, iterations }).toEqual({
        starts: 0,
        outcomes: 0,
        activated: 0,
        iterations: 0,
      })
      expect(queries).toBe(failure === "setup" || failure === "metadata" ? 0 : 1)
      expect(cancelled).toBe(failure === "setup" || failure === "metadata" ? 0 : 1)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ accountId: null, errorClass: "NoHealthyAccountError" })
      expect(health.stateOf("a").breaker.consecutiveFailures).toBe(0)
      expect(health.stateOf("a").inFlight).toBe(0)
      expect(quota.snapshot("a", new Date())).toBeNull()
    })
  }
}
