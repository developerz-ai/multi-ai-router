import { expect, test } from "bun:test"
import { toErrorResponse } from "../../../src/errors/render"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { catalog, cipher, subscriptionAccount } from "./fixtures"

/**
 * The Agent SDK's own words for an aborted turn: a plain `Error`, not an `AbortError` (sdk.mjs
 * throws `new Error("Operation aborted")` from its transport once the launch's controller aborts).
 * Production fingerprint (#297, 2.25.8): Claude Code cancelled a request in flight and the row read
 * `502`, `upstream_error`, `claude-sdk:unclassified` — an upstream failure that never happened.
 */
const SDK_ABORT_ECHO = new Error("Operation aborted")

interface Harness {
  readonly entered: PromiseWithResolvers<void>
  readonly upstream: PromiseWithResolvers<Response>
  readonly controller: AbortController
  readonly rows: UsageRecord[]
  readonly health: ReturnType<typeof createHealthStore>
  readonly registry: ReturnType<typeof createActiveRequestRegistry>
  readonly dispatch: () => Promise<Response>
}

function harness(options?: { upstreamTimeoutMs?: number }): Harness {
  const entered = Promise.withResolvers<void>()
  const upstream = Promise.withResolvers<Response>()
  const controller = new AbortController()
  const registry = createActiveRequestRegistry({ maximumEntries: 1 })
  const health = createHealthStore()
  const rows: UsageRecord[] = []
  const dispatcher = createDispatcher({
    activeRequests: registry,
    catalog: catalog([subscriptionAccount("offline")]),
    cipher: cipher(),
    health,
    usage: { record: (row) => void rows.push(row) },
    options: {
      failover: { maxAttempts: 1 },
      ...(options === undefined ? {} : { upstreamTimeoutMs: options.upstreamTimeoutMs }),
    },
    invokeSdk: async (input) => {
      input.beforeUpstreamStart?.()
      input.onUpstreamStarted?.()
      entered.resolve()
      return upstream.promise
    },
  })
  const dispatch = () =>
    dispatcher.dispatch({
      ingress: "anthropic",
      requestId: crypto.randomUUID(),
      key: {
        id: "key",
        name: "offline",
        prefix: "offline",
        scope: { kind: "accounts", accountIds: ["offline"] },
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
        signal: controller.signal,
      }),
    })
  return { entered, upstream, controller, rows, health, registry, dispatch }
}

test("client disconnect mid-SDK-turn records a client cancel, not an upstream 502", async () => {
  const h = harness({ upstreamTimeoutMs: 1000 })
  const pending = h.dispatch().then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  )
  await h.entered.promise
  expect(h.health.stateOf("offline").inFlight).toBe(1)

  // The client goes away first; the SDK then answers the abort of its own launch with its own
  // wording rather than the signal's reason.
  h.controller.abort(new Error("offline caller disconnected"))
  h.upstream.reject(SDK_ABORT_ECHO)

  const result = await pending
  const status =
    result.value !== undefined
      ? result.value.status
      : toErrorResponse(result.error, "anthropic").status
  expect(status).toBe(499)
  expect(h.rows).toHaveLength(1)
  expect(h.rows[0]).toMatchObject({
    accountId: "offline",
    httpStatus: null,
    responseStatus: 499,
    outcome: "client_error",
    errorClass: "client_cancelled",
  })
  // Nothing failed upstream: the account's health must not hear about it.
  expect(h.health.stateOf("offline").breaker.consecutiveFailures).toBe(0)
  expect(h.health.stateOf("offline").breaker.status).toBe("active")
  expect(h.health.stateOf("offline").inFlight).toBe(0)
  expect(h.registry.size).toBe(0)
  await h.registry.stop()
  expect(h.rows).toHaveLength(1)
})

test("SDK abort while the client is still connected stays an upstream error", async () => {
  const h = harness({ upstreamTimeoutMs: 1000 })
  const pending = h.dispatch().then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  )
  await h.entered.promise

  // The same wording, but no signal of ours aborted: the SDK aborted on its own, which is an
  // upstream failure and must strike the account like one.
  h.upstream.reject(SDK_ABORT_ECHO)

  const result = await pending
  expect(h.controller.signal.aborted).toBe(false)
  const status =
    result.value !== undefined
      ? result.value.status
      : toErrorResponse(result.error, "anthropic").status
  expect(status).toBe(502)
  expect(h.rows).toHaveLength(1)
  expect(h.rows[0]).toMatchObject({
    accountId: "offline",
    responseStatus: 502,
    outcome: "upstream_error",
  })
  expect(h.rows[0]?.errorClass).not.toBe("client_cancelled")
  expect(h.health.stateOf("offline").breaker.consecutiveFailures).toBe(1)
  expect(h.health.stateOf("offline").inFlight).toBe(0)
  await h.registry.stop()
  expect(h.rows).toHaveLength(1)
})
