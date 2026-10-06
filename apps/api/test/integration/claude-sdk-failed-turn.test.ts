import { describe, expect, test } from "bun:test"
import { parseEnv } from "../../src/config/env"
import { createLogger } from "../../src/logging/logger"
import {
  createSdkConcurrency,
  createSdkInvoker,
  type SdkInvocation,
  type SessionStore,
} from "../../src/providers"
import type {
  SessionCarrier,
  SessionCarryInput,
} from "../../src/providers/claude-sdk/session-carry"
import { sessionStoreFromEnv } from "../../src/services/dataplane"
import { memorySessions, sdkTurn } from "../unit/claude-sdk/fixtures"
import { subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, post, settle } from "./harness"

/**
 * A turn that fails before its first byte leaves the conversation's binding alone
 * (docs/idea/11-anthropic-agent-sdk.md §4), driven through the **real** invoker with `query()`
 * stubbed — because the bug lived there: the CLI names its session in `system`/`init` before it
 * learns the window is spent, and the invoker reports that session on its failure path.
 *
 * Production, 2026-10-06 23:15–23:17: each spent subscription the conversation failed over to took
 * the binding, recorded the unanswered message as seen, and pinned the session to itself (429
 * "session is bound to account …"); the turn that finally served saw a `replay` and started fresh,
 * with no carry and no line saying why.
 */

const ENV = parseEnv({
  DATABASE_URL: "postgres://router:router@postgres:5432/router",
  ADMIN_OIDC_ISSUER_URL: "https://sso.test",
  ADMIN_OIDC_CLIENT_ID: "multi-ai-router-test",
  ADMIN_OIDC_REDIRECT_URI: "https://router.test/api/admin/auth/oidc/callback",
  ADMIN_OIDC_ADMIN_EMAIL: "admin@test",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
})

const SPENT = "You've hit your weekly limit · resets Oct 8, 2pm (UTC)"

function body(stream: boolean, turns: readonly { role: string; content: string }[]): string {
  return JSON.stringify({ model: "claude-opus-5", max_tokens: 64, stream, messages: turns })
}

const OPENING = [{ role: "user", content: "hello" }]
const SECOND = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "user", content: "and now?" },
]

function assistant(uuid: string): Record<string, unknown> {
  return {
    type: "assistant",
    uuid,
    parent_tool_use_id: null,
    message: { role: "assistant", content: [] },
  }
}

/**
 * The real invoker over a scripted `query()`. A spent account answers the way the CLI does: `init`
 * naming a session, a synthetic assistant reply, then an error `result` — no stream event at all.
 */
function scriptedFleet(spent: ReadonlySet<string>) {
  const seen: SdkInvocation[] = []
  let current: SdkInvocation | undefined
  const real = createSdkInvoker({
    concurrency: createSdkConcurrency({ global: 4, perAccount: 1 }),
    resolveCli: () => ({ ok: true, source: "env_override", path: "/offline/claude", bytes: 1 }),
    runQuery: ({ prompt }) => {
      void (async () => {
        for await (const _ of prompt) {
        }
      })()
      const invocation = current
      const n = seen.length
      return {
        async *[Symbol.asyncIterator]() {
          if (invocation === undefined) return
          const plan = invocation.session
          const sessionId =
            plan.kind === "resume" ? plan.sdkSessionId : `sess_${invocation.accountId}_${n}`
          yield { type: "system", subtype: "init", session_id: sessionId }
          if (spent.has(invocation.accountId)) {
            yield assistant(`uuid-synthetic-${n}`)
            yield { type: "result", subtype: "success", is_error: true, result: SPENT }
            return
          }
          yield* sdkTurn({
            blocks: [
              [
                { type: "text", text: "" },
                { type: "text_delta", text: "hi" },
              ],
            ],
          })
          yield assistant(`uuid-${invocation.accountId}-${n}`)
          yield { type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } }
        },
      }
    },
  })
  return {
    seen,
    invoke: (invocation: SdkInvocation): Promise<Response> => {
      seen.push(invocation)
      current = invocation
      return real(invocation)
    },
  }
}

function carryingStore() {
  const calls: SessionCarryInput[] = []
  const carrier: SessionCarrier = {
    carry: (input) => {
      calls.push(input)
      return Promise.resolve({ carried: true, bytes: 1 })
    },
  }
  const lines: Record<string, unknown>[] = []
  const repository = memorySessions()
  const store = sessionStoreFromEnv({
    env: ENV,
    repository,
    logger: createLogger({ level: "info", write: (line) => lines.push(JSON.parse(line)) }),
    now: () => new Date("2026-01-01T12:00:00.000Z"),
    carrier,
  })
  return { store, repository, calls, lines }
}

function routerFor(store: SessionStore, spent: ReadonlySet<string>) {
  const fleet = scriptedFleet(spent)
  const { app } = harness({
    accounts: [
      subscriptionAccount("sub-a", { snapshot: { priority: 0 } }),
      subscriptionAccount("sub-b", { snapshot: { priority: 1 } }),
      subscriptionAccount("sub-c", { snapshot: { priority: 2 } }),
    ],
    responses: [],
    selection: { unpooledPolicy: "priority-failover" },
    sessions: store,
    invokeSdk: fleet.invoke,
  })
  return { app, seen: fleet.seen }
}

const messages = (lines: readonly Record<string, unknown>[], msg: string) =>
  lines.filter((line) => line.msg === msg)

for (const stream of [false, true]) {
  describe(`a spent window before the first byte (${stream ? "streaming" : "non-streaming"})`, () => {
    test("leaves the binding where the conversation was answered, and the retry carries from there", async () => {
      const { store, repository, calls, lines } = carryingStore()
      const headers = { ...bearer(), "x-session-id": "conv-1" }

      // Turn one, answered on sub-a.
      const first = routerFor(store, new Set())
      const answered = await first.app.request("/v1/messages", post(body(stream, OPENING), headers))
      await answered.text()
      await settle()
      expect(answered.status).toBe(200)
      const bound = { ...[...repository.rows.values()][0] }
      expect(bound).toMatchObject({ accountId: "sub-a", sdkSessionId: "sess_sub-a_1" })

      // Turn two: every subscription's window is spent. sub-a fails on its own session; sub-b
      // carries it, then fails too. Nothing answered, so nothing may move.
      const spentRouter = routerFor(store, new Set(["sub-a", "sub-b", "sub-c"]))
      const refused = await spentRouter.app.request(
        "/v1/messages",
        post(body(stream, SECOND), headers),
      )
      await refused.text()
      await settle()
      expect(refused.status).toBe(429)
      expect(spentRouter.seen.map((call) => call.accountId)).toEqual(["sub-a", "sub-b", "sub-c"])
      expect([...repository.rows.values()][0]).toMatchObject({
        accountId: "sub-a",
        sdkSessionId: "sess_sub-a_1",
        lineageState: bound.lineageState,
      })

      // The retry: sub-a still spent, sub-b has quota again. Carried from sub-a, forked at the
      // answer turn one recorded — not a fresh `replay`.
      const retryRouter = routerFor(store, new Set(["sub-a"]))
      const served = await retryRouter.app.request(
        "/v1/messages",
        post(body(stream, SECOND), headers),
      )
      await served.text()
      await settle()

      expect(served.status).toBe(200)
      expect(served.headers.get("x-router-session-restart")).toBeNull()
      expect(retryRouter.seen[1]).toMatchObject({
        accountId: "sub-b",
        session: {
          kind: "fork",
          sdkSessionId: "sess_sub-a_1",
          resumeSessionAt: "uuid-sub-a-1",
          carryFrom: "sub-a",
        },
      })
      expect(calls.at(-1)).toEqual({
        fromAccountId: "sub-a",
        toAccountId: "sub-b",
        sdkSessionId: "sess_sub-a_1",
      })
      expect(messages(lines, "session carried to another account").at(-1)).toMatchObject({
        fromAccountId: "sub-a",
        toAccountId: "sub-b",
      })
      expect(messages(lines, "bound session not carried; the turn starts fresh")).toEqual([])
      expect([...repository.rows.values()][0]).toMatchObject({ accountId: "sub-b" })
    })
  })
}
