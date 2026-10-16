/**
 * `runAttempt` surfacing a non-JSON upstream error body (`services/dataplane/attempt.ts`).
 *
 * Prod, b956ad43 (qwen3.8-max): four `400`s carried no `upstreamMessage`. The upstream (or a gateway
 * in front of it) answered plain text, but `attempt.ts` handed the driver `parseJson(body)` which
 * returned `undefined` for anything non-JSON, so the classifier — which already accepts a raw string
 * (`providers/failure/error-body.ts`) — saw nothing and fell back to status only. The body is read
 * only on the failure path and is already `sanitizeErrorBody`-scrubbed, so carrying the string adds
 * no credential exposure; the redactor guarantee is asserted here alongside the message.
 */
import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { runAttempt } from "../../../src/services/dataplane/attempt"
import { account, cipher } from "./fixtures"

const SECRET = "sk-LIVEFAKEKEY-do-not-leak-0123456789abcdef"

function openAiCompatible() {
  const driver = httpDriver("openai-compatible")
  if (driver == null) throw new Error("missing openai-compatible driver")
  return driver
}

async function attempt(body: string, contentType: string, status = 400) {
  const cryptor = cipher()
  return runAttempt({
    plan: {
      account: account("b956ad43", {
        provider: "openai-compatible",
        apiKey: SECRET,
        cipher: cryptor,
      }),
      driver: openAiCompatible(),
      dialect: "openai-chat",
      url: new URL("https://upstream.test/v1/chat/completions"),
      upstreamModel: "qwen3.8-max",
    },
    method: "POST",
    clientHeaders: new Headers(),
    body: null,
    timeoutMs: 1000,
    cipher: { decrypt: (value) => cryptor.decrypt(value) },
    fetch: async () => new Response(body, { status, headers: { "content-type": contentType } }),
  })
}

describe("a plain-text upstream error body", () => {
  // Failure case first: before the fix this message was dropped and the row had no upstreamMessage.
  test("surfaces as the classification message", async () => {
    const outcome = await attempt(
      "The tool_choice parameter does not support being set to required or object in thinking mode",
      "text/plain",
    )
    if (outcome.kind !== "failure") throw new Error(`expected failure, got ${outcome.kind}`)
    expect(outcome.classification?.message).toBe(
      "The tool_choice parameter does not support being set to required or object in thinking mode",
    )
    expect(outcome.upstream?.bodyText).toContain("tool_choice parameter does not support")
  })

  test("an HTML gateway body is carried too", async () => {
    const outcome = await attempt("<html><body>502 Bad Gateway</body></html>", "text/html", 502)
    if (outcome.kind !== "failure") throw new Error("expected failure")
    expect(outcome.classification?.message).toContain("502 Bad Gateway")
  })

  test("an empty body still yields no message, not an empty-string one", async () => {
    const outcome = await attempt("", "text/plain")
    if (outcome.kind !== "failure") throw new Error("expected failure")
    expect(outcome.classification?.message).toBeUndefined()
  })

  test("a JSON error body is still parsed into structured facts", async () => {
    const outcome = await attempt(
      JSON.stringify({ error: { message: "insufficient quota", type: "invalid_request_error" } }),
      "application/json",
    )
    if (outcome.kind !== "failure") throw new Error("expected failure")
    expect(outcome.classification?.message).toBe("insufficient quota")
  })

  test("a credential echoed in a plain-text body is redacted in message and bodyText", async () => {
    const outcome = await attempt(`forbidden for key ${SECRET}`, "text/plain", 403)
    if (outcome.kind !== "failure") throw new Error("expected failure")
    const serialized = JSON.stringify(outcome.classification) + (outcome.upstream?.bodyText ?? "")
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain("sk-LIVE")
  })
})
