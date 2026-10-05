import { expect, test } from "bun:test"
import { createSessionStore, type SdkInvocation } from "../../src/providers"
import { memorySessions } from "../unit/claude-sdk/fixtures"
import { account, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

function response(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_offline",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 7, output_tokens: 3 },
    }),
    { headers: { "content-type": "application/json" } },
  )
}

function subscriptionHarness() {
  const repository = memorySessions(),
    seen: SdkInvocation[] = []
  const h = harness({
    accounts: [subscriptionAccount("sub")],
    responses: [],
    sessions: createSessionStore({ repository, now: () => new Date("2026-01-01T12:00:00Z") }),
    invokeSdk: async (invocation) => {
      invocation.onUpstreamStarted?.()
      seen.push(invocation)
      invocation.onSession?.({ sdkSessionId: "offline_session", assistantUuid: "offline_uuid" })
      return response()
    },
  })
  return { ...h, repository, seen }
}

function messages(turns: readonly { role: string; content: string }[]) {
  return JSON.stringify({ model: "claude-opus-5", messages: turns })
}

async function consume(
  h: ReturnType<typeof harness>,
  body: string,
  path = "/v1/messages",
  headers: Record<string, string> = {},
) {
  const response = await h.app.request(path, post(body, { ...bearer(), ...headers }))
  await response.text()
  await settle()
  return response.status
}

test("appended user turns preserve one opening binding and resume without another indexed read", async () => {
  const h = subscriptionHarness(),
    opening = { role: "user", content: "hello" }
  expect(await consume(h, messages([opening]))).toBe(200)
  expect(
    await consume(
      h,
      messages([opening, { role: "assistant", content: "hi" }, { role: "user", content: "next" }]),
    ),
  ).toBe(200)
  expect(h.seen[1]?.session).toMatchObject({
    kind: "resume",
    sdkSessionId: "offline_session",
    lineage: "continuation",
    // Past the echoed "hi": the session already holds its own answer.
    deltaFrom: 2,
  })
  expect(h.repository.reads).toBe(1)
  expect(h.repository.writes.length).toBe(2)
  expect(new Set(h.repository.writes.map((row) => row.key)).size).toBe(1)
  expect(h.repository.rows.size).toBe(1)
})

test("distinct Responses input strings create distinct opening bindings", async () => {
  const h = subscriptionHarness()
  for (const input of ["hello", "goodbye"])
    expect(
      await consume(h, JSON.stringify({ model: "claude-opus-5", input }), "/v1/responses"),
    ).toBe(200)
  expect(h.repository.reads).toBe(2)
  expect(h.repository.rows.size).toBe(2)
  expect(new Set(h.repository.writes.map((row) => row.key)).size).toBe(2)
  expect(h.seen.map((invocation) => invocation.session)).toEqual([
    { kind: "fresh", reason: "no-session" },
    { kind: "fresh", reason: "no-session" },
  ])
})

test("no-user requests have fresh identities and bypass all persistent binding access", async () => {
  const h = subscriptionHarness(),
    body = messages([{ role: "assistant", content: "hi" }])
  for (let i = 0; i < 3; i++) expect(await consume(h, body)).toBe(200)
  expect(h.repository.reads).toBe(0)
  expect(h.repository.writes.length).toBe(0)
  expect(h.repository.rows.size).toBe(0)
  expect(new Set(h.usage.rows.map((row) => row.sessionKey)).size).toBe(3)
  for (const invocation of h.seen)
    expect(invocation.session).toEqual({ kind: "fresh", reason: "no-session" })
})

test("an explicit session header remains authoritative even without an opening user", async () => {
  const h = subscriptionHarness()
  for (let i = 0; i < 3; i++) {
    const turns = Array.from({ length: i + 1 }, (_, turn) => ({
      role: "assistant",
      content: turn === 0 ? "hi" : `more ${turn}`,
    }))
    expect(
      await consume(h, messages(turns), "/v1/messages", { "x-session-id": "explicit-no-user" }),
    ).toBe(200)
  }
  expect(h.repository.reads).toBe(1)
  expect(h.repository.writes.length).toBe(3)
  expect(h.repository.rows.size).toBe(1)
  expect(h.repository.writes.every((row) => row.key === "explicit-no-user")).toBe(true)
  expect(h.seen[1]?.session).toMatchObject({ kind: "resume", deltaFrom: 1 })
  expect(h.seen[2]?.session).toMatchObject({ kind: "resume", deltaFrom: 2 })
})

test("a decoded duplicate model after the opening cap is refused before HTTP or SDK start", async () => {
  for (const sdk of [false, true]) {
    let starts = 0
    const h = harness({
      accounts: [sdk ? subscriptionAccount("sub") : account("http", { cipher: CRYPTOR })],
      responses: [response],
      invokeSdk: async (invocation) => {
        starts++
        invocation.onUpstreamStarted?.()
        return response()
      },
    })
    const body =
      '{"model":"claude-opus-5","messages":[{"role":"user","content":"' +
      "x".repeat(1300) +
      '"}],"mo\\u0064el":"other"}'
    expect(await consume(h, body)).toBe(400)
    expect(starts).toBe(0)
    expect(h.upstream.calls.length).toBe(0)
    expect(h.usage.rows[0]?.accountId).toBeNull()
  }
})

test("escaped routing keys and models select the decoded alias and preserve opaque wire bytes", async () => {
  const h = harness({
    accounts: [
      account("aliased", { cipher: CRYPTOR, modelAliases: { "claude-sonnet": "upstream-alias" } }),
    ],
    responses: [response],
  })
  const body = String.raw`{"mo\u0064el":"claude\u002dsonnet","messages":[{"role":"user","content":"opaque hi"}],"extra":{"model":"nested","bytes":"unchanged"}}`
  expect(await consume(h, body)).toBe(200)
  expect(h.upstream.calls.length).toBe(1)
  const outbound = h.upstream.calls[0]?.body
  expect(outbound).toBe(body.replace(String.raw`claude\u002dsonnet`, "upstream-alias"))
  expect(JSON.parse(outbound ?? "null").model).toBe("upstream-alias")
  expect(h.usage.rows[0]?.model).toBe("claude-sonnet")
  expect(h.usage.rows[0]?.accountId).toBe("aliased")
})
