import { describe, expect, test } from "bun:test"
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type CredentialFreshness,
  createSdkConcurrency,
  type IdleQuery,
  IdleQueryColdCredentialError,
  IdleQueryTimeoutError,
  openIdleQuery,
  PERMITTED_TOOLS,
} from "../../../src/providers"

/**
 * The turn-free `query()`: a subprocess that comes up, completes its handshake, and is read without
 * a message ever being sent. Two things are pinned here that the callers (the model lister, the
 * usage-gauge read) rely on without being able to prove themselves:
 *
 * 1. **Nothing is sent and nothing is billed.** The prompt stream yields zero user messages for the
 *    life of the query, and the message iterator — where a `result` turn would arrive — is never
 *    even pulled. If the SDK ever needed a turn to answer, this file is what fails.
 * 2. **The sandbox is the dispatch path's** (CLAUDE.md non-negotiable 2). This is a `query()` call
 *    site like `options.ts` and `test-probe.ts`, and it carries exactly the same flags. The gate
 *    assertion at the bottom is a security regression gate: never skip, quarantine, or relax it.
 *
 * **No `claude` CLI is spawned here, and none may ever be.** `runQuery` is a fake throughout.
 */

interface Fake {
  readonly launches: Options[]
  /** User messages the SDK side pulled off the prompt stream. Must stay at zero. */
  yielded: SDKUserMessage[]
  /** Whether the prompt stream ended (the hold was released). */
  promptEnded: boolean
  /** Pulls on the SDK message iterator — where a `result` turn would come from. Must stay at zero. */
  messagePulls: number
  returned: number
  aborted: boolean
}

function fakeQuery(
  options: { readonly ready?: () => Promise<unknown>; readonly withoutInit?: boolean } = {},
) {
  const fake: Fake = {
    launches: [],
    yielded: [],
    promptEnded: false,
    messagePulls: 0,
    returned: 0,
    aborted: false,
  }
  const runQuery = ({
    prompt,
    options: sdkOptions,
  }: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }): IdleQuery => {
    fake.launches.push(sdkOptions)
    sdkOptions.abortController?.signal.addEventListener("abort", () => {
      fake.aborted = true
    })
    // Consume the prompt the way the real SDK does — in the background, for the query's lifetime.
    void (async () => {
      for await (const message of prompt) fake.yielded.push(message)
      fake.promptEnded = true
    })()
    const query: IdleQuery = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          fake.messagePulls += 1
          return new Promise(() => {})
        },
      }),
      supportedModels: async () => [{ value: "claude-opus-5" }],
      return: async () => {
        fake.returned += 1
        return { done: true, value: undefined }
      },
      ...(options.withoutInit === true
        ? {}
        : { initializationResult: options.ready ?? (async () => ({ models: [] })) }),
    }
    return query
  }
  return { fake, runQuery }
}

const open = (
  runQuery: ReturnType<typeof fakeQuery>["runQuery"],
  overrides: {
    timeoutMs?: number
    concurrency?: ReturnType<typeof createSdkConcurrency>
    freshness?: CredentialFreshness
  } = {},
) =>
  openIdleQuery({
    accountId: "acc-1",
    configDir: "/data/claude/acc-1",
    cliPath: "/opt/claude/claude",
    concurrency: overrides.concurrency ?? createSdkConcurrency({ global: 4, perAccount: 2 }),
    timeoutMs: overrides.timeoutMs ?? 5_000,
    runQuery,
    ...(overrides.freshness === undefined ? {} : { freshness: overrides.freshness }),
  })

/** A freshness gate whose answers are scripted, in order, and which counts what it was asked. */
function scriptedFreshness(answers: readonly boolean[]) {
  const asked: string[] = []
  let calls = 0
  const gate: CredentialFreshness = {
    ensureFresh: async () => {
      throw new Error("an idle query must never enter the refresh window")
    },
    wouldRefresh: async (accountId) => {
      asked.push(accountId)
      const answer = answers[calls] ?? answers[answers.length - 1] ?? false
      calls += 1
      return answer
    },
  }
  return { gate, asked }
}

describe("an idle Agent SDK query", () => {
  test("is ready once the handshake is, and sends no turn for its whole life", async () => {
    const { fake, runQuery } = fakeQuery()
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })

    const handle = await open(runQuery, { concurrency })
    expect(concurrency.inFlight).toBe(1)
    expect(await handle.query.supportedModels?.()).toEqual([{ value: "claude-opus-5" }])

    await handle.close()
    await Promise.resolve()

    // The operator's rule, verbatim: zero user messages reached the SDK, and the message stream a
    // `result` turn would ride was never pulled. Nothing was billed because nothing was asked.
    expect(fake.yielded).toEqual([])
    expect(fake.messagePulls).toBe(0)
    // And it is over: the hold released, the kill switch fired, the generator cleaned up, the slot
    // back in the pool.
    expect(fake.promptEnded).toBe(true)
    expect(fake.aborted).toBe(true)
    expect(fake.returned).toBe(1)
    expect(concurrency.inFlight).toBe(0)
  })

  test("close() is idempotent — a caller's finally and an error path may both call it", async () => {
    const { fake, runQuery } = fakeQuery()
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const handle = await open(runQuery, { concurrency })

    await handle.close()
    await handle.close()

    expect(fake.returned).toBe(1)
    expect(concurrency.inFlight).toBe(0)
  })

  test("a handshake that outlives the deadline throws a timeout, and nothing leaks", async () => {
    const { fake, runQuery } = fakeQuery({ ready: () => new Promise(() => {}) })
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })

    const error = await open(runQuery, { concurrency, timeoutMs: 20 }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(IdleQueryTimeoutError)
    expect((error as IdleQueryTimeoutError).phase).toBe("handshake")
    expect(fake.aborted).toBe(true)
    expect(fake.returned).toBe(1)
    expect(concurrency.inFlight).toBe(0)
  })

  test("waiting for a slot past the deadline is the ceiling's fault, and says so", async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const holder = await open(fakeQuery().runQuery, { concurrency })

    const error = await open(fakeQuery().runQuery, { concurrency, timeoutMs: 20 }).catch(
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(IdleQueryTimeoutError)
    expect((error as IdleQueryTimeoutError).phase).toBe("queued")
    expect((error as Error).message).toContain("CLAUDE_SDK_MAX_CONCURRENCY")

    await holder.close()
    expect(concurrency.inFlight).toBe(0)
  })

  test("a handshake that fails rethrows the SDK's own error after cleaning up", async () => {
    const { fake, runQuery } = fakeQuery({
      ready: () => Promise.reject(new Error("Claude Code process exited with code 1")),
    })
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })

    await expect(open(runQuery, { concurrency })).rejects.toThrow("exited with code 1")
    expect(fake.returned).toBe(1)
    expect(concurrency.inFlight).toBe(0)
  })

  test("the deadline it was opened under is the deadline every later read gets", async () => {
    const { runQuery } = fakeQuery()
    const handle = await open(runQuery, { timeoutMs: 20 })

    expect(handle.timedOut()).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(handle.signal.aborted).toBe(true)
    expect(handle.timedOut()).toBe(true)

    await handle.close()
  })

  test("a query object with no handshake method is ready at once — a fake may be that small", async () => {
    const handle = await open(fakeQuery({ withoutInit: true }).runQuery)
    expect(handle.query.supportedModels).toBeDefined()
    await handle.close()
  })

  /**
   * The 2026-09-06/07 regression. The CLI refreshes at startup inside its own lead and persists the
   * rotated refresh token only after the token endpoint answers; an idle query is ended before that
   * write, the token on disk is spent, and the next process to present it blanks the credential.
   * So a cold credential must produce **no spawn at all** — not a spawn that is closed carefully.
   */
  test("refuses to spawn against a cold credential — nothing launched, no slot held", async () => {
    const { fake, runQuery } = fakeQuery()
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const { gate, asked } = scriptedFreshness([true])

    const error = await open(runQuery, { concurrency, freshness: gate }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(IdleQueryColdCredentialError)
    expect(fake.launches).toEqual([])
    expect(asked).toEqual(["acc-1"])
    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.queued).toBe(0)
  })

  test("asks again once it holds a slot — a token warm when it queued can be cold when it may spawn", async () => {
    const { fake, runQuery } = fakeQuery()
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const { gate, asked } = scriptedFreshness([false, true])

    const error = await open(runQuery, { concurrency, freshness: gate }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(IdleQueryColdCredentialError)
    expect(asked).toEqual(["acc-1", "acc-1"])
    expect(fake.launches).toEqual([])
    // The slot it took for the second look was handed back.
    expect(concurrency.inFlight).toBe(0)
  })

  test("a warm credential spawns exactly as before, and never enters the refresh window", async () => {
    const { fake, runQuery } = fakeQuery()
    const { gate, asked } = scriptedFreshness([false])

    const handle = await open(runQuery, { freshness: gate })
    await handle.close()

    expect(fake.launches).toHaveLength(1)
    expect(asked).toEqual(["acc-1", "acc-1"])
  })

  /**
   * **Security regression gate** — CLAUDE.md non-negotiable 2. An idle subprocess is still the CLI
   * running against the operator's own credential directory; it gets exactly the sandbox a real
   * request gets, and it gets it from the same reviewed constants.
   */
  test("runs the subprocess under the same isolation the dispatch path uses", async () => {
    const { fake, runQuery } = fakeQuery()
    const handle = await open(runQuery)
    await handle.close()

    const launched = fake.launches[0]
    expect(launched).toBeDefined()
    if (launched === undefined) return
    expect(launched.settingSources).toEqual([])
    expect(launched.strictMcpConfig).toBe(true)
    expect(launched.skills).toEqual([])
    expect(launched.tools).toEqual([])
    expect(launched.allowedTools).toEqual([...PERMITTED_TOOLS])
    expect(launched.permissionMode).toBe("dontAsk")
    expect(launched.cwd).toBe("/data/claude/acc-1")
    expect(launched.pathToClaudeCodeExecutable).toBe("/opt/claude/claude")
    expect(launched.maxTurns).toBe(1)
    // No model: nothing is ever asked of one, so none is named — and none is ever substituted.
    expect(launched.model).toBeUndefined()

    const canUseTool = launched.canUseTool
    expect(canUseTool).toBeDefined()
    if (canUseTool === undefined) return
    for (const tool of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"]) {
      expect(await canUseTool(tool, {}, { signal: new AbortController().signal })).toMatchObject({
        behavior: "deny",
      })
    }

    const env = launched.env as Record<string, string>
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/claude/acc-1")
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false")
    expect(env.CLAUDE_CODE_SESSION_KIND).toBe("bg")
    expect(Object.keys(env).some((name) => name.startsWith("ANTHROPIC_"))).toBe(false)
  })
})
