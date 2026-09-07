import { describe, expect, test } from "bun:test"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import {
  type CliResolution,
  type CredentialFreshness,
  createSdkConcurrency,
  createSdkModelLister,
  type IdleQuery,
  PERMITTED_TOOLS,
  type SdkModelListUnavailable,
} from "../../../src/providers"

/**
 * The subscription model lister: what one Claude subscription can be asked for, read from the
 * Agent SDK's `system/init` handshake without a turn ever being sent.
 *
 * **No `claude` CLI is spawned here, and none may ever be** (CLAUDE.md testing rules): the
 * executable-resolution ladder and `query()` are both injected, so what runs is the real lister
 * with the subprocess replaced by a fake that answers `supportedModels()`.
 *
 * The isolation assertion at the bottom is a **security regression gate** (non-negotiable 2): this
 * is the third `query()` call site in the codebase, and it must carry exactly the flags the other
 * two do. Never skip, quarantine, or relax it.
 */

const CLI: CliResolution = {
  ok: true,
  source: "platform_package",
  path: "/opt/claude/claude",
  bytes: 245_000_000,
}

const LIVE = [
  { value: "claude-opus-5", displayName: "Opus 5", description: "" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "" },
]

interface Spy {
  readonly launches: Options[]
  returned: number
  /** Whether the launch's own `AbortController` fired — the subprocess kill switch. */
  aborted: boolean
  /** Whether the prompt stream was pulled from: a turn would have to be. */
  promptPulled: boolean
}

function listerWith(options: {
  readonly answer?: () => Promise<unknown>
  readonly resolveCli?: () => CliResolution
  readonly concurrency?: ReturnType<typeof createSdkConcurrency>
  readonly returnFails?: boolean
  readonly freshness?: CredentialFreshness
}) {
  const spy: Spy = { launches: [], returned: 0, aborted: false, promptPulled: false }
  const reasons: SdkModelListUnavailable[] = []
  const concurrency = options.concurrency ?? createSdkConcurrency({ global: 4, perAccount: 2 })

  const lister = createSdkModelLister({
    cliPathOverride: null,
    concurrency,
    resolveCli: options.resolveCli ?? (() => CLI),
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
    onUnavailable: (reason) => reasons.push(reason),
    runQuery: ({ prompt, options: sdkOptions }) => {
      spy.launches.push(sdkOptions)
      sdkOptions.abortController?.signal.addEventListener("abort", () => {
        spy.aborted = true
      })
      // A real SDK reads the prompt in the background; pulling once mirrors that and proves the
      // stream stays open (never resolves) until the lister lets go.
      void prompt[Symbol.asyncIterator]()
        .next()
        .then(() => {
          spy.promptPulled = true
        })
      const fake: IdleQuery = {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            throw new Error("the message stream must never be pulled — that would be a turn")
          },
        }),
        supportedModels: options.answer ?? (async () => LIVE),
        return: async () => {
          spy.returned += 1
          if (options.returnFails === true) throw new Error("already gone")
          return { done: true, value: undefined }
        },
      }
      return fake
    },
  })
  return { lister, spy, reasons, concurrency }
}

const input = (timeoutMs = 5_000) => ({
  accountId: "acc-1",
  configDir: "/data/claude/acc-1",
  timeoutMs,
})

describe("listing a subscription's models through the Agent SDK", () => {
  test("reads the handshake's list, resolutions included, and ends the subprocess", async () => {
    const { lister, spy, concurrency } = listerWith({})

    const listing = await lister.list(input())

    expect(listing).toEqual({
      kind: "listed",
      models: [
        { id: "claude-opus-5", resolvedModel: null, displayName: "Opus 5" },
        { id: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
      ],
    })
    // Both halves of "end it": the generator's own cleanup and the kill switch.
    expect(spy.returned).toBe(1)
    expect(spy.aborted).toBe(true)
    // And the slot is back — a leaked permit shrinks the ceiling for the life of the process.
    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.inFlightFor("acc-1")).toBe(0)
  })

  test("never sends a turn: the prompt stream is released only after the answer is in", async () => {
    const { lister, spy } = listerWith({})
    await lister.list(input())
    // Released in `finally` — the fake pulled once and saw the stream end, not a message.
    await Promise.resolve()
    expect(spy.promptPulled).toBe(true)
    expect(spy.launches[0]?.maxTurns).toBe(1)
  })

  test("a handshake that outlives the deadline is null, and the subprocess still dies", async () => {
    const { lister, spy, reasons } = listerWith({ answer: () => new Promise(() => {}) })

    const listing = await lister.list(input(20))

    expect(listing).toBeNull()
    expect(reasons).toEqual(["timeout"])
    expect(spy.aborted).toBe(true)
    expect(spy.returned).toBe(1)
  })

  test("an auth failure is reported as such, so a caller can tell a dead credential from a slow one", async () => {
    const { lister, reasons } = listerWith({
      answer: () => Promise.reject(new Error("Invalid API key · Please run /login")),
    })

    expect(await lister.list(input())).toEqual({ kind: "auth" })
    expect(reasons).toEqual([])
  })

  /**
   * The 2026-09-06/07 regression: a listing spawned inside the CLI's refresh window was ended before
   * the rotated refresh token was written, and the account was deauthenticated by the next turn.
   * A cold credential is its own answer — not `null`, which would write the shipped table over a
   * live listing — and it costs no spawn and no slot.
   */
  test("a cold credential is reported as cold, and nothing is spawned for it", async () => {
    const { lister, spy, reasons, concurrency } = listerWith({
      freshness: {
        ensureFresh: async () => {},
        wouldRefresh: async () => true,
      },
    })

    const listing = await lister.list(input())

    expect(listing).toEqual({ kind: "cold" })
    expect(spy.launches).toEqual([])
    expect(reasons).toEqual([])
    expect(concurrency.inFlight).toBe(0)
  })

  test("any other throw is null, with the upstream's words kept for the log only", async () => {
    const { lister, reasons } = listerWith({
      answer: () => Promise.reject(new Error("Claude Code process exited with code 1")),
    })

    expect(await lister.list(input())).toBeNull()
    expect(reasons).toEqual(["failed"])
  })

  test("a malformed answer is null rather than a crash", async () => {
    const { lister, reasons } = listerWith({ answer: async () => ({ models: "nope" }) })
    expect(await lister.list(input())).toBeNull()
    expect(reasons).toEqual(["malformed"])
  })

  test("entries without an id are dropped, duplicates collapse, and an empty result is null", async () => {
    const tolerant = listerWith({
      answer: async () => [
        { value: "  claude-opus-5 " },
        { value: "claude-opus-5", displayName: "second copy" },
        { displayName: "no id at all" },
        { value: 42 },
      ],
    })
    expect(await tolerant.lister.list(input())).toEqual({
      kind: "listed",
      models: [{ id: "claude-opus-5", resolvedModel: null, displayName: null }],
    })

    const empty = listerWith({ answer: async () => [{ displayName: "nothing usable" }] })
    expect(await empty.lister.list(input())).toBeNull()
    expect(empty.reasons).toEqual(["empty"])
  })

  test("occupies no slot to discover it has no binary to spawn", async () => {
    const { lister, spy, reasons, concurrency } = listerWith({
      resolveCli: () => ({ ok: false, attempts: [] }),
    })

    expect(await lister.list(input())).toBeNull()
    expect(reasons).toEqual(["no_cli"])
    expect(spy.launches).toHaveLength(0)
    expect(concurrency.inFlight).toBe(0)
  })

  test("counts against the same subprocess ceiling the dispatch path counts against", async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    let release = (): void => {}
    const held = new Promise<unknown>((resolve) => {
      release = () => resolve(LIVE)
    })
    const holder = listerWith({ concurrency, answer: () => held })
    const waiter = listerWith({ concurrency })

    const running = holder.lister.list(input())
    await Promise.resolve()
    // A different account, so only the global gate can be what stops it; a short deadline, so the
    // wait is what ends it.
    const queued = await waiter.lister.list({ ...input(20), accountId: "acc-2" })

    expect(queued).toBeNull()
    expect(waiter.reasons).toEqual(["at_ceiling"])
    expect(waiter.spy.launches).toHaveLength(0)

    release()
    expect(await running).toMatchObject({ kind: "listed" })
    expect(concurrency.inFlight).toBe(0)
  })

  test("a cleanup that itself fails still hands the slot back", async () => {
    const { lister, concurrency } = listerWith({ returnFails: true })
    expect(await lister.list(input())).toMatchObject({ kind: "listed" })
    expect(concurrency.inFlight).toBe(0)
  })

  /**
   * **Security regression gate** — CLAUDE.md non-negotiable 2. The handshake spawns the CLI against
   * the operator's own credential directory; it gets exactly the sandbox a real request gets.
   */
  test("runs the subprocess under the same isolation the dispatch path uses", async () => {
    const { lister, spy } = listerWith({})
    await lister.list(input())

    const launched = spy.launches[0]
    expect(launched).toBeDefined()
    if (launched === undefined) return
    expect(launched.settingSources).toEqual([])
    expect(launched.strictMcpConfig).toBe(true)
    expect(launched.skills).toEqual([])
    expect(launched.tools).toEqual([])
    // The shared reviewed constant, not a second literal that could drift from the dispatch path.
    expect(launched.allowedTools).toEqual([...PERMITTED_TOOLS])
    expect(launched.permissionMode).toBe("dontAsk")
    expect(launched.cwd).toBe("/data/claude/acc-1")
    expect(launched.pathToClaudeCodeExecutable).toBe("/opt/claude/claude")
    // Deny-all: a handshake grants nothing, and the gate says so rather than leaving it to a default.
    const canUseTool = launched.canUseTool
    expect(canUseTool).toBeDefined()
    if (canUseTool === undefined) return
    for (const tool of ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]) {
      expect(await canUseTool(tool, {}, { signal: new AbortController().signal })).toMatchObject({
        behavior: "deny",
      })
    }
    // The forced query overrides ride here too — same doors, same request class (`env.ts`).
    const env = launched.env as Record<string, string>
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/claude/acc-1")
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false")
    expect(env.CLAUDE_CODE_SESSION_KIND).toBe("bg")
    expect(Object.keys(env).some((name) => name.startsWith("ANTHROPIC_"))).toBe(false)
  })
})
