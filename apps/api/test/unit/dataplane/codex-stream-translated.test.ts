import { describe, expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { createActiveRequestRegistry } from "../../../src/services/dataplane/active-requests"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

/**
 * #188 in the production shape: a non-streamed Anthropic `/v1/messages` request, translated to
 * Responses for a Codex account, whose upstream stream ends in `response.failed` and closes. Codex
 * echoes instructions and tools into that frame, so a large prompt pushes it past the observation
 * cap and through the salvage scanner; these cases pin that the code survives it.
 */

const FAKE_KEY = "sk-LIVEFAKEKEY-do-not-leak-1234567890abcdef"
const REASON_MAX_CHARS = 50

const ACCESS_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } }),
).toString("base64url")}.sig`

async function translated(frame: unknown, health = createHealthStore({ jitter: () => 0 })) {
  const rows: UsageRecord[] = []
  const lines: Record<string, unknown>[] = []
  const log = createLogger({
    level: "info",
    write: (line) => {
      lines.push(JSON.parse(line))
    },
  }).child({ requestId: "req-translated" })
  const cryptor = cipher()
  const a = {
    ...account("a", { provider: "openai-oauth", cipher: cryptor }),
    authMaterial: cryptor.encrypt(JSON.stringify({ accessToken: ACCESS_TOKEN })),
  }
  const routing = catalog([a])
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
      prepare: () => ({
        designated: false,
        started: () => started,
        beforeUpstreamStart: () => {
          started = true
        },
        finish: () => {},
      }),
    },
    cipher: cryptor,
    health,
    activeRequests: createActiveRequestRegistry({ maximumEntries: 10 }),
    usage: {
      record: (row) => {
        rows.push(row)
      },
    },
    options: { log: { reasonMaxChars: REASON_MAX_CHARS } },
    fetch: async () =>
      new Response(`event: response.failed\ndata: ${JSON.stringify(frame)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
  })
  const response = await dispatcher.dispatch({
    ingress: "anthropic",
    requestId: crypto.randomUUID(),
    key: {
      id: "key",
      name: "translated-test",
      prefix: "translated-test",
      scope: { kind: "accounts", accountIds: ["a"] },
      rateLimitRequests: null,
      rateLimitWindowSeconds: null,
      expiresAt: null,
    },
    request: new Request("http://router.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-6.1-sol",
        max_tokens: 100,
        messages: [{ role: "user", content: "ping" }],
      }),
    }),
  })
  await response.text().catch(() => "")
  await Promise.resolve()
  expect(rows).toHaveLength(1)
  return { row: rows[0], lines, health }
}

function failed(error: Record<string, unknown>, echoed: Record<string, unknown> = {}) {
  return {
    type: "response.failed",
    response: { id: "resp_1", object: "response", status: "failed", error, ...echoed },
  }
}

const warnOf = (lines: readonly Record<string, unknown>[]) =>
  lines.filter((line) => line.msg === "upstream stream failure")

describe("in-stream Codex refusal on a translated, non-streamed /v1/messages", () => {
  test("three refusals leave the account active; one bounded warn line each; no key anywhere", async () => {
    const health = createHealthStore({ jitter: () => 0 })
    for (let i = 0; i < 3; i += 1) {
      const { row, lines } = await translated(
        failed({ code: "invalid_prompt", message: `reject: ${FAKE_KEY} ${"m".repeat(100)}` }),
        health,
      )
      expect(row?.errorClass).toBe("codex:stream-error:invalid_prompt")
      const warns = warnOf(lines)
      expect(warns).toHaveLength(1)
      const quoted = warns[0]?.upstreamMessage
      if (typeof quoted !== "string") throw new Error("the warn line carries no upstreamMessage")
      expect(quoted.length).toBeLessThanOrEqual(REASON_MAX_CHARS)
      expect(quoted).toEndWith("…")
      expect(JSON.stringify(lines)).not.toContain(FAKE_KEY)
      expect(JSON.stringify(row)).not.toContain("reject:")
    }
    expect(health.stateOf("a").breaker).toMatchObject({ status: "active", consecutiveFailures: 0 })
  })

  test("a frame past the observation cap (echoed instructions) still classifies by its code", async () => {
    const health = createHealthStore({ jitter: () => 0 })
    for (let i = 0; i < 3; i += 1) {
      const { row, lines } = await translated(
        failed({ code: "invalid_prompt", message: "reject" }, { instructions: "x".repeat(70_000) }),
        health,
      )
      expect(row?.errorClass).toBe("codex:stream-error:invalid_prompt")
      expect(warnOf(lines)[0]?.upstreamMessage).toBe("reject")
    }
    expect(health.stateOf("a").breaker).toMatchObject({ status: "active", consecutiveFailures: 0 })
  })

  test("an error too large to keep drops the code, never the failure: it fails closed", async () => {
    const { row, health } = await translated(
      failed(
        { code: "invalid_prompt", message: "m".repeat(40_000) },
        { instructions: "x".repeat(70_000) },
      ),
    )
    expect(row?.errorClass).toBe("codex:stream-error:other")
    expect(row?.outcome).not.toBe("success")
    expect(health.stateOf("a").breaker.consecutiveFailures).toBe(1)
  })

  test("a credential cut by the length bound is redacted first, so no fragment survives", async () => {
    // The cut keeps REASON_MAX_CHARS - 1 characters; this prefix puts the cut seven characters
    // into the key, shorter than any secret pattern needs to match on its own.
    const prefix = "r".repeat(REASON_MAX_CHARS - 9)
    const { lines } = await translated(
      failed({ code: "invalid_prompt", message: `${prefix} ${FAKE_KEY}` }),
    )
    expect(JSON.stringify(lines)).not.toContain("sk-LIVE")
  })
})

describe("a long access token straddling the cut", () => {
  test("a ~1.8 KB JWT that begins just before the cut is redacted whole", async () => {
    const segment = (bytes: number) => Buffer.from("x".repeat(bytes)).toString("base64url")
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${segment(1300)}.${segment(256)}`
    expect(jwt.length).toBeGreaterThan(1700)
    const { lines } = await translated(
      failed({ code: "invalid_prompt", message: `token rejected: ${jwt}` }),
    )
    const text = JSON.stringify(lines)
    expect(text).not.toContain("eyJhbGciOiJSUzI1NiJ9")
    expect(text).not.toContain(segment(1300).slice(0, 20))
  })
})
