import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { inspectIntegrity, versionSuffix } from "./integrity"
import { parse, traceEnv } from "./options"
import { summarizeFlow } from "./summary"

describe("Claude wire diagnostics (offline)", () => {
  test("collector redacts secrets, excludes token exchange, and forwards streaming chunks unchanged", async () => {
    const child = Bun.spawn(["python3", "-I", resolve(import.meta.dir, "capture_test.py")], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const error = await new Response(child.stderr).text()
    expect(await child.exited, error).toBe(0)
  })

  test("summary preserves quota, cache usage and tool round-trip structure", () => {
    const summary = summarizeFlow({
      method: "POST",
      path: "/v1/messages",
      status: 200,
      headers: { "user-agent": "claude-cli/test", "anthropic-beta": "oauth-test" },
      body: {
        model: "claude-test",
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_entrypoint=cli; cc_turn_origin=task_notification;",
          },
        ],
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "<id:1>" }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "<id:1>",
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
            ],
          },
        ],
      },
      response_headers: {
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "set-cookie": "hidden",
      },
      events: [
        { type: "message_start", message: { usage: { cache_read_input_tokens: 123 } } },
        { type: "message_stop" },
      ],
      chunks: 3,
    })
    expect(summary.roles).toEqual(["assistant", "user"])
    expect(summary.blocks.tool_result).toBe(1)
    expect(summary.usage).toEqual([{ cache_read_input_tokens: 123 }])
    expect(summary.quota).toEqual({ "anthropic-ratelimit-unified-5h-status": "allowed" })
    expect(summary.cacheControls).toEqual([
      { location: "body.messages[1].content[0]", control: { type: "ephemeral", ttl: "1h" } },
    ])
    expect(summary.attribution).toContain("task_notification")
  })

  test("CLI options reject unknown or invalid ports instead of changing the trace silently", () => {
    expect(() => parse(["--port", "NaN"])).toThrow("invalid --port")
    expect(() => parse(["--model"])).toThrow("missing value")
    expect(() => parse(["--unsupported", "x"])).toThrow("unknown trace option")
    expect(parse(["--model", "claude-test", "--private-wire"]).model).toBe("claude-test")
  })

  test("trace environment keeps account isolation and does not leak router credentials", () => {
    const env = traceEnv("/tmp/trace-account", "http://127.0.0.1:18089", "/tmp/trace")
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/trace-account")
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:18089")
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1")
    for (const secret of [
      "DATABASE_URL",
      "ENCRYPTION_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ])
      expect(env[secret]).toBeUndefined()
    expect(
      traceEnv(undefined, "http://127.0.0.1:18089", "/tmp/trace").CLAUDE_CONFIG_DIR,
    ).toBeUndefined()
  })
})

describe("captured CLI integrity projection", () => {
  const body = {
    model: "claude-test",
    messages: [
      {
        role: "user",
        content: "Unicode: café 🐈. Quoted cc_entrypoint=cli; cch=fffff; stays unchanged.",
      },
    ],
    system: [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.301.123; cc_entrypoint=cli; cch=f9d9c; cc_turn_origin=human;",
      },
    ],
    max_tokens: 64,
    fallbacks: ["ignored"],
    fallback_credit_token: "ignored",
    stream: true,
  }
  test("matches an independently computed Python xxHash64 fixture, preserving quoted tokens and Unicode", () => {
    expect(inspectIntegrity(JSON.stringify(body))).toMatchObject({
      expected: "f9d9c",
      actual: "f9d9c",
      matches: true,
    })
  })
  test("routing projection ignores model, output cap and fallback fields, but detects conversation changes", () => {
    expect(
      inspectIntegrity(
        JSON.stringify({
          ...body,
          model: "another-model",
          max_tokens: 999,
          fallbacks: [],
          fallback_credit_token: "different",
        }),
      ).matches,
    ).toBe(true)
    expect(
      inspectIntegrity(
        JSON.stringify({ ...body, messages: [{ role: "user", content: "changed" }] }),
      ).matches,
    ).toBe(false)
  })
  test("unknown CLI versions fail calibration instead of emitting an unverified checksum", () => {
    expect(() => inspectIntegrity(JSON.stringify(body).replace("2.1.301", "9.9.9"))).toThrow(
      "uncalibrated",
    )
  })
  test("version suffix uses original user text, not inserted context", () => {
    expect(versionSuffix("Remember the marker ORCHID_42. Reply briefly.", "2.1.301")).toBe("e0b")
  })
})
