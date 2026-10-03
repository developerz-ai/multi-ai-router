import { describe, expect, test } from "bun:test"
import { createLogger } from "../../src/logging/logger"
import { httpDriver } from "../../src/providers"
import { runAttempt } from "../../src/services/dataplane/attempt"
import { account, jsonResponse, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, MESSAGE, post, settle } from "./harness"

describe("upstream trust boundary", () => {
  for (const provider of ["anthropic-api", "openai-api"] as const) {
    test(`${provider} errors never expose the selected account credential`, async () => {
      const secret = "opaque-provider-credential-123456"
      const lines: string[] = []
      const log = createLogger({
        level: "debug",
        write: (line) => {
          lines.push(line)
        },
      })
      const { app } = harness({
        accounts: [account("a", { provider, apiKey: secret, cipher: CRYPTOR })],
        logger: log,
        responses: [
          () =>
            jsonResponse(400, {
              error: {
                message: `Rejected ${secret} and Bearer synthetic-token-123456`,
                type: "invalid_request_error",
                code: "bad_input",
              },
              diagnostic: { access_token: "another-opaque-secret" },
            }),
        ],
      })
      const response = await app.request("/v1/messages", post(MESSAGE, bearer()))
      expect(response.status).toBe(400)
      const body = await response.text()
      for (const text of [body, ...lines]) {
        expect(text).not.toContain(secret)
        expect(text).not.toContain("synthetic-token-123456")
        expect(text).not.toContain("another-opaque-secret")
      }
      expect(body).toContain("[REDACTED]")
    })
  }

  for (const format of ["json", "text", "numeric"] as const) {
    test(`redacts an echoed OAuth account-routing header from ${format} errors`, async () => {
      const accountId = format === "numeric" ? "123456789012" : "private-tenant-123456"
      const claims = Buffer.from(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
      ).toString("base64url")
      const token = `eyJhbGciOiJub25lIn0.${claims}.test-signature`
      const lines: string[] = []
      const { app, upstream } = harness({
        accounts: [
          {
            ...account("oauth", { provider: "openai-oauth", cipher: CRYPTOR }),
            authMaterial: CRYPTOR.encrypt(JSON.stringify({ accessToken: token })),
          },
        ],
        logger: createLogger({
          level: "debug",
          write: (line) => {
            lines.push(line)
          },
        }),
        responses: [
          () => {
            if (format === "numeric") {
              return jsonResponse(400, {
                error: { message: "Invalid account", reference: Number(accountId) },
              })
            }
            return format === "json"
              ? new Response(
                  JSON.stringify({
                    error: { message: `Rejected ${accountId}: ${token}`, code: "bad_input" },
                  }).replaceAll("private", "\\u0070rivate"),
                  { status: 400, headers: { "content-type": "application/json" } },
                )
              : new Response(`Rejected ${accountId}: ${token}`, { status: 400 })
          },
        ],
      })
      const response = await app.request(
        "/v1/responses",
        post(JSON.stringify({ model: "gpt-5", input: "hello" }), bearer()),
      )
      expect(response.status).toBe(400)
      expect(upstream.calls[0]?.headers.get("chatgpt-account-id")).toBe(accountId)
      const body = await response.text()
      expect(body).toContain("[REDACTED]")
      for (const output of [body, ...lines]) {
        expect(output).not.toContain(accountId)
        expect(output).not.toContain(token)
      }
    })
  }

  for (const status of [307, 308]) {
    test(`does not follow ${status} redirects or forward credentials to another origin`, async () => {
      let destinationCalls = 0
      const destination = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          destinationCalls += 1
          return new Response("unexpected")
        },
      })
      const origin = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          return new Response(null, { status, headers: { location: destination.url.toString() } })
        },
      })
      try {
        const driver = httpDriver("anthropic-api")
        if (driver === null) throw new Error("missing driver")
        const outcome = await runAttempt({
          plan: {
            account: account("a", { cipher: CRYPTOR }),
            driver,
            dialect: "anthropic",
            url: origin.url,
            upstreamModel: "claude-opus-5",
          },
          method: "POST",
          clientHeaders: new Headers(),
          body: new TextEncoder().encode(MESSAGE),
          fetch,
          cipher: CRYPTOR,
          timeoutMs: 1000,
        })
        expect(outcome.kind).toBe("failure")
        expect(destinationCalls).toBe(0)
      } finally {
        origin.stop(true)
        destination.stop(true)
      }
    })
  }

  test("cancels oversized failure bodies and retains no partial secret", async () => {
    let cancelled = false
    const { app } = harness({
      upstreamErrorMaxBytes: 64,
      responses: [
        () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode("opaque-secret".repeat(20)))
              },
              cancel() {
                cancelled = true
              },
            }),
            { status: 400 },
          ),
      ],
    })
    const response = await app.request("/v1/messages", post(MESSAGE, bearer()))
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain("opaque-secret")
    expect(cancelled).toBe(true)
  })

  test("applies a chained alias only once", async () => {
    const { app, upstream } = harness({
      accounts: [
        account("a", {
          cipher: CRYPTOR,
          modelAliases: { "claude-opus-5": "approved-model", "approved-model": "unapproved-model" },
        }),
      ],
      responses: [() => jsonResponse(200, { ok: true })],
    })
    const response = await app.request("/v1/messages", post(MESSAGE, bearer()))
    expect(response.status).toBe(200)
    expect(JSON.parse(upstream.calls[0]?.body ?? "{}").model).toBe("approved-model")
    await response.text()
  })

  test("records a broken response stream as failed without retrying", async () => {
    const stream = slowStream(["data: hello\n\n"])
    const { app, usage, upstream } = harness({ responses: [() => stream.response] })
    const response = await app.request("/v1/messages", post(MESSAGE, bearer()))
    const reader = response.body?.getReader()
    stream.release(0)
    expect((await reader?.read())?.done).toBe(false)
    stream.abort()
    await expect(reader?.read()).rejects.toThrow()
    await settle()
    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      outcome: "upstream_error",
      httpStatus: 200,
      streamed: true,
    })
  })

  test("client abort before response does not retry or strike account health", async () => {
    const abort = new AbortController()
    const { app, upstream, usage, health } = harness({
      responses: [
        () => {
          abort.abort()
          throw new DOMException("cancelled", "AbortError")
        },
      ],
    })
    const response = await app.request("/v1/messages", {
      ...post(MESSAGE, bearer()),
      signal: abort.signal,
    })
    expect(response.status).toBe(499)
    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows[0]?.outcome).toBe("client_error")
    expect(health.stateOf("acct-1").breaker.consecutiveFailures).toBe(0)
  })

  test("an already cancelled request never reaches the provider", async () => {
    const abort = new AbortController()
    abort.abort()
    const { app, upstream } = harness({ responses: [() => jsonResponse(200, {})] })
    const response = await app.request("/v1/messages", {
      ...post(MESSAGE, bearer()),
      signal: abort.signal,
    })
    expect(response.status).toBe(499)
    expect(upstream.calls).toHaveLength(0)
  })

  test("client abort after response is recorded without striking account health", async () => {
    const abort = new AbortController()
    const stream = slowStream(["data: hello\n\n"])
    const { app, usage, health } = harness({ responses: [() => stream.response] })
    const response = await app.request("/v1/messages", {
      ...post(MESSAGE, bearer()),
      signal: abort.signal,
    })
    const reader = response.body?.getReader()
    stream.release(0)
    await reader?.read()
    abort.abort()
    stream.abort()
    await expect(reader?.read()).rejects.toThrow()
    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "client_error", errorClass: "client_cancelled" })
    expect(health.stateOf("acct-1").breaker.consecutiveFailures).toBe(0)
  })

  test("cancelling a response reader without aborting its request does not strike health", async () => {
    const stream = slowStream(["data: hello\n\n"])
    const { app, usage, health } = harness({ responses: [() => stream.response] })
    const response = await app.request("/v1/messages", post(MESSAGE, bearer()))
    const reader = response.body?.getReader()
    stream.release(0)
    await reader?.read()
    await reader?.cancel()
    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "client_error", errorClass: "client_cancelled" })
    expect(health.stateOf("acct-1").breaker.consecutiveFailures).toBe(0)
  })
})
