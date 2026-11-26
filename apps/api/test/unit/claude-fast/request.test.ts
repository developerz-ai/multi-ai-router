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
        text: `x-anthropic-billing-header: cc_version=2.1.331.abc; cc_entrypoint=cli; cch=12345; ${extra}`,
      },
      { type: "text", text: HUMAN_IDENTITY },
    ],
  }
}

describe("Claude fast request", () => {
  test("an older native wire version falls back before inference", () => {
    const old = JSON.parse(JSON.stringify(native("")).replace("2.1.331", "2.1.319"))
    expect(prepare(old)).toBeNull()
  })
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
    expect(result.toolNames).toEqual(["client_shell"])
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
  test("a fingerprint-only native system block is dropped entirely", () => {
    // No conservative text shares this block: a fix that merely scrubs to empty text and keeps
    // the block would still forward it. Assert the block itself is absent, not just its text.
    const fingerprint = `Here is some useful information about the environment you are running in:
<env>
  Working directory: /home/router/workspace/router/router.ai
  Workspace root folder: /home/router/workspace/router/router.ai
  Is directory a git repo: yes
  Platform: linux
</env>
You are powered by the model named Claude Opus 5. The exact model ID is claude-opus-5.
You are OpenCode, the best coding agent on the planet.`
    const request = native("cc_turn_origin=task_notification; cc_prompt_index=2; cc_turn_index=3;")
    request.system.push({ type: "text", text: fingerprint })

    const result = prepare(request)
    if (!result) throw new Error("missing prepared body")
    const body = JSON.parse(result.text)
    const entries = body.system as { type?: unknown; text?: unknown }[]
    const systemText = entries
      .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
      .join("\n")

    expect(systemText).not.toContain("Here is some useful information about the environment")
    expect(systemText).not.toContain("<env>")
    expect(systemText).not.toContain("Working directory")
    expect(systemText).not.toContain("You are powered by the model named")
    expect(systemText).not.toContain("You are OpenCode, the best coding agent on the planet.")
    // No client system text remains: the fingerprint-only block was dropped, not scrubbed to
    // empty text and forwarded. Billing, identity and the assistant preset are transport blocks.
    expect(entries).toHaveLength(3)
    const [billing, identity, preset] = entries
    expect(billing?.text).toContain("x-anthropic-billing-header:")
    expect(identity?.text).toBe(HUMAN_IDENTITY)
    expect(preset?.text).toContain("You are the assistant, the best coding agent on the planet.")
    expect(systemText).toContain("cc_turn_origin=task_notification;")
    expect(inspectIntegrity(result.text).matches).toBe(true)
  })
  test("native system blocks lose harness fingerprints but keep conservative text and attribution", () => {
    // Verbatim from scrub.test.ts: opencode's `environment()` preamble plus the two identity
    // lines that make Anthropic meter a subscription request as a third-party app. A native
    // client's own CLI preset already carries the environment section, so the appended copy is
    // the duplicate that gates the whole pool behind Extra Usage.
    const fingerprint = `Here is some useful information about the environment you are running in:
<env>
  Working directory: /home/router/workspace/router/router.ai
  Workspace root folder: /home/router/workspace/router/router.ai
  Is directory a git repo: yes
  Platform: linux
</env>
You are powered by the model named Claude Opus 5. The exact model ID is claude-opus-5.
You are OpenCode, the best coding agent on the planet.`
    const conservative = "Tone: terse.\nTool policy: never write outside the repo."
    const request = native("cc_turn_origin=task_notification; cc_prompt_index=2; cc_turn_index=3;")
    request.system.push({ type: "text", text: `${conservative}\n\n${fingerprint}` })

    const result = prepare(request)
    if (!result) throw new Error("missing prepared body")
    const body = JSON.parse(result.text)
    const systemText = body.system
      .map((entry: { text?: unknown }) => (typeof entry.text === "string" ? entry.text : ""))
      .join("\n")

    expect(systemText).not.toContain("Here is some useful information about the environment")
    expect(systemText).not.toContain("<env>")
    expect(systemText).not.toContain("Working directory")
    expect(systemText).not.toContain("You are powered by the model named")
    expect(systemText).not.toContain("You are OpenCode, the best coding agent on the planet.")
    expect(systemText).toContain(conservative)
    expect(systemText).toContain("cc_turn_origin=task_notification;")
    expect(body.system[0].text).toContain("x-anthropic-billing-header:")
    expect(inspectIntegrity(result.text).matches).toBe(true)
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
