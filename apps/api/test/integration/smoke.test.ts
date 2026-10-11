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
 *
 * The redaction tests set a real key in the environment, drive the runner end to end (or spawn
 * `bin/smoke` as a subprocess so they capture what `main()` itself writes), and assert the key
 * never reaches plain stdout, plain stderr, or the JSON `keyEnv` field. The earlier test pinned
 * a value (`sk-test`) that never entered the runner — it passed regardless of what the runner
 * printed. These tests would fail if a regression let the key through.
 */

const TOOL_USE = {
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } }],
}

const TOOL_USE_NO_THINK = {
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

const MALFORMED_STRING = { stop_reason: "end_turn", content: "not-an-array" }
const MALFORMED_NULL = { stop_reason: "end_turn", content: [null] }

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

  test("rejects an unknown flag with a usage error that does not echo the value", () => {
    const parsed = parseArgs(["--nope"])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toContain("unknown option at position 1")
    expect(parsed.message).not.toContain("--nope")
  })

  test("rejects --key=abc without echoing the value", () => {
    const parsed = parseArgs(["--key=abc"])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).not.toContain("abc")
  })

  test("rejects --key-env with no value", () => {
    const parsed = parseArgs(["--url", "http://x", "--model", "m", "--key-env"])
    expect(parsed.ok).toBe(false)
  })

  test("rejects --key-env mar_live_x (the key prefix is refused at parse time)", () => {
    const parsed = parseArgs(["--url", "http://x", "--model", "m", "--key-env", "mar_live_x"])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).not.toContain("mar_live_x")
  })

  test("rejects --key-env with a non-identifier value without echoing it", () => {
    const parsed = parseArgs(["--url", "http://x", "--model", "m", "--key-env", "1bad"])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).not.toContain("1bad")
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
    expect(legs.filter((leg) => leg.endpoint === "/v1/messages").every((leg) => leg.required)).toBe(
      true,
    )
    expect(
      legs
        .filter(
          (leg) => leg.endpoint === "/v1/chat/completions" || leg.endpoint === "/v1/responses",
        )
        .every((leg) => !leg.required),
    ).toBe(true)
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

  test("the runner marks every leg INCONCLUSIVE with reason key-unset when the key is null and exits 2", async () => {
    const legs = buildLegs()
    const results = await runLegs({ url: baseUrl, model: "claude-opus-5", key: null, legs })
    expect(results.every((result) => result.outcome.verdict === "INCONCLUSIVE")).toBe(true)
    expect(results.every((result) => result.outcome.reason === "key-unset")).toBe(true)
    expect(decideExitCode(results)).toBe(2)
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

  test("a required leg graded FAIL exits 1", async () => {
    const legs = buildLegs()
    const synthetic = legs.map((leg, index) => ({
      leg,
      outcome:
        index === 0
          ? { verdict: "FAIL" as const, reason: "synthetic" }
          : { verdict: "PASS" as const },
      status: 200,
    }))
    expect(decideExitCode(synthetic)).toBe(1)
  })

  test("a required leg graded FAIL and another graded INCONCLUSIVE still exits 1", async () => {
    const legs = buildLegs()
    const synthetic = legs.map((leg, index) => ({
      leg,
      outcome:
        index === 0
          ? { verdict: "FAIL" as const, reason: "synthetic" }
          : index === 1
            ? { verdict: "INCONCLUSIVE" as const, reason: "timeout" }
            : { verdict: "PASS" as const },
      status: 200,
    }))
    expect(decideExitCode(synthetic)).toBe(1)
  })
})

describe("bin/smoke — the runner actually sends tools, tool_choice and reasoning effort upstream", () => {
  test("the forced, any, streamed and reasoning legs carry the right fields on the wire", async () => {
    const upstreamHarness = harness({
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
        () => jsonResponse(200, TOOL_USE_NO_THINK),
        () => jsonResponse(200, TOOL_USE),
        () => jsonResponse(200, TOOL_USE),
      ],
    })
    const upstreamServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: upstreamHarness.app.fetch,
    })
    try {
      const url = `http://127.0.0.1:${upstreamServer.port}`
      const legs = buildLegs()
      const results = await runLegs({ url, model: "claude-opus-5", key: KEY, legs })

      // Index map: the runner drives legs in order, so the call index mirrors the leg index.
      const calls = upstreamHarness.upstream.calls
      expect(calls).toHaveLength(legs.length)

      function bodyAt(index: number): Record<string, unknown> {
        const call = calls[index]
        if (call === undefined) throw new Error(`expected call at index ${index}`)
        return JSON.parse(call.body) as Record<string, unknown>
      }
      function headerAt(index: number, name: string): string | null {
        const call = calls[index]
        if (call === undefined) throw new Error(`expected call at index ${index}`)
        return call.headers.get(name)
      }
      function resultAt(index: number): (typeof results)[number] {
        const r = results[index]
        if (r === undefined) throw new Error(`expected result at index ${index}`)
        return r
      }

      // Leg 1 (forced_tool): must carry `tools` and `tool_choice: {type:"tool",name}` upstream.
      {
        const body = bodyAt(1)
        expect(Array.isArray(body.tools)).toBe(true)
        expect(body.tool_choice).toEqual({ type: "tool", name: "get_weather" })
      }

      // Leg 2 (tool_choice_any): tool_choice must reach the wire as `any`.
      {
        const body = bodyAt(2)
        expect(body.tool_choice).toEqual({ type: "any" })
        expect(Array.isArray(body.tools)).toBe(true)
      }

      // Leg 4 (streamed_forced_tool): stream header and tool_choice both reach the wire.
      {
        const body = bodyAt(4)
        expect(body.stream).toBe(true)
        expect(body.tool_choice).toEqual({ type: "tool", name: "get_weather" })
        expect(Array.isArray(body.tools)).toBe(true)
        expect(headerAt(4, "accept")).toBe("text/event-stream")
      }

      // Leg 5 (reasoning_forced_tool): adaptive thinking + output_config.effort reach the wire.
      {
        const body = bodyAt(5)
        expect(Array.isArray(body.tools)).toBe(true)
        expect(body.thinking).toEqual({ type: "adaptive" })
        expect(body.output_config).toEqual({ effort: "low" })
        expect(body.tool_choice).toEqual({ type: "tool", name: "get_weather" })
      }

      // And the grader reports PASS on the tool_use alone, with thinkingPresent=false.
      const reasoning = resultAt(5)
      expect(reasoning.outcome.verdict).toBe("PASS")
      expect(reasoning.outcome.thinkingPresent).toBe(false)

      // The rendered report names the missing thinking block (`thinking=no`) for a leg that came
      // back without one. The reasoning leg's upstream script returns TOOL_USE_NO_THINK, so the
      // report line for leg 5 carries `thinking=no` rather than `thinking=yes`.
      const report = buildReport(
        { url, model: "claude-opus-5", keyEnv: "MAR_KEY", json: false, help: false },
        results,
      )
      const text = renderReport(report)
      expect(text).toContain("thinking=no")
    } finally {
      upstreamServer.stop()
    }
  })
})

describe("bin/smoke — key redaction", () => {
  // The redaction key is the harness's own router key. The harness has that key as `KEY`, and
  // the subprocess reads the named env var and forwards its contents as the bearer token; the
  // router only accepts the harness's key, so the subprocess must pass it. We assert that key
  // value never reaches plain stdout, plain stderr, or the JSON `keyEnv` field.
  const REDACT_KEY = KEY

  async function withKey<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
    const previous = env.SMOKE_TEST_KEY
    env.SMOKE_TEST_KEY = REDACT_KEY
    try {
      return await fn()
    } finally {
      if (previous === undefined) delete env.SMOKE_TEST_KEY
      else env.SMOKE_TEST_KEY = previous
    }
  }

  test("the runner's plain-text report never contains the key", async () => {
    const legs = buildLegs()
    const results = await withKey(process.env, () =>
      runLegs({ url: baseUrl, model: "claude-opus-5", key: readKey("SMOKE_TEST_KEY"), legs }),
    )
    const report = buildReport(
      { url: baseUrl, model: "claude-opus-5", keyEnv: "SMOKE_TEST_KEY", json: false, help: false },
      results,
    )
    const text = renderReport(report)
    expect(text).toContain("SMOKE_TEST_KEY")
    expect(text).not.toContain(REDACT_KEY)
  })

  test("the runner's JSON report never contains the key", async () => {
    const legs = buildLegs()
    const results = await withKey(process.env, () =>
      runLegs({ url: baseUrl, model: "claude-opus-5", key: readKey("SMOKE_TEST_KEY"), legs }),
    )
    const report = buildReport(
      { url: baseUrl, model: "claude-opus-5", keyEnv: "SMOKE_TEST_KEY", json: true, help: false },
      results,
    )
    const json = JSON.stringify(report)
    expect(json).toContain("SMOKE_TEST_KEY")
    expect(json).not.toContain(REDACT_KEY)
  })

  test("bin/smoke subprocess: plain report never contains the key (stdout or stderr)", async () => {
    // The shared beforeAll harness is drained by the earlier integration tests, so spin up a
    // dedicated harness whose scripted responses are still all eight — the subprocess must read
    // them in order, and the harness's "repeat the last one" fallback would otherwise mis-grade
    // every leg.
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
        () => jsonResponse(200, TOOL_USE),
        () => jsonResponse(200, TOOL_USE),
      ],
    })
    const subServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch })
    const subUrl = `http://127.0.0.1:${subServer.port}`
    const previous = process.env.SMOKE_REDACT_TEST
    process.env.SMOKE_REDACT_TEST = REDACT_KEY
    try {
      const proc = Bun.spawn(
        [
          "bun",
          "apps/api/smoke/run.ts",
          "--url",
          subUrl,
          "--model",
          "claude-opus-5",
          "--key-env",
          "SMOKE_REDACT_TEST",
        ],
        { env: process.env, stdout: "pipe", stderr: "pipe" },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        proc.stdout.text(),
        proc.stderr.text(),
        proc.exited,
      ])
      const combined = `${stdout}\n${stderr}`
      expect(combined).toContain("SMOKE_REDACT_TEST")
      expect(combined).not.toContain(REDACT_KEY)
      if (exitCode !== 0)
        throw new Error(`subprocess exit=${exitCode}\nstdout=${stdout}\nstderr=${stderr}`)
      expect(exitCode).toBe(0)
    } finally {
      subServer.stop()
      if (previous === undefined) delete process.env.SMOKE_REDACT_TEST
      else process.env.SMOKE_REDACT_TEST = previous
    }
  })

  test("bin/smoke subprocess: --json report never contains the key (stdout or stderr)", async () => {
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
        () => jsonResponse(200, TOOL_USE),
        () => jsonResponse(200, TOOL_USE),
      ],
    })
    const subServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch })
    const subUrl = `http://127.0.0.1:${subServer.port}`
    const previous = process.env.SMOKE_REDACT_TEST
    process.env.SMOKE_REDACT_TEST = REDACT_KEY
    try {
      const proc = Bun.spawn(
        [
          "bun",
          "apps/api/smoke/run.ts",
          "--url",
          subUrl,
          "--model",
          "claude-opus-5",
          "--key-env",
          "SMOKE_REDACT_TEST",
          "--json",
        ],
        { env: process.env, stdout: "pipe", stderr: "pipe" },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        proc.stdout.text(),
        proc.stderr.text(),
        proc.exited,
      ])
      const combined = `${stdout}\n${stderr}`
      expect(combined).toContain("SMOKE_REDACT_TEST")
      expect(combined).not.toContain(REDACT_KEY)
      if (exitCode !== 0)
        throw new Error(`subprocess exit=${exitCode}\nstdout=${stdout}\nstderr=${stderr}`)
    } finally {
      subServer.stop()
      if (previous === undefined) delete process.env.SMOKE_REDACT_TEST
      else process.env.SMOKE_REDACT_TEST = previous
    }
  })
})

describe("bin/smoke — malformed-body handling", () => {
  test('a 200 with `content: "x"` grades FAIL malformed-body and the run exits 1', async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, MALFORMED_STRING)] })
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch })
    try {
      const url = `http://127.0.0.1:${server.port}`
      const legs = buildLegs()
      const results = await runLegs({ url, model: "claude-opus-5", key: KEY, legs })
      const first = results[0]
      if (first === undefined) throw new Error("expected at least one result")
      expect(first.outcome).toEqual({ verdict: "FAIL", reason: "malformed-body" })
      expect(decideExitCode(results)).toBe(1)
    } finally {
      server.stop()
    }
  })

  test("a 200 with `content: [null]` grades FAIL malformed-body and the run exits 1", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, MALFORMED_NULL)] })
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch })
    try {
      const url = `http://127.0.0.1:${server.port}`
      const legs = buildLegs()
      const results = await runLegs({ url, model: "claude-opus-5", key: KEY, legs })
      const first = results[0]
      if (first === undefined) throw new Error("expected at least one result")
      expect(first.outcome).toEqual({ verdict: "FAIL", reason: "malformed-body" })
      expect(decideExitCode(results)).toBe(1)
    } finally {
      server.stop()
    }
  })

  test("a 200 with `choices: [null]` grades FAIL malformed-body and the run exits 1", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, { choices: [null] })] })
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch })
    try {
      const url = `http://127.0.0.1:${server.port}`
      const legs = buildLegs()
      const results = await runLegs({ url, model: "claude-opus-5", key: KEY, legs })
      const first = results[0]
      if (first === undefined) throw new Error("expected at least one result")
      expect(first.outcome).toEqual({ verdict: "FAIL", reason: "malformed-body" })
      expect(decideExitCode(results)).toBe(1)
    } finally {
      server.stop()
    }
  })

  test('a 200 with `output: "x"` grades FAIL malformed-body and the run exits 1', async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, { output: "x" })] })
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch })
    try {
      const url = `http://127.0.0.1:${server.port}`
      const legs = buildLegs()
      const results = await runLegs({ url, model: "claude-opus-5", key: KEY, legs })
      const first = results[0]
      if (first === undefined) throw new Error("expected at least one result")
      expect(first.outcome).toEqual({ verdict: "FAIL", reason: "malformed-body" })
      expect(decideExitCode(results)).toBe(1)
    } finally {
      server.stop()
    }
  })

  test("a 200 with `output: [null]` grades FAIL malformed-body and the run exits 1", async () => {
    const { app } = harness({ responses: [() => jsonResponse(200, { output: [null] })] })
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch })
    try {
      const url = `http://127.0.0.1:${server.port}`
      const legs = buildLegs()
      const results = await runLegs({ url, model: "claude-opus-5", key: KEY, legs })
      const first = results[0]
      if (first === undefined) throw new Error("expected at least one result")
      expect(first.outcome).toEqual({ verdict: "FAIL", reason: "malformed-body" })
      expect(decideExitCode(results)).toBe(1)
    } finally {
      server.stop()
    }
  })
})

describe("bin/smoke — driveLeg backstop catches a grader throw", () => {
  // Once the OpenAI graders are total, the five malformed bodies the spec lists no longer throw
  // — they produce FAIL `malformed-body` directly. The only body shape that still throws is one
  // whose `stop_reason` cannot be coerced to a string in a template literal (a `{toString: 1}`
  // object). This test exercises that path: the runner catches the throw, reports FAIL
  // `malformed-body:<error>`, and `runLegs` resolves so the rest of the legs still run.
  test("a grader throw is caught by driveLeg and reported as FAIL malformed-body", async () => {
    const malformed: { stop_reason: { toString: number }; content: [] } = {
      stop_reason: { toString: 1 },
      content: [],
    }
    const fetchImpl = ((_url: string) =>
      Promise.resolve(jsonResponse(200, malformed))) as typeof fetch
    const legs = buildLegs()
    const results = await runLegs({
      url: "http://127.0.0.1:1/",
      model: "claude-opus-5",
      key: KEY,
      legs,
      fetchImpl,
    })
    // Every leg got a verdict — the runner did not reject and abort.
    expect(results).toHaveLength(legs.length)
    for (const result of results) {
      expect(result.outcome.verdict).toBeDefined()
    }
    const first = results[0]
    if (first === undefined) throw new Error("expected at least one result")
    expect(first.outcome.verdict).toBe("FAIL")
    expect(first.outcome.reason).toMatch(/^malformed-body:/)
    // decideExitCode is gated by the leg verdict alone, so a backstop FAIL on a required leg
    // exits 1; the backstop does not change the exit-code rule.
    expect(decideExitCode(results)).toBe(1)
  })
})

describe("bin/smoke — connection refused", () => {
  test("every required leg is INCONCLUSIVE with a non-key reason and the run exits 2", async () => {
    // Port 1 is reserved for tcpmux; a connect there refuses at once on every CI runner. The key
    // is set, so every leg walks the fetch path; the connection error is INCONCLUSIVE with reason
    // `network` (the TypeError the runner maps to `network`), not the `key-unset` path.
    const legs = buildLegs()
    const results = await runLegs({
      url: "http://127.0.0.1:1",
      model: "claude-opus-5",
      key: KEY,
      legs,
    })
    expect(results).toHaveLength(legs.length)
    const required = results.filter((result) => result.leg.required)
    expect(required.length).toBeGreaterThan(0)
    for (const result of required) {
      expect(result.outcome.verdict).toBe("INCONCLUSIVE")
      expect(result.outcome.reason).not.toBe("key-unset")
    }
    expect(decideExitCode(results)).toBe(2)
  })
})

describe("bin/smoke — process-level usage error (exit 64)", () => {
  // Two cases cover the two ways a typed key can reach the runner:
  //   - `--key=abc` is an unknown option the parser rejects without echoing the value.
  //   - `--key-env mar_live_x` carries the router key prefix, refused at the parse step.
  // Both exit 64, neither prints the value, and stderr carries the USAGE block. A regression
  // that accepted `--key=abc` would echo `abc`; one that accepted `mar_live_x` would print it
  // on the report line as `keyEnv=mar_live_x`. The USAGE-message check also tells a usage error
  // apart from a crash (which exits 64 with a different stderr).
  async function spawnSmoke(argv: readonly string[]): Promise<{
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
  }> {
    // `bun test` runs from the repo root, so `process.cwd()` is the directory `bin/smoke` lives
    // in. We spawn the sh wrapper with that cwd so its `cd "$(dirname "$0")/.."` resolves to the
    // same place and the `bun apps/api/smoke/run.ts` exec reaches the runner.
    const proc = Bun.spawn(["sh", "bin/smoke", ...argv], {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout.text(),
      proc.stderr.text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  }

  test("--key=abc exits 64 and prints neither stdout nor stderr with the value", async () => {
    const { exitCode, stdout, stderr } = await spawnSmoke(["--key=abc"])
    expect(exitCode).toBe(64)
    expect(stdout).not.toContain("abc")
    expect(stderr).not.toContain("abc")
    expect(stderr).toContain("Usage: bin/smoke")
  })

  test("--url http://127.0.0.1:1 --model m --key-env mar_live_x exits 64 and prints neither", async () => {
    const { exitCode, stdout, stderr } = await spawnSmoke([
      "--url",
      "http://127.0.0.1:1",
      "--model",
      "m",
      "--key-env",
      "mar_live_x",
    ])
    expect(exitCode).toBe(64)
    expect(stdout).not.toContain("mar_live_x")
    expect(stderr).not.toContain("mar_live_x")
    expect(stderr).toContain("Usage: bin/smoke")
  })
})
