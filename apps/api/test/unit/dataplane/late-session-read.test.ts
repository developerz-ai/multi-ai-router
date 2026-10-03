import { expect, test } from "bun:test"
import { createSessionStore, type SessionStore } from "../../../src/providers"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { memorySessions } from "../claude-sdk/fixtures"
import { catalog, cipher, subscriptionAccount } from "./fixtures"

test("late session binding after shutdown cannot select, invalidate, remember, or launch upstream", async () => {
  const repository = memorySessions([
    {
      apiKeyId: "key",
      key: "conversation",
      accountId: "removed",
      sdkSessionId: "old-sdk",
      lastUsedAt: new Date(),
    },
  ])
  const entered = Promise.withResolvers<void>()
  const binding = Promise.withResolvers<Awaited<ReturnType<typeof repository.findByKey>>>()
  const registry = createActiveRequestRegistry({ maximumEntries: 1 })
  const health = createHealthStore(),
    rows: UsageRecord[] = []
  let writerStopped = false,
    writesAfterStop = 0,
    invalidations = 0,
    resolves = 0,
    remembers = 0
  let sdkCalls = 0,
    fetches = 0
  const actualStore = createSessionStore({
    now: () => new Date(),
    repository: {
      ...repository,
      findByKey: async () => {
        entered.resolve()
        return binding.promise
      },
      upsert: async (input) => {
        if (writerStopped) {
          writesAfterStop++
          throw new Error("session persistence closed")
        }
        return repository.upsert(input)
      },
    },
  })
  const sessions: SessionStore = {
    ...actualStore,
    invalidate(apiKeyId, sessionKey) {
      invalidations++
      actualStore.invalidate(apiKeyId, sessionKey)
    },
    resolve(input) {
      resolves++
      const turn = actualStore.resolve(input)
      return {
        ...turn,
        remember(id, uuid) {
          remembers++
          turn.remember(id, uuid)
        },
      }
    },
  }
  const dispatcher = createDispatcher({
    activeRequests: registry,
    health,
    catalog: catalog([subscriptionAccount("offline")]),
    cipher: cipher(),
    sessions,
    usage: {
      record: (row) => {
        rows.push(row)
      },
    },
    fetch: async () => {
      fetches++
      return new Response("{}")
    },
    invokeSdk: async () => {
      sdkCalls++
      return new Response("{}")
    },
  })
  const pending = dispatcher
    .dispatch({
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
        headers: { "x-session-id": "conversation" },
        body: JSON.stringify({
          model: "claude",
          max_tokens: 1,
          messages: [{ role: "user", content: "offline" }],
        }),
      }),
    })
    .catch((error) => error)
  await entered.promise
  await registry.stop()
  // The producer barrier has completed; subsequent session persistence would be unsafe.
  writerStopped = true
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    outcome: "router_error",
    errorClass: "router_shutdown",
    model: "claude",
    upstreamModel: null,
    accountId: null,
    provider: null,
    httpStatus: null,
    responseStatus: 503,
    streamed: false,
  })
  binding.resolve(repository.rows.get("key::conversation"))
  expect(await pending).toMatchObject({ name: "RouterShutdownError" })
  await Bun.sleep(0)
  expect(rows).toHaveLength(1)
  expect(registry.size).toBe(0)
  expect(sdkCalls).toBe(0)
  expect(fetches).toBe(0)
  expect(invalidations).toBe(0)
  expect(resolves).toBe(0)
  expect(remembers).toBe(0)
  expect(repository.writes).toHaveLength(0)
  expect(writesAfterStop).toBe(0)
  expect(health.stateOf("offline").inFlight).toBe(0)
})
