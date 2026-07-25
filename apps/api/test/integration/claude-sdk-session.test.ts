import { describe, expect, test } from "bun:test"
import { createSessionStore, type SdkInvocation } from "../../src/providers"
import { memorySessions } from "../unit/claude-sdk/fixtures"
import { account, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * Sticky routing as **correctness**, end to end (docs/idea/11-anthropic-agent-sdk.md §4).
 *
 * An SDK session id is resumable only on the Account that created it, so a bound session is not a
 * cache-warmth preference a policy may overrule — it is a fact about where the conversation
 * physically lives upstream. These assert the whole loop: the first turn binds, the second resumes
 * on the same Account even against a policy that would prefer another, and an Account that can no
 * longer serve invalidates the mapping rather than carrying it somewhere it means nothing.
 */

const NOW = new Date("2026-01-01T12:00:00.000Z")

function messages(turns: readonly { role: string; content: string }[]): string {
  return JSON.stringify({ model: "claude-opus-5", max_tokens: 64, messages: turns })
}

const OPENING = messages([{ role: "user", content: "hello" }])
const SECOND_TURN = messages([
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "user", content: "and now?" },
])

function sdkResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

/** An invoker that reports a session id per Account, the way `system`/`init` does. */
function sdkWithSessions(seen: SdkInvocation[]) {
  return async (invocation: SdkInvocation): Promise<Response> => {
    seen.push(invocation)
    invocation.onSession?.({
      sdkSessionId: `sess_${invocation.accountId}`,
      assistantUuid: "uuid-1",
    })
    return sdkResponse()
  }
}

function sessionStore() {
  const repository = memorySessions()
  return { repository, store: createSessionStore({ repository, now: () => NOW }) }
}

describe("a Claude subscription conversation across turns", () => {
  test("the second turn resumes the session the first one created", async () => {
    const seen: SdkInvocation[] = []
    const { store } = sessionStore()
    const { app } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [],
      invokeSdk: sdkWithSessions(seen),
      sessions: store,
    })

    const headers = { ...bearer(), "x-session-id": "conv-1" }
    await (await app.request("/v1/messages", post(OPENING, headers))).text()
    await settle()
    await (await app.request("/v1/messages", post(SECOND_TURN, headers))).text()
    await settle()

    expect(seen).toHaveLength(2)
    expect(seen[0]?.session).toEqual({ kind: "fresh", reason: "no-session" })
    expect(seen[1]?.session).toMatchObject({ kind: "resume", sdkSessionId: "sess_sub" })
  })

  test("the binding pins the conversation to its account, whatever the policy would prefer", async () => {
    const seen: SdkInvocation[] = []
    const { store } = sessionStore()
    const accounts = [
      subscriptionAccount("sub-a", { snapshot: { priority: 1 } }),
      subscriptionAccount("sub-b", { snapshot: { priority: 0 } }),
    ]

    // First turn under a policy that heads at `sub-a`; the second under one that heads at `sub-b`.
    const first = harness({
      accounts,
      responses: [],
      invokeSdk: sdkWithSessions(seen),
      sessions: store,
      selection: { unpooledPolicy: "least-used" },
    })
    const headers = { ...bearer(), "x-session-id": "conv-1" }
    first.health.beginAttempt("sub-b")
    await (await first.app.request("/v1/messages", post(OPENING, headers))).text()
    await settle()

    const bound = seen[0]?.accountId
    const second = harness({
      accounts,
      responses: [],
      invokeSdk: sdkWithSessions(seen),
      sessions: store,
      selection: { unpooledPolicy: "priority-failover" },
    })
    await (await second.app.request("/v1/messages", post(SECOND_TURN, headers))).text()
    await settle()

    expect(bound).toBe("sub-a")
    // `priority-failover` would head at `sub-b`. The binding outranks it.
    expect(seen[1]?.accountId).toBe("sub-a")
    expect(seen[1]?.session).toMatchObject({ kind: "resume", sdkSessionId: "sess_sub-a" })
  })

  test("a headerless client is bound by its fingerprint, not by luck", async () => {
    const seen: SdkInvocation[] = []
    const { repository, store } = sessionStore()
    const { app } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [],
      invokeSdk: sdkWithSessions(seen),
      sessions: store,
    })

    await (await app.request("/v1/messages", post(OPENING, bearer()))).text()
    await settle()
    await (await app.request("/v1/messages", post(SECOND_TURN, bearer()))).text()
    await settle()

    expect(seen[1]?.session).toMatchObject({ kind: "resume", sdkSessionId: "sess_sub" })
    expect(repository.writes[0]?.fingerprintSource).toBe("fingerprint")
  })

  test("a bound account that can no longer serve drops the mapping rather than carrying it", async () => {
    const seen: SdkInvocation[] = []
    const { repository, store } = sessionStore()
    const accounts = [
      subscriptionAccount("sub"),
      account("api-1", { apiKey: "sk-one", cipher: CRYPTOR }),
    ]
    const headers = { ...bearer(), "x-session-id": "conv-1" }

    const first = harness({
      accounts,
      responses: [],
      invokeSdk: sdkWithSessions(seen),
      sessions: store,
      selection: { unpooledPolicy: "priority-failover" },
    })
    await (await first.app.request("/v1/messages", post(OPENING, headers))).text()
    await settle()

    // The subscription needs a human, not a clock: no reset returns it, so the mapping is dropped
    // rather than kept the way a `cooling_down` one would be.
    const second = harness({
      accounts: [
        subscriptionAccount("sub", { snapshot: { status: "needs_reauth" } }),
        account("api-1", { apiKey: "sk-one", cipher: CRYPTOR }),
      ],
      responses: [() => new Response('{"ok":true}', { status: 200 })],
      sessions: store,
      selection: { unpooledPolicy: "priority-failover" },
    })
    const res = await second.app.request("/v1/messages", post(SECOND_TURN, headers))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    // Dropped, never moved: the row names no account rather than the one that just served.
    const cleared = repository.writes.at(-1)
    expect(cleared?.accountId).toBeNull()
    expect(cleared?.sdkSessionId).toBeNull()
  })

  test("a bound account that is merely cooling down keeps the mapping and answers 429", async () => {
    const seen: SdkInvocation[] = []
    const { repository, store } = sessionStore()
    const headers = { ...bearer(), "x-session-id": "conv-1" }

    const first = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [],
      invokeSdk: sdkWithSessions(seen),
      sessions: store,
    })
    await (await first.app.request("/v1/messages", post(OPENING, headers))).text()
    await settle()
    const writesBefore = repository.writes.length

    const second = harness({
      accounts: [
        subscriptionAccount("sub", { snapshot: { status: "cooling_down" } }),
        account("api-1", { apiKey: "sk-one", cipher: CRYPTOR }),
      ],
      responses: [() => new Response('{"ok":true}', { status: 200 })],
      sessions: store,
      selection: { unpooledPolicy: "priority-failover" },
    })
    const res = await second.app.request("/v1/messages", post(SECOND_TURN, headers))
    await res.text()
    await settle()

    // The honest 429 keeps the conversation resumable; serving it elsewhere would not.
    expect(res.status).toBe(429)
    expect(repository.writes).toHaveLength(writesBefore)
    const rows = [...repository.rows.values()]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ accountId: "sub", sdkSessionId: "sess_sub" })
  })

  test("a router with no session store still serves subscriptions, just always cold", async () => {
    const seen: SdkInvocation[] = []
    const { app } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [],
      invokeSdk: sdkWithSessions(seen),
    })

    const headers = { ...bearer(), "x-session-id": "conv-1" }
    await (await app.request("/v1/messages", post(OPENING, headers))).text()
    await settle()
    const res = await app.request("/v1/messages", post(SECOND_TURN, headers))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(seen.every((call) => call.session.kind === "fresh")).toBe(true)
  })
})
