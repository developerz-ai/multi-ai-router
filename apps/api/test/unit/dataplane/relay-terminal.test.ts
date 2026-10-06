import { expect, test } from "bun:test"
import { ClientCancelledError } from "../../../src/services/dataplane/relay-cancellation"
import { createRelayTerminal } from "../../../src/services/dataplane/relay-terminal"
import { createResponseObserver } from "../../../src/services/usage/response-observer"

function observer(maximumObservationBytes = 1024) {
  return createResponseObserver({
    dialect: "anthropic",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes,
    descriptor: { terminalPolicy: "require-completion" },
  })
}

test("strict missing completion is validated at EOF, not before", () => {
  const response = observer()
  response.observe(
    new TextEncoder().encode('event: message_start\ndata: {"type":"message_start"}\n\n'),
  )
  expect(createRelayTerminal().finish(response.snapshot()).outcome).toBe("success")
  expect(createRelayTerminal().finish(response.finish())).toMatchObject({
    outcome: "upstream_error",
    errorClass: "upstream_incomplete",
    recovery: "failed",
  })
})

test("unavailable observation is not proof of missing protocol completion", () => {
  const response = observer(10)
  response.observe(
    new TextEncoder().encode('data: {"type":"message_start","content":"too large"}\n\n'),
  )
  const facts = response.finish()
  expect(facts.evidenceUnavailable).toBe(true)
  expect(createRelayTerminal().finish(facts)).toMatchObject({ outcome: "success", failure: null })
})

test("intentional Responses output limit is incomplete without an account strike", () => {
  const response = createResponseObserver({
    dialect: "openai-responses",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: 1024,
  })
  response.observe(
    new TextEncoder().encode(
      'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
    ),
  )
  expect(createRelayTerminal().finish(response.finish())).toMatchObject({
    outcome: "upstream_error",
    errorClass: "upstream_incomplete",
    failure: null,
    recovery: "uncertain",
  })
})

test("client cancel settles recovery by whether the model already produced output", () => {
  const before = createRelayTerminal()
  before.error(new ClientCancelledError())
  expect(before.finish(observer().snapshot())).toMatchObject({
    outcome: "client_error",
    failure: null,
    recovery: "uncertain",
  })
  const after = createRelayTerminal()
  after.error(new ClientCancelledError(), true)
  expect(after.finish(observer().snapshot())).toMatchObject({
    outcome: "client_error",
    errorClass: "client_cancelled",
    failure: null,
    recovery: "succeeded",
  })
})

test("an observed upstream failure outranks a later cancel after output", () => {
  const response = observer()
  response.observe(
    new TextEncoder().encode(
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"x"}}\n\n',
    ),
  )
  const terminal = createRelayTerminal()
  terminal.observe(response.snapshot())
  terminal.error(new ClientCancelledError(), true)
  expect(terminal.finish(response.snapshot()).recovery).not.toBe("succeeded")
})
