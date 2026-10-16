import { describe, expect, test } from "bun:test"
import { inspectIntegrity } from "../../../src/providers/claude-fast/integrity"
import { HUMAN_IDENTITY, SDK_IDENTITY } from "../../../src/providers/claude-fast/profile"
import { prepareFastRequest, readFastRequest } from "../../../src/providers/claude-fast/request"

const identity = {
  accessToken: "private-token",
  expiresAt: Date.now() + 3600000,
  deviceId: "a".repeat(64),
  accountUuid: "11111111-1111-4111-8111-111111111111",
}
function prepare(body: object, scope = "key") {
  return prepareFastRequest({
    request: readFastRequest(Buffer.from(JSON.stringify(body))),
    model: "claude-opus-5",
    identity,
    accountId: "account",
    apiKeyId: scope,
    sessionKey: "session",
  })
}
const basic = {
  model: "claude-opus-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
}
function native(extra: string) {
  return {
    ...basic,
    system: [
      {
        type: "text",
        text: `x-anthropic-billing-header: cc_version=2.1.301.abc; cc_entrypoint=cli; cch=12345; ${extra}`,
      },
      { type: "text", text: HUMAN_IDENTITY },
    ],
  }
}

describe("Claude fast request", () => {
  test("calibrates integrity, isolates identity, and leaves input untouched", () => {
    const original = JSON.stringify(basic)
    const result = prepare(basic)
    expect(result).not.toBeNull()
    if (!result) throw new Error("missing prepared body")
    const body = JSON.parse(result.text)
    expect(inspectIntegrity(result.text).matches).toBe(true)
    expect(body.stream).toBe(true)
    expect(body.system[1].text).toBe(HUMAN_IDENTITY)
    expect(result.text).not.toContain(identity.accessToken)
    expect(JSON.stringify(basic)).toBe(original)
    expect(prepare(basic)?.sessionId).toBe(result.sessionId)
    expect(prepare(basic, "other-key")?.sessionId).not.toBe(result.sessionId)
    expect(JSON.parse(body.metadata.user_id).device_id).toBe(identity.deviceId)
  })
  test("preserves thinking signatures, tools, results and unknown per-turn fields", () => {
    const body = {
      ...basic,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools: [{ name: "client_shell", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "thought", signature: "signed" },
            { type: "tool_use", id: "tool_1", name: "client_shell", input: { command: "pwd" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: "/client",
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        },
      ],
    }
    const result = prepare(body)
    if (!result) throw new Error("missing prepared body")
    const output = JSON.parse(result.text)
    expect(output.messages).toEqual(body.messages)
    expect(output.tools).toEqual(body.tools)
    expect(output.thinking).toEqual(body.thinking)
    expect(output.output_config).toEqual(body.output_config)
    expect(output.system[1].cache_control).toBeUndefined()
  })
  test("retains notification attribution and omits compact helper attribution", () => {
    expect(
      prepare(native("cc_turn_origin=task_notification; cc_prompt_index=2; cc_turn_index=3;"))
        ?.text,
    ).toContain("cc_turn_origin=task_notification;")
    expect(prepare(native(""))?.text).not.toContain("cc_turn_origin=")
    const child = prepare(native("cc_is_subagent=true;"))
    expect(child?.subagent).toBe(true)
    expect(child?.text).toContain(SDK_IDENTITY)
    expect(child?.text).not.toContain("cc_turn_origin=")
  })
  test("unknown native CLI versions fall back instead of guessing integrity", () => {
    const body = native("")
    body.system[0] = {
      type: "text",
      text: "x-anthropic-billing-header: cc_version=2.1.999.abc; cch=00000;",
    }
    expect(prepare(body)).toBeNull()
  })
  test("malformed bodies produce a generic error without request content", () => {
    expect(() => readFastRequest(Buffer.from('{"secret":"private"}'))).toThrow(
      "invalid Claude Messages request",
    )
  })
})
