import { describe, expect, test } from "bun:test"
import { miniMaxDriver } from "../../../../src/providers/drivers/minimax"
import { openAiOAuthDriver } from "../../../../src/providers/drivers/openai-oauth"
import { createRelayTerminal } from "../../../../src/services/dataplane/relay-terminal"
import { createResponseObserver } from "../../../../src/services/usage/response-observer"

const encoder = new TextEncoder()

function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function codexObserver() {
  return createResponseObserver({
    dialect: "openai-responses",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: 1024,
    descriptor: openAiOAuthDriver.responseObservation,
  })
}

function hooklessObserver() {
  return createResponseObserver({
    dialect: "openai-responses",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: 1024,
  })
}

describe("response observer under the codex stream-error hook", () => {
  test("a response.failed with code invalid_prompt classifies invalid-request", () => {
    const observer = codexObserver()
    observer.observe(
      encoder.encode(
        frame({
          type: "response.failed",
          response: { error: { code: "invalid_prompt", message: "fixture failure" } },
        }),
      ),
    )
    const facts = observer.finish()
    expect(facts.terminal).toBe("explicit_error")
    expect(facts.failure?.kind).toBe("invalid-request")
    expect(facts.failure?.signal).toBe("codex:stream-error:invalid_prompt")
    expect(facts.failure?.retryable).toBe(false)
    expect(facts.failure?.rateLimit).toBeNull()
  })

  test("a bare error event with top-level code invalid_request_error classifies invalid-request", () => {
    const observer = codexObserver()
    observer.observe(
      encoder.encode(
        frame({ type: "error", code: "invalid_request_error", message: "fixture failure" }),
      ),
    )
    const facts = observer.finish()
    expect(facts.terminal).toBe("explicit_error")
    expect(facts.failure?.kind).toBe("invalid-request")
    expect(facts.failure?.signal).toBe("codex:stream-error:invalid_request_error")
  })

  test("an unknown code classifies server-error with the closed `other` signal", () => {
    const observer = codexObserver()
    observer.observe(
      encoder.encode(frame({ type: "error", code: "made_up", message: "fixture failure" })),
    )
    const facts = observer.finish()
    expect(facts.terminal).toBe("explicit_error")
    expect(facts.failure?.kind).toBe("server-error")
    expect(facts.failure?.signal).toBe("codex:stream-error:other")
  })

  test("a missing code classifies server-error with the closed `other` signal", () => {
    const observer = codexObserver()
    observer.observe(encoder.encode(frame({ type: "error", message: "fixture failure" })))
    const facts = observer.finish()
    expect(facts.terminal).toBe("explicit_error")
    expect(facts.failure?.kind).toBe("server-error")
    expect(facts.failure?.signal).toBe("codex:stream-error:other")
  })

  test("in-stream rate_limit_exceeded classifies rate-limited", () => {
    const observer = codexObserver()
    observer.observe(
      encoder.encode(
        frame({
          type: "response.failed",
          response: { error: { code: "rate_limit_exceeded" } },
        }),
      ),
    )
    const facts = observer.finish()
    expect(facts.failure?.kind).toBe("rate-limited")
    expect(facts.failure?.signal).toBe("codex:stream-error:rate_limit_exceeded")
  })

  test("in-stream account_deactivated classifies credits-exhausted", () => {
    const observer = codexObserver()
    observer.observe(
      encoder.encode(
        frame({
          type: "response.failed",
          response: { error: { code: "account_deactivated" } },
        }),
      ),
    )
    const facts = observer.finish()
    expect(facts.failure?.kind).toBe("credits-exhausted")
    expect(facts.failure?.signal).toBe("codex:stream-error:account_deactivated")
  })

  test("relay-terminal records the hook's signal as errorClass when the hook answered", () => {
    const observer = codexObserver()
    observer.observe(
      encoder.encode(
        frame({
          type: "response.failed",
          response: { error: { code: "invalid_prompt", message: "fixture failure" } },
        }),
      ),
    )
    const terminal = createRelayTerminal()
    terminal.observe(observer.finish())
    const verdict = terminal.finish(observer.finish())
    expect(verdict.errorClass).toBe("codex:stream-error:invalid_prompt")
    expect(verdict.failure?.kind).toBe("client-error")
  })

  test("a hookless driver still records upstream_protocol_error exactly as today", () => {
    const observer = hooklessObserver()
    observer.observe(
      encoder.encode(
        frame({
          type: "response.failed",
          response: { error: { code: "invalid_prompt", message: "fixture failure" } },
        }),
      ),
    )
    const terminal = createRelayTerminal()
    terminal.observe(observer.finish())
    const verdict = terminal.finish(observer.finish())
    expect(verdict.errorClass).toBe("upstream_protocol_error")
  })

  test("the codex hook never stores a provider message on facts.failure (redaction-safe)", () => {
    // The hook's `message` is logged, not stored on the usage row. `facts.failure` carries only the
    // bounded allowlisted signal, so a row that read this fact would never see the message.
    const observer = codexObserver()
    observer.observe(
      encoder.encode(
        frame({
          type: "error",
          code: "invalid_prompt",
          message: "do not persist this",
        }),
      ),
    )
    const facts = observer.finish()
    const row = JSON.stringify(facts.failure)
    expect(row).not.toContain("do not persist this")
    expect(facts.failure?.signal).toBe("codex:stream-error:invalid_prompt")
  })
})

describe("minimax closed base_resp signal stays bounded under the generic rule", () => {
  test("a MiniMax 1008 still classifies credits-exhausted with the closed base_resp-1008 signal", () => {
    const observer = createResponseObserver({
      dialect: "anthropic",
      operation: "messages",
      contentType: "application/json",
      maximumObservationBytes: 1024,
      descriptor: miniMaxDriver.responseObservation,
    })
    observer.observe(
      encoder.encode(JSON.stringify({ base_resp: { status_code: 1008, status_msg: "x" } })),
    )
    const facts = observer.finish()
    expect(facts.failure?.kind).toBe("credits-exhausted")
    expect(facts.failure?.signal).toBe("minimax:base_resp-1008")
  })
})

describe("a MiniMax in-body failure past the observation cap (#206)", () => {
  test.each([
    [
      "before the padding",
      (pad: string) => ({ base_resp: { status_code: 1008, status_msg: "x" }, content: pad }),
    ],
    [
      "after the padding",
      (pad: string) => ({ content: pad, base_resp: { status_code: 1008, status_msg: "x" } }),
    ],
    [
      "with a status_msg too large to keep (#207 review)",
      (pad: string) => ({
        content: pad,
        base_resp: { status_code: 1008, status_msg: "m".repeat(400) },
      }),
    ],
  ])("base_resp %s keeps its code through salvage", (_label, body) => {
    const observer = createResponseObserver({
      dialect: "anthropic",
      operation: "messages",
      contentType: "application/json",
      maximumObservationBytes: 1024,
      descriptor: miniMaxDriver.responseObservation,
    })
    observer.observe(encoder.encode(JSON.stringify(body("x".repeat(4096)))))
    const facts = observer.finish()
    expect(facts.failure?.kind).toBe("credits-exhausted")
    expect(facts.failure?.signal).toBe("minimax:base_resp-1008")
  })
})

describe("errorClass from a driver hook, through relay-terminal", () => {
  test("a MiniMax in-body failure records its closed base_resp signal as errorClass", () => {
    const observer = createResponseObserver({
      dialect: "anthropic",
      operation: "messages",
      contentType: "application/json",
      maximumObservationBytes: 1024,
      descriptor: miniMaxDriver.responseObservation,
    })
    observer.observe(
      encoder.encode(JSON.stringify({ base_resp: { status_code: 1008, status_msg: "x" } })),
    )
    const terminal = createRelayTerminal()
    terminal.observe(observer.finish())
    expect(terminal.finish(observer.finish()).errorClass).toBe("minimax:base_resp-1008")
  })

  test.each([
    ["an upstream sentence", "codex:stream-error:Invalid prompt: we refused it"],
    ["no driver prefix", "invalid_prompt"],
    ["an unbounded value", `codex:${"x".repeat(100)}`],
  ])(
    "a hook signal outside the closed shape (%s) falls back to upstream_protocol_error",
    (_label, signal) => {
      const observer = createResponseObserver({
        dialect: "openai-responses",
        operation: "messages",
        contentType: "text/event-stream",
        maximumObservationBytes: 1024,
        descriptor: {
          terminalPolicy: "evidence-only",
          inspectPayload: (payload) =>
            (payload as { type?: string }).type === "response.failed"
              ? { kind: "server-error", status: 200, retryable: true, signal, rateLimit: null }
              : null,
        },
      })
      observer.observe(encoder.encode(frame({ type: "response.failed", response: {} })))
      const terminal = createRelayTerminal()
      terminal.observe(observer.finish())
      expect(terminal.finish(observer.finish()).errorClass).toBe("upstream_protocol_error")
    },
  )
})
