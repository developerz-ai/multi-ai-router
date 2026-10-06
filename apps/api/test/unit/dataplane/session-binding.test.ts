import { describe, expect, test } from "bun:test"
import { parseEnv } from "../../../src/config/env"
import { createLogger } from "../../../src/logging/logger"
import type { SessionStore, SessionTurn } from "../../../src/providers"
import { sessionBindings, sessionStoreFromEnv } from "../../../src/services/dataplane"
import { memorySessions, messagesBody } from "../claude-sdk/fixtures"
import { account, catalog, subscriptionAccount } from "./fixtures"

/**
 * The gate in front of the binding lookup.
 *
 * Only the Agent-SDK path ever writes a binding, so a router with no subscription Account has
 * nothing to look up — and looking anyway would put one indexed query on every request of a
 * deployment that can never benefit from it (CLAUDE.md non-negotiable 8). The catalog is read per
 * call rather than captured, so an Account added at runtime starts binding on the next request.
 */

function spyStore(): SessionStore & { readonly reads: string[]; readonly dropped: string[] } {
  const reads: string[] = []
  const dropped: string[] = []
  return {
    reads,
    dropped,
    binding: async (apiKeyId, sessionKey) => {
      reads.push(`${apiKeyId}/${sessionKey}`)
      return { accountId: "acct-1", sdkSessionId: "sess_1" }
    },
    invalidate: (apiKeyId, sessionKey) => {
      dropped.push(`${apiKeyId}/${sessionKey}`)
    },
    resolve: () => {
      const turn: SessionTurn = {
        plan: { kind: "fresh", reason: "no-session" },
        prepare: () => Promise.resolve(turn),
        remember: () => {},
        release: () => {},
      }
      return turn
    },
  }
}

describe("whether a request has a binding to read at all", () => {
  test("no store wired: no binding, and nothing to fail", async () => {
    const bindings = sessionBindings(catalog([account("api-1")]), undefined)

    expect(await bindings.read("key-1", "conv-1")).toBeUndefined()
  })

  test("a router with only HTTP accounts never queries", async () => {
    const store = spyStore()
    const bindings = sessionBindings(catalog([account("api-1")]), store)

    expect(await bindings.read("key-1", "conv-1")).toBeUndefined()
    expect(store.reads).toHaveLength(0)
  })

  test("one subscription account anywhere in the catalog turns the lookup on", async () => {
    const store = spyStore()
    const store2 = catalog([account("api-1"), subscriptionAccount("sub")])
    const bindings = sessionBindings(store2, store)

    expect(await bindings.read("key-1", "conv-1")).toMatchObject({ accountId: "acct-1" })
    expect(store.reads).toEqual(["key-1/conv-1"])
  })
})

describe("the production store's log lines", () => {
  test("a bound session that starts fresh without carrying names why, by id and enum only", () => {
    const lines: Record<string, unknown>[] = []
    const env = parseEnv({
      DATABASE_URL: "postgres://router:router@postgres:5432/router",
      ADMIN_OIDC_ISSUER_URL: "https://sso.test",
      ADMIN_OIDC_CLIENT_ID: "multi-ai-router-test",
      ADMIN_OIDC_REDIRECT_URI: "https://router.test/api/admin/auth/oidc/callback",
      ADMIN_OIDC_ADMIN_EMAIL: "admin@test",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    })
    const store = sessionStoreFromEnv({
      env,
      repository: memorySessions(),
      logger: createLogger({ level: "info", write: (line) => lines.push(JSON.parse(line)) }),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    })
    const opening = messagesBody([{ role: "user", text: "a secret question" }])
    const input = { apiKeyId: "key-1", sessionKey: "conv-1", keySource: "header" as const }
    const first = store.resolve({ ...input, accountId: "acct-1", body: opening })
    first.remember("sess_1", "uuid-1")
    first.release()

    store.resolve({ ...input, accountId: "acct-2", body: opening }).release()

    expect(lines).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "bound session not carried; the turn starts fresh",
        component: "dataplane",
        fromAccountId: "acct-1",
        toAccountId: "acct-2",
        reason: "replay",
      }),
    ])
    expect(JSON.stringify(lines)).not.toContain("secret question")
    expect(JSON.stringify(lines)).not.toContain("sess_1")
  })
})
