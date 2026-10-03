import { expect, test } from "bun:test"
import { miniMaxDriver } from "../../../src/providers/drivers/minimax"
import type { ResponseObservationSpec } from "../../../src/services/usage"
import { createResponseObserver } from "../../../src/services/usage"

const encoder = new TextEncoder()
function fixture(dialect: ResponseObservationSpec["dialect"], strict = false) {
  return createResponseObserver({
    dialect,
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: 1024,
    descriptor: { terminalPolicy: strict ? "require-completion" : "evidence-only" },
  })
}
test("exact protocol errors are sticky through later completion and never expose raw messages", () => {
  for (const [dialect, body] of [
    [
      "anthropic",
      { type: "error", error: { type: "api_error", message: "sensitive upstream text" } },
    ],
    ["openai-chat", { error: { message: "sensitive upstream text" } }],
    [
      "openai-responses",
      { type: "response.failed", response: { error: { message: "sensitive upstream text" } } },
    ],
  ] as const) {
    const observer = fixture(dialect)
    observer.observe(encoder.encode(`data: ${JSON.stringify(body)}\n\n`))
    observer.observe(encoder.encode('data: {"type":"response.completed"}\n\ndata: [DONE]\n\n'))
    const facts = observer.finish()
    expect(facts.terminal).toBe("explicit_error")
    expect(facts.failure?.kind).toBe("server-error")
    expect(JSON.stringify(facts)).not.toContain("sensitive upstream text")
  }
})
test("nested errors and quoted error fields are not protocol failures", () => {
  const observer = fixture("openai-chat")
  observer.observe(
    encoder.encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"error":{"message":"fake"}}', error: { message: "nested" } } }] })}\n\n`,
    ),
  )
  expect(observer.finish().failure).toBeNull()
})
test("explicit output-limit incomplete is distinct evidence without health failure", () => {
  const observer = fixture("openai-responses", true)
  observer.observe(
    encoder.encode(
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
    ),
  )
  expect(observer.finish()).toMatchObject({
    terminal: "explicit_incomplete",
    incompleteReason: "max_output_tokens",
    failure: null,
  })
})
test("missing marker is derived at finish only for strict fixture contract and available evidence", () => {
  for (const strict of [false, true]) {
    const observer = fixture("anthropic", strict)
    observer.observe(encoder.encode('data: {"type":"ping"}\n\n'))
    expect(observer.snapshot().failure).toBeNull()
    expect(observer.finish().failure?.signal ?? null).toBe(
      strict ? "protocol:missing-completion" : null,
    )
  }
  const complete = fixture("anthropic", true)
  complete.observe(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
  expect(complete.finish()).toMatchObject({ terminal: "completed", failure: null })
  const invalid = fixture("anthropic", true)
  invalid.observe(encoder.encode("data: invalid JSON\n\n"))
  expect(invalid.finish()).toMatchObject({ evidenceUnavailable: true, failure: null })
})
test("MiniMax declared success envelope classifies known codes and unknown nonzero generically", () => {
  for (const [code, kind] of [
    [0, undefined],
    [1008, "credits-exhausted"],
    [1002, "rate-limited"],
    [1004, "auth"],
    [1027, "invalid-request"],
    [999999, "server-error"],
  ] as const) {
    const observer = createResponseObserver({
      dialect: "anthropic",
      operation: "messages",
      contentType: "application/json",
      maximumObservationBytes: 1024,
      descriptor: miniMaxDriver.responseObservation,
    })
    observer.observe(
      encoder.encode(
        JSON.stringify({ base_resp: { status_code: code, status_msg: "do not persist this" } }),
      ),
    )
    const facts = observer.finish()
    expect(facts.failure?.kind).toBe(kind)
    expect(facts.failure?.status ?? 200).toBe(200)
    expect(JSON.stringify(facts)).not.toContain("do not persist this")
  }
})
