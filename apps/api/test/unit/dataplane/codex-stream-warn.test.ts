import { describe, expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

const encoder = new TextEncoder()
const FAKE_KEY = "sk-LIVEFAKEKEY-do-not-leak-1234567890abcdef"

/**
 * End-to-end test for the Codex in-stream classification + the new settle-path warn line.
 *
 * Drives a single request through `createDispatcher` with a Codex account whose driver
 * has the real `openai-oauth` responseObservation, asserts the usage row carries the
 * bounded allowlisted signal (not the upstream message), asserts the new warn line carries
 * the redacted message, and asserts the redactor caught the fake key on every other line.
 */
async function codexFixture(health = createHealthStore({ jitter: () => 0 })) {
  let source: ReadableStreamDefaultController<Uint8Array> | undefined
  const rows: UsageRecord[] = []
  const lines: Record<string, unknown>[] = []
  const log = createLogger({
    level: "info",
    write: (line) => {
      lines.push(JSON.parse(line))
    },
  }).child({ requestId: "req-codex" })
  const registry = createActiveRequestRegistry({ maximumEntries: 10 })
  const requestAbort = new AbortController()
  const cryptor = cipher()
  // A valid access token carrying the `chatgpt_account_id` claim — what `requireChatGptAccountId`
  // reads to populate the required `chatgpt-account-id` header on every Codex request.
  const ACCESS_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } }),
  ).toString("base64url")}.sig`
  const a = {
    ...account("a", { provider: "openai-oauth", cipher: cryptor }),
    authMaterial: cryptor.encrypt(JSON.stringify({ accessToken: ACCESS_TOKEN })),
  }
  const routing = catalog([a])
  const finished: string[] = []
  let started = false
  const dispatcher = createDispatcher({
    logger: log,
    catalog: routing,
    recovery: {
      catalog: routing,
      retryAfterMs: 1000,
      quotaStaleAfterMs: 1000,
      currentSnapshot: () => routing.accounts()[0]?.snapshot,
      hint: () => {},
      forget: () => {},
      // Ordinary traffic, not a recovery probe: a failed probe re-cools on its first failure,
      // which would hide the three-in-a-row breaker behaviour these tests pin.
      prepare: () => ({
        designated: false,
        started: () => started,
        beforeUpstreamStart: () => {
          started = true
        },
        finish: (state) => {
          finished.push(state)
        },
      }),
    },
    cipher: cryptor,
    health,
    activeRequests: registry,
    usage: {
      record: (row) => {
        rows.push(row)
      },
    },
    options: { log: { reasonMaxChars: 200 } },
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const response = await dispatcher.dispatch({
    ingress: "openai-responses",
    requestId: crypto.randomUUID(),
    key: {
      id: "key",
      name: "codex-test",
      prefix: "codex-test",
      scope: { kind: "accounts", accountIds: ["a"] },
      rateLimitRequests: null,
      rateLimitWindowSeconds: null,
      expiresAt: null,
    },
    request: new Request("http://router.test/v1/responses", {
      method: "POST",
      signal: requestAbort.signal,
      body: JSON.stringify({ model: "gpt-6.1-sol", input: "ping" }),
    }),
  })
  if (source === undefined || response.body === null) throw new Error("missing stream")
  const reader = response.body.getReader()
  return { source, reader, response, rows, health, log, lines, registry, requestAbort, finished }
}

describe("codex in-stream refusal flows through the data plane", () => {
  test("a response.failed with invalid_prompt leaves the account active and logs a redacted warn line", async () => {
    const f = await codexFixture()
    // The upstream message carries a fake key. The new warn line will quote it; the redactor
    // scrubs it. The usage row never sees the message — it carries only the allowlisted signal.
    f.source.enqueue(
      encoder.encode(
        'data: {"type":"response.failed","response":{"error":{"code":"invalid_prompt","message":"reject: ' +
          FAKE_KEY +
          '"}}}\n\n',
      ),
    )
    const chunk = await f.reader.read()
    expect(new TextDecoder().decode(chunk.value)).toContain("response.failed")
    f.requestAbort.abort()
    await f.reader.read().catch(() => {})
    await Promise.resolve()
    expect(f.rows).toHaveLength(1)
    const row = f.rows[0]
    // The usage row's errorClass is the allowlisted signal; the fake key never reaches the row.
    expect(row).toMatchObject({
      errorClass: "codex:stream-error:invalid_prompt",
      httpStatus: 200,
    })
    expect(JSON.stringify(row)).not.toContain(FAKE_KEY)
    // The breaker was not struck: invalid-request is `client-error` and `breaker.ts` returns the
    // state unchanged, so the account stays active and `consecutiveFailures` stays 0.
    expect(f.health.stateOf("a").breaker.consecutiveFailures).toBe(0)
    // The new warn line carries the redacted bounded upstream message; no other log line does.
    const warns = f.lines.filter((l) => l.msg === "upstream stream failure")
    expect(warns).toHaveLength(1)
    const warn = warns[0]
    expect(warn).toMatchObject({
      level: "warn",
      accountId: "a",
      errorClass: "codex:stream-error:invalid_prompt",
    })
    const message = warn.upstreamMessage
    expect(typeof message).toBe("string")
    expect(message as string).not.toContain(FAKE_KEY)
    expect(message as string).toContain("reject:")
    expect((message as string).length).toBeLessThanOrEqual(200)
    // No other log line carries the fake key.
    for (const line of f.lines) {
      expect(JSON.stringify(line)).not.toContain(FAKE_KEY)
    }
  })

  test("an unknown code classifies server-error with the closed `other` signal and does not leak the message", async () => {
    const f = await codexFixture()
    f.source.enqueue(
      encoder.encode(
        'data: {"type":"response.failed","response":{"error":{"code":"some_made_up_code","message":"reject: ' +
          FAKE_KEY +
          '"}}}\n\n',
      ),
    )
    const chunk = await f.reader.read()
    expect(new TextDecoder().decode(chunk.value)).toContain("some_made_up_code")
    f.requestAbort.abort()
    await f.reader.read().catch(() => {})
    await Promise.resolve()
    expect(f.rows).toHaveLength(1)
    expect(f.rows[0]).toMatchObject({
      errorClass: "codex:stream-error:other",
      httpStatus: 200,
    })
    expect(JSON.stringify(f.rows[0])).not.toContain(FAKE_KEY)
    // The unknown code is server-error, so the breaker may trip (3-in-a-row would cool the
    // account). One strike is not enough.
    expect(f.health.stateOf("a").breaker.consecutiveFailures).toBe(1)
  })

  test("three request-shaped refusals in a row, in both wire shapes, leave the account active", async () => {
    const health = createHealthStore({ jitter: () => 0 })
    const frames = [
      '{"type":"response.failed","response":{"error":{"code":"invalid_prompt","message":"no"}}}',
      '{"type":"error","code":"invalid_request_error","message":"no"}',
      '{"type":"response.failed","response":{"error":{"code":"invalid_prompt","message":"no"}}}',
    ]
    const classes: unknown[] = []
    for (const frame of frames) {
      const rows = await refuse(health, frame)
      classes.push(rows[0]?.errorClass)
    }
    expect(classes).toEqual([
      "codex:stream-error:invalid_prompt",
      "codex:stream-error:invalid_request_error",
      "codex:stream-error:invalid_prompt",
    ])
    expect(health.stateOf("a").breaker).toMatchObject({ status: "active", consecutiveFailures: 0 })
  })

  test("three unknown-code stream errors in a row still cool the account (fail closed)", async () => {
    const health = createHealthStore({ jitter: () => 0 })
    for (const frame of [
      '{"type":"response.failed","response":{"error":{"code":"some_made_up_code","message":"no"}}}',
      '{"type":"error","message":"no code at all"}',
      '{"type":"response.failed","response":{"error":{"message":"no code either"}}}',
    ]) {
      const rows = await refuse(health, frame)
      expect(rows[0]?.errorClass).toBe("codex:stream-error:other")
    }
    expect(health.stateOf("a").breaker.status).toBe("cooling_down")
  })

  test("a long upstream message is bounded on the warn line and appears on no other line", async () => {
    const f = await codexFixture()
    const message = `reject: ${"x".repeat(1000)} ${FAKE_KEY}`
    f.source.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ type: "error", code: "invalid_prompt", message })}\n\n`,
      ),
    )
    await f.reader.read()
    f.requestAbort.abort()
    await f.reader.read().catch(() => {})
    await Promise.resolve()
    const warn = f.lines.find((l) => l.msg === "upstream stream failure")
    const quoted = warn?.upstreamMessage
    if (typeof quoted !== "string") throw new Error("the warn line carries no upstreamMessage")
    expect(quoted.length).toBeLessThanOrEqual(200)
    expect(quoted).toStartWith("reject: xxx")
    for (const line of f.lines) {
      if (line === warn) continue
      expect(JSON.stringify(line)).not.toContain("reject:")
    }
    expect(JSON.stringify(f.rows)).not.toContain("reject:")
  })
})

/** One request on `health` whose upstream stream carries `frame` and then settles. */
async function refuse(health: ReturnType<typeof createHealthStore>, frame: string) {
  const f = await codexFixture(health)
  f.source.enqueue(encoder.encode(`data: ${frame}\n\n`))
  await f.reader.read()
  f.requestAbort.abort()
  await f.reader.read().catch(() => {})
  await Promise.resolve()
  expect(f.rows).toHaveLength(1)
  return f.rows
}
