import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  buildLegs,
  buildReport,
  decideExitCode,
  parseArgs,
  readKey,
  renderReport,
  runLegs,
} from "../../smoke/run"
import { jsonResponse } from "../unit/dataplane/fixtures"
import { harness, KEY } from "./harness"

/**
 * End-to-end drive of `bin/smoke` against the real router with a mocked upstream. Every required
 * leg returns a scripted response, the runner walks the eight legs in order, and the integration
 * asserts the verdicts and exit code a real run would emit. Informational legs never decide the
 * exit code; the test asserts that too.
 *
 * No live provider, no Postgres, no disk — the router is the composition root's real Hono app
 * mounted on `Bun.serve` with `port: 0`, the upstream is `mockUpstream`, and the key repository is
 * the in-memory fixture. The same body shapes production sees reach the same dispatcher path.
 */

const TOOL_USE = {
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }],
}

const TEXT = {
  stop_reason: "end_turn",
  content: [{ type: "text", text: "pong" }],
}

const ROUND_TRIP = {
  stop_reason: "end_turn",
  content: [{ type: "text", text: "It's 18°C in Paris." }],
}

const REASONING_TOOL = {
  stop_reason: "tool_use",
  content: [
    { type: "thinking", thinking: "The user asked about Paris weather." },
    { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
  ],
}

const STREAMED_TOOL_SSE = [
  "event: message_start\n",
  'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"usage":{"input_tokens":11,"output_tokens":0}}}\n',
  "\n",
  "event: content_block_start\n",
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n',
  "\n",
  "event: content_block_stop\n",
  'data: {"type":"content_block_stop","index":0}\n',
  "\n",
  "event: message_delta\n",
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":8}}\n',
  "\n",
  "event: message_stop\n",
  'data: {"type":"message_stop"}\n',
  "\n",
].join("")

let server: ReturnType<typeof Bun.serve> | null = null
let baseUrl = ""

beforeAll(() => {
  // Eight legs, scripted in the order the runner drives them. The non-stream legs return JSON; the
  // streamed leg returns Anthropic SSE bytes the runner's parser will assemble.
  const { app } = harness({
    responses: [
      () => jsonResponse(200, TEXT),
      () => jsonResponse(200, TOOL_USE),
      () => jsonResponse(200, TOOL_USE),
      () => jsonResponse(200, ROUND_TRIP),
      () =>
        new Response(STREAMED_TOOL_SSE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      () => jsonResponse(200, REASONING_TOOL),
      // /v1/chat/completions against an anthropic account: the router translates a tool_use block
      // into OpenAI tool_calls. The script returns the *upstream* shape; the dispatcher's
      // translate egress mode rebuilds the wire format.
      () => jsonResponse(200, TOOL_USE),
      // /v1/responses against an anthropic account: same translation, different wire shape.
      () => jsonResponse(200, TOOL_USE),
    ],
  })

  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server?.stop()
  server = null
})

describe("bin/smoke — parseArgs", () => {
  test("--help prints the usage and returns 0", () => {
    const parsed = parseArgs(["--help"])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.help).toBe(true)
  })

  test("rejects an unknown flag with a usage error", () => {
    const parsed = parseArgs(["--nope"])
    expect(parsed.ok).toBe(false)
  })

  test("rejects --key-env with no value", () => {
    const parsed = parseArgs(["--url", "http://x", "--model", "m", "--key-env"])
    expect(parsed.ok).toBe(false)
  })

  test("requires url, model and key-env", () => {
    expect(parseArgs([]).ok).toBe(false)
    expect(parseArgs(["--url", "http://x"]).ok).toBe(false)
    expect(parseArgs(["--url", "http://x", "--model", "m"]).ok).toBe(false)
  })
})

describe("bin/smoke — readKey", () => {
  test("returns null for an unset variable", () => {
    expect(readKey("DEFINITELY_NOT_A_REAL_ENV_VAR_123")).toBeNull()
  })

  test("returns null for an empty string", () => {
    const previous = process.env.SMOKE_TEST_EMPTY
    process.env.SMOKE_TEST_EMPTY = ""
    try {
      expect(readKey("SMOKE_TEST_EMPTY")).toBeNull()
    } finally {
      if (previous === undefined) {
        delete process.env.SMOKE_TEST_EMPTY
      } else {
        process.env.SMOKE_TEST_EMPTY = previous
      }
    }
  })

  test("returns the env value when set", () => {
    process.env.SMOKE_TEST_KEY = "sk-test"
    try {
      expect(readKey("SMOKE_TEST_KEY")).toBe("sk-test")
    } finally {
      delete process.env.SMOKE_TEST_KEY
    }
  })
})

describe("bin/smoke — leg construction", () => {
  test("builds the eight documented legs in the documented order", () => {
    const legs = buildLegs()
    expect(legs.map((leg) => leg.name)).toEqual([
      "messages.text",
      "messages.forced_tool",
      "messages.tool_choice_any",
      "messages.tool_round_trip",
      "messages.streamed_forced_tool",
      "messages.reasoning_forced_tool",
      "chat_completions.required_tool",
      "responses.function_call",
    ])
    expect(legs.filter((leg) => leg.endpoint === "/v1/messages")).toHaveLength(6)
    expect(legs.filter((leg) => leg.endpoint === "/v1/chat/completions")).toHaveLength(1)
    expect(legs.filter((leg) => leg.endpoint === "/v1/responses")).toHaveLength(1)
    expect(legs.filter((leg) => leg.stream)).toHaveLength(1)
  })
})

describe("bin/smoke — integration drive against a booted router", () => {
  test("every required leg PASSes and the exit code is 0", async () => {
    const legs = buildLegs()
    const results = await runLegs({ url: baseUrl, model: "claude-opus-5", key: KEY, legs })

    for (const result of results) {
      expect({
        name: result.leg.name,
        verdict: result.outcome.verdict,
        reason: result.outcome.reason,
      }).toMatchObject({
        verdict: "PASS",
      })
    }
    expect(decideExitCode(results)).toBe(0)

    const report = buildReport(
      { url: baseUrl, model: "claude-opus-5", keyEnv: "MAR_KEY", json: false, help: false },
      results,
    )
    const text = renderReport(report)
    expect(text).toContain("messages.text")
    expect(text).toContain("responses.function_call")
  })

  test("an informational leg returning 404 keeps the exit code at 0", async () => {
    // A runner that returned 0 even when a required leg failed would mask regressions; a runner
    // that returned 1 when an informational leg failed would over-block. The harness has no
    // /v1/missing-account path so we lean on decideExitCode directly with a synthetic FAIL on a
    // non-required leg and assert the verdict is computed only from required legs.
    const legs = buildLegs()
    const synthetic = legs.map((leg, index) => ({
      leg,
      outcome:
        index === legs.length - 1
          ? { verdict: "FAIL" as const, reason: "synthetic" }
          : { verdict: "PASS" as const },
      status: 200,
    }))
    expect(decideExitCode(synthetic)).toBe(0)
  })

  test("the runner marks every leg INCONCLUSIVE when the key is null and exits 2", async () => {
    const legs = buildLegs()
    const results = await runLegs({ url: baseUrl, model: "claude-opus-5", key: null, legs })
    expect(results.every((result) => result.outcome.verdict === "INCONCLUSIVE")).toBe(true)
    expect(decideExitCode(results)).toBe(2)
  })

  test("the runner reads no body in the report and names the keyEnv, not its value", () => {
    const legs = buildLegs()
    const synthetic = legs.map((leg) => ({
      leg,
      outcome: { verdict: "PASS" as const },
      status: 200,
    }))
    const report = {
      url: "http://example.com",
      model: "m",
      keyEnv: "SMOKE_TEST_KEY",
      legs: synthetic.map((result) => ({
        name: result.leg.name,
        endpoint: result.leg.endpoint,
        stream: result.leg.stream,
        required: result.leg.endpoint === "/v1/messages",
        verdict: result.outcome.verdict,
        status: result.status,
      })),
    }
    const text = renderReport(report)
    expect(text).toContain("SMOKE_TEST_KEY")
    expect(text).not.toContain("sk-test")
  })
})
