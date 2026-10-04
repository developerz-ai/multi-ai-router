import type { DatabaseHandle } from "@multi-ai-router/db"
import { createSessionRepository } from "@multi-ai-router/db"
import { accounts } from "../../../packages/db/src/schema/accounts"
import { createSessionStore } from "../src/providers"
import { createDispatcher, createHealthStore } from "../src/services/dataplane"
import { catalog, cipher, subscriptionAccount } from "../test/unit/dataplane/fixtures"

/** A positive authoritative binding is SDK-only; never mislabel it as HTTP passthrough. */
export async function positiveBinding(
  database: DatabaseHandle,
  keyId: string,
  requests: number,
  holdMs: number,
  warmup = 20,
) {
  const accountId = crypto.randomUUID()
  await database.db
    .insert(accounts)
    .values({ id: accountId, label: "offline-binding-bench", provider: "anthropic-oauth" })
  const repository = createSessionRepository(database.db)
  let queries = 0
  let invoked = 0
  const sessions = createSessionStore({
    now: () => new Date(),
    repository: {
      ...repository,
      findByKey: (id, key) => {
        queries++
        return repository.findByKey(id, key)
      },
    },
  })
  try {
    await repository.upsert({
      apiKeyId: keyId,
      key: "positive",
      accountId,
      sdkSessionId: "offline-sdk",
      lastUsedAt: new Date(),
    })
    await sessions.binding(keyId, "positive")
    queries = 0
    const results = []
    for (const occupied of [false, true]) {
      let measured = false
      const bindingWaitMs: number[] = [],
        overheadMs: number[] = []
      const dispatcher = createDispatcher({
        catalog: catalog([subscriptionAccount(accountId)]),
        cipher: cipher(),
        health: createHealthStore(),
        sessions,
        onBindingWait: (ms) => {
          if (measured) bindingWaitMs.push(ms)
        },
        usage: {
          record: (record) => {
            if (measured) overheadMs.push(record.routerOverheadMs)
          },
        },
        invokeSdk: async (invocation) => {
          invoked++
          invocation.beforeUpstreamStart?.()
          invocation.onUpstreamStarted?.()
          return new Response(
            JSON.stringify({
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "offline" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { headers: { "content-type": "application/json" } },
          )
        },
      })
      let failures = 0
      for (let index = -warmup; index < requests; index++) {
        measured = index >= 0
        const held = occupied ? await database.sql.reserve() : undefined
        let released = false
        const releaseHeld = () => {
          if (!released) {
            released = true
            held?.release()
          }
        }
        const release = held === undefined ? undefined : setTimeout(releaseHeld, holdMs)
        try {
          const response = await dispatcher.dispatch({
            ingress: "anthropic",
            requestId: crypto.randomUUID(),
            key: {
              id: keyId,
              name: "offline",
              prefix: "offline",
              scope: { kind: "accounts", accountIds: [accountId] },
              rateLimitRequests: null,
              rateLimitWindowSeconds: null,
              expiresAt: null,
            },
            request: new Request("http://router.test/v1/messages", {
              method: "POST",
              headers: { "x-session-id": "positive" },
              body: JSON.stringify({
                model: "claude-opus-5",
                max_tokens: 16,
                messages: [{ role: "user", content: "offline" }],
              }),
            }),
          })
          if (response.status !== 200) failures++
          await response.arrayBuffer()
        } finally {
          if (release !== undefined) clearTimeout(release)
          releaseHeld()
        }
      }
      if (queries !== 0 || failures) throw Error("positive cache characterization failed")
      results.push({
        path: "agent-sdk (offline mock; exception)",
        cache: "positive-binding-hit",
        occupied,
        requests,
        discardedWarmupRequests: warmup,
        queries,
        failures,
        bindingWaitMs,
        routerOverheadMs: overheadMs,
      })
    }
    return { invoked, results }
  } finally {
    await database.sql`delete from accounts where id = ${accountId}`
  }
}
