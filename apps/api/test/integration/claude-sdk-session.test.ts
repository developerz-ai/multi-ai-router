import { describe, expect, test } from "bun:test"
import { createLogger, type Logger } from "../../src/logging/logger"
import { createSdkQuotaStore, createSessionStore, type SdkInvocation } from "../../src/providers"
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
// A real third turn carries the conversation forward; resending the second one byte-for-byte reads
// as a replay of a prompt the account already answered, and the lineage store starts it fresh.
const THIRD_TURN = messages([
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
  { role: "user", content: "and now?" },
  { role: "assistant", content: "hi again" },
  { role: "user", content: "one more" },
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

  test("`rebind` trades the prior turns for an answer now: the mapping drops and another account serves", async () => {
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

    const second = harness({
      accounts: [
        subscriptionAccount("sub", { snapshot: { status: "cooling_down" } }),
        account("api-1", { apiKey: "sk-one", cipher: CRYPTOR }),
      ],
      responses: [() => new Response('{"ok":true}', { status: 200 })],
      sessions: store,
      selection: { unpooledPolicy: "priority-failover", boundAccountCoolingDown: "rebind" },
    })
    const res = await second.app.request("/v1/messages", post(SECOND_TURN, headers))
    await res.text()
    await settle()

    // Served by the healthy account the cooling one's binding would otherwise have hidden.
    expect(res.status).toBe(200)
    // The restart is surfaced, never silent: prior upstream turns are gone and the client is told.
    expect(res.headers.get("x-router-session-restart")).toBe("cooling-down")
    // Dropped, never moved — same row shape an unrecoverable account leaves.
    const cleared = repository.writes.at(-1)
    expect(cleared?.accountId).toBeNull()
    expect(cleared?.sdkSessionId).toBeNull()
  })

  test("`rebind` with nowhere to rebind keeps the mapping and answers the 429 `fail` would", async () => {
    // The pool-wide cooldown case: one provider, windows depleting together. Dropping the binding
    // *before* knowing whether a replacement exists lost the conversation for a rebind that never
    // happened — the client's post-429 retry found the account healthy again but the session cold.
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
      accounts: [subscriptionAccount("sub", { snapshot: { status: "cooling_down" } })],
      responses: [],
      sessions: store,
      selection: { unpooledPolicy: "priority-failover", boundAccountCoolingDown: "rebind" },
    })
    const res = await second.app.request("/v1/messages", post(SECOND_TURN, headers))
    await res.text()
    await settle()

    expect(res.status).toBe(429)
    // The binding survives: no clearing write, the row still names its account and session.
    expect(repository.writes).toHaveLength(writesBefore)
    const rows = [...repository.rows.values()]
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

/** A logger whose lines a test reads back, exactly as they would be written. */
function capturedLogger(): { readonly log: Logger; readonly lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = []
  const log = createLogger({
    level: "warn",
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  })
  return { log, lines }
}

/**
 * The invoker a fleet of subscriptions answers with: every account reports its own session id, and
 * a script per account decides whether a given call succeeds or throws the SDK's prose.
 */
function fleet(
  seen: SdkInvocation[],
  script: (invocation: SdkInvocation, callsToThisAccount: number) => Response | Error,
) {
  const calls = new Map<string, number>()
  return async (invocation: SdkInvocation): Promise<Response> => {
    seen.push(invocation)
    const nth = (calls.get(invocation.accountId) ?? 0) + 1
    calls.set(invocation.accountId, nth)
    const outcome = script(invocation, nth)
    if (outcome instanceof Error) throw outcome
    invocation.onSession?.({
      sdkSessionId: `sess_${invocation.accountId}`,
      assistantUuid: `uuid-${nth}`,
    })
    return outcome
  }
}

const twoSubs = () => [
  subscriptionAccount("sub-a", { snapshot: { priority: 0 } }),
  subscriptionAccount("sub-b", { snapshot: { priority: 1 } }),
]

describe("a subscription whose login expired mid-chain", () => {
  test("the first request to land on it is served by the next subscription, not failed", async () => {
    const seen: SdkInvocation[] = []
    const { log, lines } = capturedLogger()
    const { app, health, usage } = harness({
      accounts: twoSubs(),
      responses: [],
      selection: { unpooledPolicy: "priority-failover" },
      logger: log,
      invokeSdk: fleet(seen, ({ accountId }) =>
        accountId === "sub-a"
          ? new Error("Failed to authenticate: OAuth session expired and could not be refreshed")
          : sdkResponse(),
      ),
    })

    const res = await app.request(
      "/v1/messages",
      post(OPENING, { ...bearer(), "x-session-id": "c1" }),
    )
    await res.text()
    await settle()

    // The client hears nothing of it: 200 from `sub-b`, no session restart — this session had no
    // binding to leave, so nothing moved.
    expect(res.status).toBe(200)
    expect(res.headers.get("x-router-session-restart")).toBeNull()
    expect(seen.map((call) => call.accountId)).toEqual(["sub-a", "sub-b"])
    // The rejected credential is the account's problem: parked for a human, out of routing.
    expect(health.stateOf("sub-a").breaker.status).toBe("needs_reauth")
    expect(health.stateOf("sub-b").breaker.status).toBe("active")
    // Both attempts are on the record, and the failed one is named for what it was.
    expect(usage.rows.map((row) => row.outcome)).toEqual(["upstream_auth_failed", "success"])
    const failed = lines.filter((line) => line.msg === "upstream attempt failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ accountId: "sub-a", attempt: 1, failureKind: "auth" })
    // The SDK's own words never reach a line unredacted-by-design: the router's sentence does.
    expect(failed[0]?.reason).toBe("the account's Claude subscription needs re-authenticating")
  })

  test("the next request never lands on the parked subscription at all", async () => {
    const seen: SdkInvocation[] = []
    const { app } = harness({
      accounts: twoSubs(),
      responses: [],
      selection: { unpooledPolicy: "priority-failover" },
      invokeSdk: fleet(seen, ({ accountId }) =>
        accountId === "sub-a" ? new Error("OAuth token has expired") : sdkResponse(),
      ),
    })

    await (await app.request("/v1/messages", post(OPENING, bearer()))).text()
    const second = await app.request("/v1/messages", post(OPENING, bearer()))
    await second.text()
    await settle()

    expect(second.status).toBe(200)
    expect(seen.map((call) => call.accountId)).toEqual(["sub-a", "sub-b", "sub-b"])
  })

  test("a bound conversation moves to the next subscription and is told it restarted", async () => {
    const seen: SdkInvocation[] = []
    const { repository, store } = sessionStore()
    const headers = { ...bearer(), "x-session-id": "conv-1" }
    const { app, health } = harness({
      accounts: twoSubs(),
      responses: [],
      selection: { unpooledPolicy: "priority-failover" },
      sessions: store,
      // `sub-a` serves the first turn, then its login has expired by the second.
      invokeSdk: fleet(seen, ({ accountId }, nth) =>
        accountId === "sub-a" && nth > 1 ? new Error("Not logged in") : sdkResponse(),
      ),
    })

    await (await app.request("/v1/messages", post(OPENING, headers))).text()
    await settle()
    const second = await app.request("/v1/messages", post(SECOND_TURN, headers))
    await second.text()
    await settle()

    expect(second.status).toBe(200)
    // A mid-chain hop off the bound account: surfaced, never silent.
    expect(second.headers.get("x-router-session-restart")).toBe("failover")
    expect(seen.map((call) => call.accountId)).toEqual(["sub-a", "sub-a", "sub-b"])
    expect(seen[2]?.session.kind).toBe("fresh")
    expect(health.stateOf("sub-a").breaker.status).toBe("needs_reauth")
    // Dropped-then-rebound through `sub-b`'s own `remember`, never migrated.
    expect([...repository.rows.values()][0]).toMatchObject({
      accountId: "sub-b",
      sdkSessionId: "sess_sub-b",
    })

    // The third turn resumes on `sub-b` as an ordinary bound session — no restart header now.
    const third = await app.request("/v1/messages", post(THIRD_TURN, headers))
    await third.text()
    expect(third.status).toBe(200)
    expect(third.headers.get("x-router-session-restart")).toBeNull()
    expect(seen[3]).toMatchObject({
      accountId: "sub-b",
      session: { kind: "resume", sdkSessionId: "sess_sub-b" },
    })
  })
})

describe("a bound subscription that runs out of quota", () => {
  const IN_AN_HOUR = NOW.getTime() + 3_600_000

  test("the turn is served by another subscription, the spent one cools down, and new sessions avoid it", async () => {
    const seen: SdkInvocation[] = []
    const { repository, store } = sessionStore()
    const conv1 = { ...bearer(), "x-session-id": "conv-1" }
    const { app, health } = harness({
      accounts: [...twoSubs(), subscriptionAccount("sub-c", { snapshot: { priority: 2 } })],
      responses: [],
      selection: { unpooledPolicy: "priority-failover" },
      sessions: store,
      sdkQuota: createSdkQuotaStore(),
      // Turn two on `sub-a`: the SDK reports the window as rejected, then the query fails.
      invokeSdk: fleet(seen, (invocation, nth) => {
        if (invocation.accountId !== "sub-a" || nth === 1) return sdkResponse()
        invocation.onRateLimit?.({
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: IN_AN_HOUR,
        })
        return new Error(`Claude AI usage limit reached|${IN_AN_HOUR}`)
      }),
    })

    await (await app.request("/v1/messages", post(OPENING, conv1))).text()
    await settle()
    expect(seen[0]?.accountId).toBe("sub-a")

    const second = await app.request("/v1/messages", post(SECOND_TURN, conv1))
    await second.text()
    await settle()

    // Not a 429: another subscription was eligible, and the client sees success.
    expect(second.status).toBe(200)
    expect(second.headers.get("x-router-session-restart")).toBe("failover")
    expect(seen.map((call) => call.accountId)).toEqual(["sub-a", "sub-a", "sub-b"])
    // `cooling_down`, with the reset the stream reported — never `exhausted`.
    const spent = health.stateOf("sub-a").breaker
    expect(spent.status).toBe("cooling_down")
    expect(spent.cooldownUntil?.getTime()).toBe(IN_AN_HOUR)
    // The conversation now lives on `sub-b`.
    expect([...repository.rows.values()][0]).toMatchObject({
      accountId: "sub-b",
      sdkSessionId: "sess_sub-b",
    })

    // A brand-new session never lands on the cooling account while others serve.
    const fresh = await app.request(
      "/v1/messages",
      post(OPENING, { ...bearer(), "x-session-id": "conv-2" }),
    )
    await fresh.text()
    expect(fresh.status).toBe(200)
    expect(seen.at(-1)?.accountId).toBe("sub-b")

    // And the moved conversation resumes where it now lives, with no further restart.
    const third = await app.request("/v1/messages", post(THIRD_TURN, conv1))
    await third.text()
    expect(third.status).toBe(200)
    expect(third.headers.get("x-router-session-restart")).toBeNull()
    expect(seen.at(-1)).toMatchObject({
      accountId: "sub-b",
      session: { kind: "resume", sdkSessionId: "sess_sub-b" },
    })
  })
})
