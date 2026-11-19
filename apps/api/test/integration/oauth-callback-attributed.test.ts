import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createLogger } from "../../src/logging/logger"
import { errorHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { oauthCallbackRoutes } from "../../src/routes/admin/oauth-callback"
import { createOAuthConnectService, OAUTH_CALLBACK_PATH } from "../../src/services/accounts"
import {
  type AuditContext,
  createAuditRecorder,
  runWithAuditContext,
} from "../../src/services/admin"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import type { AppEnv } from "../../src/types"
import { createMemoryStore } from "../support/memory-store"
import { pasteOnlyFlow } from "../support/oauth-flows"
import { silentLogger } from "../support/silent-logger"

/**
 * multi-ai-router#455: the provider's redirect lands on the unguarded OAuth callback
 * (`routes/admin/oauth-callback.ts`), a cross-site navigation that carries no session. The connect's
 * start stores its caller on the `oauth_states` row, and the callback runs the exchange under it, so
 * the `account.connected` row names the operator who started it — not `unattributed`.
 *
 * Formerly `oauth-callback-unattributed.test.ts`, the pin of the pre-#455 behaviour; the one case it
 * still covers is a state row with no initiator (minted before migration 0050).
 */

const NOW = new Date("2026-11-19T12:00:00.000Z")

const OPERATOR: AuditContext = {
  actor: "ops@example.test",
  actorKind: "session",
  says: "x",
  clientIp: "203.0.113.7",
  userAgent: "console/1.0",
  requestId: "req-begin",
}

function tokenResponse(): Response {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }
  return new Response(
    JSON.stringify({
      access_token: "at-1",
      expires_in: 3600,
      id_token: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

/** `rewrite` edits the stored row between the start and the redirect, as an older image would have left it. */
async function connectThroughCallback(rewrite?: { initiatedBy: unknown }) {
  const store = createMemoryStore()
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({
    level: "debug",
    write: (line) => void lines.push(JSON.parse(line)),
  })
  const connect = createOAuthConnectService({
    accounts: store.accounts,
    states: store.oauthStates,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(7) }),
    audit: createAuditRecorder(store.audit, logger),
    stateMinutes: 10,
    fetch: async () => tokenResponse(),
    exchangeTimeoutMs: 1_000,
    refreshCatalogAfterMutation: async () => {},
    now: () => NOW,
    flowFor: pasteOnlyFlow,
  })
  const app = new Hono<AppEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(silentLogger()))
  app.onError(errorHandler(silentLogger(), null))
  // Mounted exactly as `app.ts` mounts it: at the root, without the guard.
  app.route("/", oauthCallbackRoutes({ connect }))

  const account = await store.accounts.create({ label: "openai-1", provider: "openai-oauth" })
  // The operator starts the connect inside their own request, as the guarded route does...
  const started = await runWithAuditContext(OPERATOR, () => connect.begin(account.id, "connect"))
  if (!started.ok) throw new Error(started.failure.message)
  const state = new URL(started.value.authorizeUrl).searchParams.get("state")
  if (state === null) throw new Error("authorize URL carried no state")
  const row = store.rows.oauthStates.find((candidate) => candidate.state === state)
  if (row === undefined) throw new Error("no oauth_states row for the state")
  if (rewrite !== undefined) Object.assign(row, rewrite)

  // ...and the provider's redirect arrives later, as a request of its own with no session.
  const response = await app.request(
    `${OAUTH_CALLBACK_PATH}?${new URLSearchParams({ code: "a-real-looking-code", state })}`,
  )
  expect(response.status).toBe(200)

  const connected = store.rows.audit.filter((audit) => audit.kind === "account.connected")
  expect(connected).toHaveLength(1)
  const unattributed = lines.filter((line) => line.msg === "audit event without a caller")
  return { store, row, connected: connected[0], unattributed }
}

describe("the OAuth redirect callback", () => {
  test("writes account.connected as the operator who started the connect, with no unattributed line", async () => {
    const { row, connected, unattributed } = await connectThroughCallback()

    expect(row.initiatedBy).toEqual({
      actor: OPERATOR.actor,
      actorKind: "session",
      says: "x",
      clientIp: "203.0.113.7",
      userAgent: "console/1.0",
      requestId: "req-begin",
    })
    expect(connected).toMatchObject({
      actor: "ops@example.test",
      actorKind: "session",
      actorSays: "x",
      clientIp: "203.0.113.7",
      userAgent: "console/1.0",
      requestId: "req-begin",
    })
    expect(unattributed).toEqual([])
  })

  for (const [name, initiatedBy] of [
    ["no initiator (a row minted before migration 0050)", null],
    ["an initiator that does not parse", { actor: "ops@example.test", actorKind: "root" }],
  ] as const) {
    test(`a state row with ${name} still completes, recorded unattributed with one error line`, async () => {
      const { connected, unattributed } = await connectThroughCallback({ initiatedBy })

      expect(connected).toMatchObject({
        actor: "unknown",
        actorKind: "unattributed",
        actorSays: null,
        clientIp: null,
        requestId: null,
      })
      expect(unattributed).toHaveLength(1)
      expect(unattributed[0]).toMatchObject({ level: "error", kind: "account.connected" })
    })
  }
})
