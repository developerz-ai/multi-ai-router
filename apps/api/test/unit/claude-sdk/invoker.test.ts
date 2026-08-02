import { describe, expect, test } from "bun:test"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import {
  type CliResolution,
  createSdkConcurrency,
  createSdkInvoker,
  type SdkQueryFn,
  type SdkSessionReport,
} from "../../../src/providers"
import { sdkQueryStream, sdkTurn, wireEvent } from "./fixtures"

/**
 * The transport itself: `createSdkInvoker` composing the launch, the tools, the concurrency gate,
 * and the renderer into one `query()` turn (docs/idea/11-anthropic-agent-sdk.md §2).
 *
 * **No `claude` CLI is spawned here, and none may ever be** (CLAUDE.md testing rules). `query()` and
 * the executable-resolution ladder are both injected, so what runs below is the real composition
 * with the subprocess replaced by a fixture stream shaped exactly like the SDK's own.
 *
 * The properties asserted are the ones that only exist once the pieces are wired together: the slot
 * is held for the *stream*, not for the call; the lineage plan reaches the launch verbatim; the
 * session is reported once, at the end, with the uuid an undo needs; and a failure carries the
 * subprocess's last words to the classifier.
 */

const CONFIG_DIR = "/data/claude/3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410"
const CLI: CliResolution = {
  ok: true,
  source: "platform_package",
  path: "/opt/claude/claude",
  bytes: 245_000_000,
}

const FRESH = { kind: "fresh", reason: "no-session" } as const

function body(value: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ model: "claude-opus-5", ...value }))
}

const ONE_TURN = sdkTurn({
  blocks: [
    [
      { type: "text", text: "" },
      { type: "text_delta", text: "pong" },
    ],
  ],
})

interface Spy {
  readonly options: Options[]
  readonly prompts: unknown[]
  readonly query: SdkQueryFn
}

/** Captures what the SDK would have been launched with, and answers with a fixture stream. */
function spyQuery(
  stream: () => AsyncIterable<unknown> = () => sdkQueryStream({ turns: [ONE_TURN] }),
): Spy {
  const options: Options[] = []
  const prompts: unknown[] = []

  return {
    options,
    prompts,
    query: ({ prompt, options: launched }) => {
      options.push(launched)
      return {
        async *[Symbol.asyncIterator]() {
          for await (const message of prompt) prompts.push(message)
          yield* stream()
        },
      }
    },
  }
}

function invoker(spy: Spy, concurrency = createSdkConcurrency({ global: 4, perAccount: 2 })) {
  return {
    concurrency,
    invoke: createSdkInvoker({ concurrency, runQuery: spy.query, resolveCli: () => CLI }),
  }
}

function invocation(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "sub-1",
    configDir: CONFIG_DIR,
    model: "claude-opus-5",
    body: body({ messages: [{ role: "user", content: "ping" }] }),
    signal: new AbortController().signal,
    session: FRESH,
    ...overrides,
  }
}

describe("one turn, end to end, with the subprocess stubbed", () => {
  test("a non-streaming client gets one Anthropic Messages object", async () => {
    const spy = spyQuery()
    const response = await invoker(spy).invoke(invocation())

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")

    const answered = (await response.json()) as Record<string, unknown>
    expect(answered.type).toBe("message")
    expect(answered.role).toBe("assistant")
    expect(answered.content).toEqual([{ type: "text", text: "pong" }])
  })

  test("a streaming client gets SSE, opening with message_start and closing with message_stop", async () => {
    const spy = spyQuery()
    const response = await invoker(spy).invoke(
      invocation({ body: body({ messages: [{ role: "user", content: "ping" }], stream: true }) }),
    )

    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const sse = await response.text()
    expect(sse.indexOf("event: message_start")).toBe(0)
    expect(sse.trimEnd().endsWith(JSON.stringify({ type: "message_stop" }))).toBe(true)
  })

  test("the prompt is one user message carrying the client's own turn", async () => {
    const spy = spyQuery()
    await (await invoker(spy).invoke(invocation())).text()

    expect(spy.prompts).toEqual([
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "ping" }] },
        parent_tool_use_id: null,
      },
    ])
  })
})

describe("the launch every turn is given", () => {
  test("carries this account's directory, the client's model, and the resolved binary", async () => {
    const spy = spyQuery()
    await (await invoker(spy).invoke(invocation())).text()
    const options = spy.options[0]

    expect(options?.cwd).toBe(CONFIG_DIR)
    expect(options?.model).toBe("claude-opus-5")
    expect(options?.pathToClaudeCodeExecutable).toBe("/opt/claude/claude")
    expect((options?.env ?? {}) as Record<string, string>).toMatchObject({
      CLAUDE_CONFIG_DIR: CONFIG_DIR,
    })
  })

  test("carries every isolation flag, on the real path and not only in the security fixture", async () => {
    const spy = spyQuery()
    await (await invoker(spy).invoke(invocation())).text()
    const options = spy.options[0]

    expect(options?.settingSources).toEqual([])
    expect(options?.strictMcpConfig).toBe(true)
    expect(options?.skills).toEqual([])
    expect(options?.tools).toEqual([])
    expect(options?.allowedTools).toEqual([])
    expect(options?.permissionMode).toBe("dontAsk")
    expect(options?.canUseTool).toBeDefined()
  })

  test("passes the client's system prompt, and sets none when the client sent none", async () => {
    const withSystem = spyQuery()
    await (
      await invoker(withSystem).invoke(
        invocation({
          body: body({ messages: [{ role: "user", content: "hi" }], system: "be terse" }),
        }),
      )
    ).text()
    expect(withSystem.options[0]?.systemPrompt).toBe("be terse")

    const without = spyQuery()
    await (await invoker(without).invoke(invocation())).text()
    expect(without.options[0]?.systemPrompt).toBeUndefined()
  })

  test("a fresh turn resumes nothing — the three session options are absent, not empty", async () => {
    const spy = spyQuery()
    await (await invoker(spy).invoke(invocation())).text()

    expect(spy.options[0]).not.toHaveProperty("resume")
    expect(spy.options[0]).not.toHaveProperty("forkSession")
    expect(spy.options[0]).not.toHaveProperty("resumeSessionAt")
  })

  test("a resume plan reaches the SDK verbatim", async () => {
    const spy = spyQuery()
    await (
      await invoker(spy).invoke(
        invocation({
          session: {
            kind: "resume",
            sdkSessionId: "sess_9",
            lineage: "continuation",
            deltaFrom: 0,
          },
        }),
      )
    ).text()

    expect(spy.options[0]?.resume).toBe("sess_9")
    expect(spy.options[0]?.forkSession).toBeUndefined()
  })

  test("an undo forks at the assistant message the plan named", async () => {
    const spy = spyQuery()
    await (
      await invoker(spy).invoke(
        invocation({
          session: {
            kind: "fork",
            sdkSessionId: "sess_9",
            resumeSessionAt: "uuid-7",
            deltaFrom: 0,
          },
        }),
      )
    ).text()

    expect(spy.options[0]?.resume).toBe("sess_9")
    expect(spy.options[0]?.forkSession).toBe(true)
    expect(spy.options[0]?.resumeSessionAt).toBe("uuid-7")
  })

  test("a client that sent no tools gets no MCP server and no hook", async () => {
    const spy = spyQuery()
    await (await invoker(spy).invoke(invocation())).text()

    expect(spy.options[0]?.mcpServers).toBeUndefined()
    expect(spy.options[0]?.hooks).toBeUndefined()
  })

  test("a client that sent tools gets them registered, and the allowlist stays empty", async () => {
    const spy = spyQuery()
    await (
      await invoker(spy).invoke(
        invocation({
          body: body({
            messages: [{ role: "user", content: "weather?" }],
            tools: [{ name: "get_weather", description: "d", input_schema: { type: "object" } }],
          }),
        }),
      )
    ).text()

    expect(Object.keys(spy.options[0]?.mcpServers ?? {})).toEqual(["client"])
    expect(spy.options[0]?.hooks?.PreToolUse).toBeDefined()
    expect(spy.options[0]?.allowedTools).toEqual([])
  })
})

describe("what the turn reports back", () => {
  test("the session is reported once, after the stream ends, with the undo point", async () => {
    const reports: SdkSessionReport[] = []
    const spy = spyQuery(() =>
      sdkQueryStream({
        sessionId: "sess_new",
        turns: [
          [
            { type: "assistant", uuid: "uuid-5", message: { role: "assistant", content: [] } },
            ...ONE_TURN,
          ],
        ],
      }),
    )

    const response = await invoker(spy).invoke(
      invocation({ onSession: (report: SdkSessionReport) => reports.push(report) }),
    )
    await response.text()

    expect(reports).toEqual([{ sdkSessionId: "sess_new", assistantUuid: "uuid-5" }])
  })

  test("a subagent's assistant uuid is never the undo point", async () => {
    const reports: SdkSessionReport[] = []
    const spy = spyQuery(() =>
      sdkQueryStream({
        sessionId: "sess_new",
        turns: [
          [
            {
              type: "assistant",
              uuid: "uuid-subagent",
              parent_tool_use_id: "toolu_1",
              message: { role: "assistant", content: [] },
            },
            ...ONE_TURN,
          ],
        ],
      }),
    )

    await (
      await invoker(spy).invoke(
        invocation({ onSession: (report: SdkSessionReport) => reports.push(report) }),
      )
    ).text()

    expect(reports).toEqual([{ sdkSessionId: "sess_new" }])
  })

  test("a turn that named no session reports nothing — a binding with no id pins for no gain", async () => {
    const reports: SdkSessionReport[] = []
    const spy = spyQuery(() => ({
      async *[Symbol.asyncIterator]() {
        for (const event of ONE_TURN) yield event
        yield { type: "result", subtype: "success" }
      },
    }))

    await (
      await invoker(spy).invoke(
        invocation({ onSession: (report: SdkSessionReport) => reports.push(report) }),
      )
    ).text()

    expect(reports).toEqual([])
  })

  test("every rate_limit_event is forwarded to account state, never to the client", async () => {
    const seen: unknown[] = []
    const spy = spyQuery(() =>
      sdkQueryStream({
        turns: [ONE_TURN],
        rateLimitInfo: { status: "rejected", rateLimitType: "five_hour" },
      }),
    )

    const response = await invoker(spy).invoke(
      invocation({ onRateLimit: (info: unknown) => seen.push(info) }),
    )
    const answered = await response.text()

    expect(seen).toEqual([{ status: "rejected", rateLimitType: "five_hour" }])
    expect(answered).not.toContain("five_hour")
  })
})

describe("the subprocess slot", () => {
  test("is held for the whole stream and released once it ends", async () => {
    const concurrency = createSdkConcurrency({ global: 4, perAccount: 2 })
    const duringQuery: number[] = []
    const spy = spyQuery(() => ({
      async *[Symbol.asyncIterator]() {
        duringQuery.push(concurrency.inFlight)
        yield* sdkQueryStream({ turns: [ONE_TURN] })
      },
    }))

    const { invoke } = invoker(spy, concurrency)
    const response = await invoke(invocation())
    await response.text()

    expect(duringQuery).toEqual([1])
    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.inFlightFor("sub-1")).toBe(0)
  })

  test("is released when the turn fails, so one bad account cannot exhaust the replica", async () => {
    const concurrency = createSdkConcurrency({ global: 4, perAccount: 2 })
    const spy = spyQuery(() => ({
      // biome-ignore lint/correctness/useYield: the failure is the point — nothing is ever yielded.
      async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
        throw new Error("Claude AI usage limit reached")
      },
    }))

    const { invoke } = invoker(spy, concurrency)
    await expect(invoke(invocation())).rejects.toThrow("usage limit reached")
    expect(concurrency.inFlight).toBe(0)
  })

  test("a caller aborted while queued throws the signal's own reason and spawns nothing", async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const spy = spyQuery(() => ({
      async *[Symbol.asyncIterator]() {
        // Never ends on its own: the first caller holds the only slot for the whole test.
        await new Promise(() => {})
        yield undefined
      },
    }))

    const { invoke } = invoker(spy, concurrency)
    void invoke(invocation({ body: body({ messages: [], stream: true }) }))
    await Promise.resolve()

    const controller = new AbortController()
    const queued = invoke(invocation({ signal: controller.signal }))
    controller.abort(Object.assign(new Error("deadline"), { name: "TimeoutError" }))

    await expect(queued).rejects.toMatchObject({ name: "TimeoutError" })
    expect(spy.options).toHaveLength(1)
  })

  test("two accounts invoked concurrently never share a directory or a slot", async () => {
    const concurrency = createSdkConcurrency({ global: 4, perAccount: 2 })
    const launchedCwd: Record<string, string> = {}
    let releaseA: (() => void) | undefined
    let releaseB: (() => void) | undefined

    const invoke = createSdkInvoker({
      concurrency,
      resolveCli: () => CLI,
      runQuery: ({ options }) => {
        const cwd = options.cwd as string
        const accountId = cwd.endsWith("/acct-a") ? "acct-a" : "acct-b"
        launchedCwd[accountId] = cwd
        return {
          async *[Symbol.asyncIterator]() {
            // Stalls until the test releases it, so both calls are provably in flight together —
            // not merely serialized by an event loop that never actually overlapped them.
            await new Promise<void>((resolve) => {
              if (accountId === "acct-a") releaseA = resolve
              else releaseB = resolve
            })
            for (const event of ONE_TURN) yield event
          },
        }
      },
    })

    const a = invoke(invocation({ accountId: "acct-a", configDir: "/data/accounts/acct-a" }))
    const b = invoke(invocation({ accountId: "acct-b", configDir: "/data/accounts/acct-b" }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Overlap is real: both accounts hold their own slot and were launched in their own directory
    // at the same time, not one after the other.
    expect(concurrency.inFlightFor("acct-a")).toBe(1)
    expect(concurrency.inFlightFor("acct-b")).toBe(1)
    expect(concurrency.inFlight).toBe(2)
    expect(launchedCwd["acct-a"]).toBe("/data/accounts/acct-a")
    expect(launchedCwd["acct-b"]).toBe("/data/accounts/acct-b")

    releaseA?.()
    releaseB?.()
    const [resA, resB] = await Promise.all([a, b])
    await resA.text()
    await resB.text()

    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.inFlightFor("acct-a")).toBe(0)
    expect(concurrency.inFlightFor("acct-b")).toBe(0)
  })
})

describe("permits never leak, even when the launch itself is what throws", () => {
  test("a throw between the acquire and the stream hands both permits back", async () => {
    const concurrency = createSdkConcurrency({ global: 4, perAccount: 2 })
    const spy = spyQuery()
    const { invoke } = invoker(spy, concurrency)

    // A signal-shaped object with no `addEventListener`: the concurrency gate admits it (a free
    // permit only reads `.aborted`), and `createQueryLaunch` then throws wiring the abort bridge —
    // after the permits were granted, before any stream existed whose end could release them.
    // Before the fix, four of these wedged the account forever and ten wedged the replica.
    const broken = { aborted: false } as unknown as AbortSignal
    await expect(invoke(invocation({ signal: broken }))).rejects.toThrow()

    expect(spy.options).toHaveLength(0)
    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.inFlightFor("sub-1")).toBe(0)
  })
})

describe("a busy session is retried once, in place, as a fork", () => {
  const RESUME = {
    kind: "resume",
    sdkSessionId: "sess_9",
    lineage: "continuation",
    deltaFrom: 0,
  } as const
  const BUSY = "Session sess_9 is currently running as a background agent"

  const busyStream = (): AsyncIterable<unknown> => ({
    // biome-ignore lint/correctness/useYield: the CLI's refusal is thrown before any output.
    async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
      throw new Error(BUSY)
    },
  })

  /** Like {@link spyQuery}, but each call gets its own stream — the busy-then-served shape. */
  function spySequence(streams: readonly (() => AsyncIterable<unknown>)[]): Spy {
    const options: Options[] = []
    const prompts: unknown[] = []
    let call = 0

    return {
      options,
      prompts,
      query: ({ prompt, options: launched }) => {
        options.push(launched)
        const stream = streams[Math.min(call, streams.length - 1)] ?? busyStream
        call += 1
        return {
          async *[Symbol.asyncIterator]() {
            for await (const message of prompt) prompts.push(message)
            yield* stream()
          },
        }
      },
    }
  }

  test("the retry launches the same session with forkSession, and it serves the answer", async () => {
    const concurrency = createSdkConcurrency({ global: 4, perAccount: 2 })
    const spy = spySequence([busyStream, () => sdkQueryStream({ turns: [ONE_TURN] })])
    const { invoke } = invoker(spy, concurrency)

    const response = await invoke(invocation({ session: RESUME }))
    expect(response.status).toBe(200)
    const answered = (await response.json()) as Record<string, unknown>
    expect(answered.content).toEqual([{ type: "text", text: "pong" }])

    expect(spy.options).toHaveLength(2)
    // First attempt: the plan verbatim. Second: the same session, forked at the tip — no rewind
    // point, because nothing was undone; the fork inherits the full history warm.
    expect(spy.options[0]?.resume).toBe("sess_9")
    expect(spy.options[0]?.forkSession).toBeUndefined()
    expect(spy.options[1]?.resume).toBe("sess_9")
    expect(spy.options[1]?.forkSession).toBe(true)
    expect(spy.options[1]).not.toHaveProperty("resumeSessionAt")

    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.inFlightFor("sub-1")).toBe(0)
  })

  test("one retry, not a loop: a fork that comes back busy is a real failure", async () => {
    const concurrency = createSdkConcurrency({ global: 4, perAccount: 2 })
    const spy = spySequence([busyStream, busyStream])
    const { invoke } = invoker(spy, concurrency)

    await expect(invoke(invocation({ session: RESUME }))).rejects.toThrow("background agent")
    expect(spy.options).toHaveLength(2)
    expect(concurrency.inFlight).toBe(0)
  })

  test("only a resume plan retries — fresh cannot be busy, a fork already forked", async () => {
    for (const session of [
      FRESH,
      { kind: "fork", sdkSessionId: "sess_9", resumeSessionAt: "uuid-7", deltaFrom: 0 } as const,
    ]) {
      const spy = spySequence([busyStream])
      const { invoke } = invoker(spy)

      await expect(invoke(invocation({ session }))).rejects.toThrow("background agent")
      expect(spy.options).toHaveLength(1)
    }
  })

  test("a non-busy failure of a resume is not retried in place", async () => {
    const spy = spySequence([
      (): AsyncIterable<unknown> => ({
        // biome-ignore lint/correctness/useYield: the failure is the point.
        async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
          throw new Error("Claude AI usage limit reached")
        },
      }),
    ])
    const { invoke } = invoker(spy)

    await expect(invoke(invocation({ session: RESUME }))).rejects.toThrow("usage limit reached")
    expect(spy.options).toHaveLength(1)
  })

  test("once bytes are on the wire there is no retry — the failure is a terminal frame", async () => {
    const midStream = (): AsyncIterable<unknown> => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "system", subtype: "init", session_id: "sess_9" }
        yield wireEvent({
          type: "message_start",
          message: { id: "msg_1", type: "message", role: "assistant", content: [] },
        })
        yield wireEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })
        throw new Error(BUSY)
      },
    })

    const spy = spySequence([midStream])
    const { invoke } = invoker(spy)
    const response = await invoke(
      invocation({
        session: RESUME,
        body: body({ messages: [{ role: "user", content: "ping" }], stream: true }),
      }),
    )

    // The stream had already started, so the busy failure arrives as a terminal error frame in
    // the one response — never as a second query() behind the client's back.
    expect(response.status).toBe(200)
    const sse = await response.text()
    expect(sse).toContain("event: message_start")
    expect(sse).toContain("event: error")
    expect(spy.options).toHaveLength(1)
  })
})

describe("a router with no usable claude binary", () => {
  test("fails by name, spawns nothing, and never takes a slot", async () => {
    const concurrency = createSdkConcurrency({ global: 4, perAccount: 2 })
    const spy = spyQuery()
    const invoke = createSdkInvoker({
      concurrency,
      runQuery: spy.query,
      resolveCli: () => ({
        ok: false,
        attempts: [{ source: "path_lookup", path: null, rejection: "unresolved" }],
      }),
    })

    await expect(invoke(invocation())).rejects.toThrow("no usable claude binary")
    expect(spy.options).toHaveLength(0)
    expect(concurrency.inFlight).toBe(0)
  })

  test("a resolution that succeeded once is not walked again on the next request", async () => {
    let walks = 0
    const spy = spyQuery()
    const invoke = createSdkInvoker({
      concurrency: createSdkConcurrency({ global: 4, perAccount: 2 }),
      runQuery: spy.query,
      resolveCli: () => {
        walks += 1
        return CLI
      },
    })

    await (await invoke(invocation())).text()
    await (await invoke(invocation())).text()

    expect(walks).toBe(1)
  })
})

describe("what a failure carries to the classifier", () => {
  test("the subprocess's stderr tail rides the error, so a crash is not read as an auth failure", async () => {
    const spy: Spy = {
      options: [],
      prompts: [],
      query: ({ options }) => {
        options.stderr?.("node: symbol lookup error: /opt/claude/claude\n")
        return {
          // biome-ignore lint/correctness/useYield: the throw is what this fixture exists to do.
          async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
            throw new Error("process exited with code 1")
          },
        }
      },
    }

    const { invoke } = invoker(spy)
    const failure = await invoke(invocation()).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(Reflect.get(failure as object, "message")).toBe("process exited with code 1")
    expect(Reflect.get(failure as object, "stderr")).toContain("symbol lookup error")
  })

  test("an error that already carries stderr keeps its own", async () => {
    const spy: Spy = {
      options: [],
      prompts: [],
      query: ({ options }) => {
        options.stderr?.("router-collected")
        return {
          // biome-ignore lint/correctness/useYield: the throw is what this fixture exists to do.
          async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
            throw Object.assign(new Error("exited with code 1"), { stderr: "sdk-collected" })
          },
        }
      },
    }

    const { invoke } = invoker(spy)
    const failure = await invoke(invocation()).catch((error: unknown) => error)
    expect(Reflect.get(failure as object, "stderr")).toBe("sdk-collected")
  })
})
