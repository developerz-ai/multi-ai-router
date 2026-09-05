/**
 * What the `request failed` line carries. A `RouterError` renders its own status and code; the line
 * that records it must also say *why* — scrubbed — or a week of `translation_failed` lines says
 * nothing an operator can act on.
 */

import { describe, expect, test } from "bun:test"
import { AdminAuthError, TranslationError, UpstreamAuthError } from "@multi-ai-router/core"
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
})
