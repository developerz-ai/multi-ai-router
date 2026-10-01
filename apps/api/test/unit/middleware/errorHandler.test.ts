/**
 * What the `request failed` line carries. A `RouterError` renders its own status and code; the line
 * that records it must also say *why* — scrubbed — or a week of `translation_failed` lines says
 * nothing an operator can act on.
 */

import { describe, expect, test } from "bun:test"
import {
  AdminAuthError,
  InvalidRequestError,
  TranslationError,
  UnsupportedContentEncodingError,
  UpstreamAuthError,
} from "@multi-ai-router/core"
import { Hono } from "hono"
import { createLogger } from "../../../src/logging/logger"
import { errorHandler } from "../../../src/middleware/errorHandler"
import type { AppEnv } from "../../../src/types"

function app(thrown: () => Error) {
  const lines: Record<string, unknown>[] = []
  const log = createLogger({
    level: "debug",
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  })
  const hono = new Hono<AppEnv>()
  hono.onError(errorHandler(log))
  hono.post("/v1/messages", () => {
    throw thrown()
  })
  return { hono, lines }
}

describe("the request-failed line", () => {
  test("a translation refusal names the field it refused", async () => {
    const { hono, lines } = app(
      () => new TranslationError("not a valid anthropic request: `messages.0.content` — bad"),
    )

    const res = await hono.request("/v1/messages", { method: "POST" })

    expect(res.status).toBe(400)
    const line = lines.find((entry) => entry.msg === "request failed")
    expect(line?.errorCode).toBe("translation_failed")
    expect(line?.error).toContain("messages.0.content")
    expect(line?.level).toBe("warn")
  })

  test("the cause chain reaches the line, scrubbed of credential material", async () => {
    const { hono, lines } = app(
      () =>
        new UpstreamAuthError("upstream rejected the account's credential", {
          cause: new Error("401 for Bearer sk-live-abcdefghijklmnopqrstuvwxyz at api.test"),
        }),
    )

    await hono.request("/v1/messages", { method: "POST" })

    const line = lines.find((entry) => entry.msg === "request failed")
    expect(String(line?.error)).toContain("api.test")
    expect(JSON.stringify(line)).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz")
  })

  test("an admin refusal still carries its operator-only kind beside the message", async () => {
    const { hono, lines } = app(
      () => new AdminAuthError("authentication failed", { reason: "session-expired" }),
    )

    await hono.request("/v1/messages", { method: "POST" })

    const line = lines.find((entry) => entry.msg === "request failed")
    expect(line?.reason).toBe("session-expired")
    expect(line?.error).toContain("authentication failed")
  })

  test("it says what the request carried, so an empty body is told from a compressed one", async () => {
    const { hono, lines } = app(() => new InvalidRequestError("The request body is empty"))

    await hono.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "0",
        "user-agent": "fleet-agent/1.2",
        "x-session-id": "ses_abc",
      },
    })

    const line = lines.find((entry) => entry.msg === "request failed")
    expect(line).toMatchObject({
      status: 400,
      errorClass: "InvalidRequestError",
      errorCode: "invalid_request",
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": "0",
      "user-agent": "fleet-agent/1.2",
      "x-session-id": "ses_abc",
    })
  })

  test("a credential header never reaches the line, whatever else the request carried", async () => {
    const { hono, lines } = app(() => new InvalidRequestError("The request body is empty"))

    await hono.request("/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer mar_live_secretsecretsecret",
        "x-api-key": "sk-secret-value",
        cookie: "session=secret-cookie",
        "user-agent": "fleet-agent/1.2",
      },
    })

    const line = lines.find((entry) => entry.msg === "request failed")
    expect(line).not.toHaveProperty("authorization")
    expect(line).not.toHaveProperty("x-api-key")
    expect(line).not.toHaveProperty("cookie")
    expect(JSON.stringify(line)).not.toContain("secret")
  })

  test("an unclassified throw carries the same request context", async () => {
    const { hono, lines } = app(() => new Error("boom"))

    const res = await hono.request("/v1/messages", {
      method: "POST",
      headers: { authorization: "Bearer mar_live_secretsecretsecret", "user-agent": "curl/8" },
    })

    expect(res.status).toBe(500)
    const line = lines.find((entry) => entry.msg === "request failed")
    expect(line).toMatchObject({ "user-agent": "curl/8", level: "error" })
    expect(line).not.toHaveProperty("authorization")
  })

  test("a hostile header value cannot become an unbounded log field", async () => {
    const { hono, lines } = app(() => new InvalidRequestError("The request body is empty"))

    await hono.request("/v1/messages", {
      method: "POST",
      headers: { "user-agent": "u".repeat(5_000) },
    })

    const line = lines.find((entry) => entry.msg === "request failed")
    expect(String(line?.["user-agent"]).length).toBe(200)
  })

  test("a compressed body renders 415 in both wire dialects' envelopes", async () => {
    const lines: Record<string, unknown>[] = []
    const log = createLogger({ level: "debug", write: (line) => void lines.push(JSON.parse(line)) })
    const hono = new Hono<AppEnv>()
    hono.onError(errorHandler(log))
    hono.post("/v1/*", () => {
      throw new UnsupportedContentEncodingError("Compressed request bodies are not supported")
    })

    const anthropic = await hono.request("/v1/messages", { method: "POST" })
    expect(anthropic.status).toBe(415)
    expect(await anthropic.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error", message: expect.stringContaining("Compressed") },
    })

    for (const path of ["/v1/chat/completions", "/v1/responses"]) {
      const openai = await hono.request(path, { method: "POST" })
      expect(openai.status).toBe(415)
      expect(await openai.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          code: "unsupported_content_encoding",
          param: null,
        },
      })
    }
  })
})
