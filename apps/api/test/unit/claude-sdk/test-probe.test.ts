import { describe, expect, test } from "bun:test"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type CliResolution,
  createSdkConcurrency,
  createSdkTestProbe,
  PERMITTED_TOOLS,
  type SdkConcurrency,
} from "../../../src/providers"

/**
 * The console's "Test now" probe, and specifically the two things about it that are not the SDK's
 * business: it runs inside the **same** subprocess ceiling the dispatch path runs inside, and it
 * carries the same isolation flags a real request does.
 *
 * The gate is what these tests exist for. `test-now.ts`'s cooldown is per Account, so it stops
 * nobody from pressing the button on ten Accounts at once — and ten ungated presses are ten ~245 MB
 * `claude` processes past whatever ceiling the operator configured, which is the OOM
 * `concurrency.ts` exists to prevent (docs/idea/11-anthropic-agent-sdk.md §9).
 *
 * **No `claude` CLI is spawned here, and none may ever be** (CLAUDE.md testing rules): both the
 * executable-resolution ladder and `query()` are injected, so what runs is the real probe with the
 * subprocess replaced by a fixture stream.
 */

const CLI: CliResolution = {
  ok: true,
  source: "platform_package",
  path: "/opt/claude/claude",
  bytes: 245_000_000,
}

function pong(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "pong",
    duration_ms: 12,
    duration_api_ms: 10,
    num_turns: 1,
    session_id: "sess-1",
    total_cost_usd: 0,
    usage: { input_tokens: 4, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
    uuid: "11111111-1111-4111-8111-111111111111",
  } as unknown as SDKMessage
}

interface Spy {
  readonly launches: Options[]
  /** In-flight subprocesses observed from *inside* a turn — the number the ceiling bounds. */
  readonly peakInFlight: number
}

/** A probe whose "subprocess" stays open until `release` is called, so occupancy is observable. */
function probeWith(
  concurrency: SdkConcurrency,
  options: { readonly hold?: Promise<void>; readonly resolveCli?: () => CliResolution } = {},
) {
  const spy = { launches: [] as Options[], peakInFlight: 0 }
  const probe = createSdkTestProbe({
    cliPathOverride: null,
    concurrency,
    resolveCli: options.resolveCli ?? (() => CLI),
    runQuery: async function* ({ options: sdkOptions }) {
      spy.launches.push(sdkOptions)
      spy.peakInFlight = Math.max(spy.peakInFlight, concurrency.inFlight)
      if (options.hold !== undefined) await options.hold
      yield pong()
    },
  })
  return { probe, spy: spy as Spy }
}

describe("the Agent-SDK test probe", () => {
  test("takes a subprocess slot for the turn, and hands it back after", async () => {
    const concurrency = createSdkConcurrency({ global: 4, perAccount: 2 })
    const { probe, spy } = probeWith(concurrency)

    const result = await probe.run({
      accountId: "acc-1",
      configDir: "/data/claude/acc-1",
      model: "claude-sonnet-4-5",
      signal: AbortSignal.timeout(5_000),
    })

    expect(result.ok).toBe(true)
    expect(result.message).toBe("pong")
    // Held while the subprocess ran…
    expect(spy.peakInFlight).toBe(1)
    // …and released once it did not.
    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.inFlightFor("acc-1")).toBe(0)
  })

  test("counts against the same ceiling the dispatch path counts against", async () => {
    // One permit for the whole replica: whoever is holding it, nobody else spawns.
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = probeWith(concurrency, { hold: held })
    const second = probeWith(concurrency)

    const running = first.probe.run({
      accountId: "acc-1",
      configDir: "/data/claude/acc-1",
      model: "claude-sonnet-4-5",
      signal: AbortSignal.timeout(5_000),
    })
    await Promise.resolve()

    // A *different* Account, so only the global gate can be what stops it.
    const queued = second.probe.run({
      accountId: "acc-2",
      configDir: "/data/claude/acc-2",
      model: "claude-sonnet-4-5",
      signal: AbortSignal.timeout(5_000),
    })
    await Promise.resolve()

    expect(concurrency.inFlight).toBe(1)
    expect(second.spy.launches).toHaveLength(0)

    release()
    await running
    await queued

    expect(second.spy.launches).toHaveLength(1)
    expect(concurrency.inFlight).toBe(0)
  })

  test("names the ceiling when the wait for a slot outlives the deadline", async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const holder = probeWith(concurrency, { hold: held })
    const waiter = probeWith(concurrency)

    const running = holder.probe.run({
      accountId: "acc-1",
      configDir: "/data/claude/acc-1",
      model: "claude-sonnet-4-5",
      signal: AbortSignal.timeout(5_000),
    })
    await Promise.resolve()

    const result = await waiter.probe.run({
      accountId: "acc-2",
      configDir: "/data/claude/acc-2",
      model: "claude-sonnet-4-5",
      signal: AbortSignal.timeout(20),
    })

    expect(result.ok).toBe(false)
    // The knob, not the symptom: "timed out" would send an operator to check their subscription.
    expect(result.message).toContain("CLAUDE_SDK_MAX_CONCURRENCY")
    // Nothing spawned, so nothing leaked.
    expect(waiter.spy.launches).toHaveLength(0)

    release()
    await running
    expect(concurrency.inFlight).toBe(0)
  })

  test("occupies no slot to discover it has no binary to spawn", async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const { probe, spy } = probeWith(concurrency, {
      resolveCli: () => ({ ok: false, attempts: [] }),
    })

    const result = await probe.run({
      accountId: "acc-1",
      configDir: "/data/claude/acc-1",
      model: "claude-sonnet-4-5",
      signal: AbortSignal.timeout(5_000),
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("no usable claude binary")
    expect(spy.launches).toHaveLength(0)
    expect(concurrency.inFlight).toBe(0)
  })

  test("hands the slot back when the turn throws", async () => {
    const concurrency = createSdkConcurrency({ global: 2, perAccount: 1 })
    const probe = createSdkTestProbe({
      cliPathOverride: null,
      concurrency,
      resolveCli: () => CLI,
      // A subprocess that died before it said anything: the iterator opens and the first pull
      // rejects, which is the shape the SDK surfaces a spawn failure in.
      runQuery: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error("Claude Code process exited with code 1")),
        }),
      }),
    })

    const result = await probe.run({
      accountId: "acc-1",
      configDir: "/data/claude/acc-1",
      model: "claude-sonnet-4-5",
      signal: AbortSignal.timeout(5_000),
    })

    expect(result.ok).toBe(false)
    // A leaked permit shrinks the ceiling by one for the life of the process.
    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.inFlightFor("acc-1")).toBe(0)
  })

  test("runs the subprocess under the same isolation the dispatch path uses", async () => {
    const concurrency = createSdkConcurrency({ global: 2, perAccount: 1 })
    const { probe, spy } = probeWith(concurrency)

    await probe.run({
      accountId: "acc-1",
      configDir: "/data/claude/acc-1",
      model: "claude-sonnet-4-5",
      signal: AbortSignal.timeout(5_000),
    })

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
    // The model the operator asked about, never a substitute.
    expect(launched.model).toBe("claude-sonnet-4-5")
    expect(launched.cwd).toBe("/data/claude/acc-1")
    // The forced query overrides ride the probe too — same doors, same request class (`env.ts`).
    const env = launched.env as Record<string, string>
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false")
    expect(env.CLAUDE_CODE_SESSION_KIND).toBe("bg")
  })
})

/**
 * What a spent subscription and a healthy one actually put on the wire, recorded from SDK 0.3.220
 * against live accounts.
 *
 * Two behaviours are pinned here because both were silently wrong, and both cost the operator the
 * answer they pressed the button for:
 *
 * 1. A spent window arrives as `subtype: "success"` with `is_error: true` and the reason in
 *    `result`. Rendering the subtype produced the literal self-contradiction "the Claude Agent SDK
 *    turn did not succeed (success)" while discarding the only field that explained it.
 * 2. The SDK volunteers `rate_limit_event` on *every* turn, not only near a limit. The probe bills a
 *    real turn to obtain it and used to throw it away, so the console's quota windows stayed empty
 *    until unrelated traffic happened to route through the account.
 */
describe("what the probe reports back", () => {
  const rateLimitEvent = (info: Record<string, unknown>): SDKMessage =>
    ({
      type: "rate_limit_event",
      // The SDK's own snake_case field — the probe consumes raw SDK messages, not the normalized
      // stream `render/events.ts` builds for the dispatch path.
      rate_limit_info: info,
      uuid: "22222222-2222-4222-8222-222222222222",
      session_id: "sess-1",
    }) as unknown as SDKMessage

  const erroredResult = (result: string): SDKMessage =>
    ({
      type: "result",
      subtype: "success",
      is_error: true,
      result,
      duration_ms: 9,
      duration_api_ms: 8,
      num_turns: 1,
      session_id: "sess-1",
      total_cost_usd: 0,
      usage: { input_tokens: 4, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: "33333333-3333-4333-8333-333333333333",
    }) as unknown as SDKMessage

  function probeOver(messages: readonly SDKMessage[]) {
    return createSdkTestProbe({
      cliPathOverride: null,
      concurrency: createSdkConcurrency({ global: 4, perAccount: 2 }),
      resolveCli: () => CLI,
      runQuery: async function* () {
        for (const message of messages) yield message
      },
    })
  }

  const run = (messages: readonly SDKMessage[]) =>
    probeOver(messages).run({
      accountId: "acct-1",
      configDir: "/data/claude/acct-1",
      model: "claude-sonnet-4-5-20250929",
      signal: AbortSignal.timeout(5_000),
    })

  test("a spent window reports what the account said, not the subtype that contradicts it", async () => {
    const result = await run([erroredResult("Claude AI usage limit reached|1785204600")])

    expect(result.ok).toBe(false)
    // The dispatch path's own wording for the same condition — one condition, one sentence.
    expect(result.message).toBe("the account's Claude subscription window is spent")
    expect(result.message).not.toContain("(success)")
  })

  /**
   * The field that makes an *unclassified* failure diagnosable. `message` is router-authored, so
   * without this the only record of a reason no rule matched is the router saying it did not
   * recognize one — a tautology, and a dead end for whoever has to add the rule.
   */
  test("the upstream's own words come back for the log, even when no rule matched", async () => {
    const result = await run([erroredResult("Something entirely new went wrong upstream")])

    expect(result.ok).toBe(false)
    expect(result.message).toContain("does not recognize")
    expect(result.reasonDetail).toBe("Something entirely new went wrong upstream")
  })

  test("a success carries no reason detail — there is nothing to diagnose", async () => {
    expect((await run([pong()])).reasonDetail).toBeUndefined()
  })

  test("the quota readings the turn paid for come back for the caller to ingest", async () => {
    const info = { status: "allowed", rateLimitType: "five_hour", resetsAt: 1_785_204_600 }
    const result = await run([rateLimitEvent(info), pong()])

    expect(result.ok).toBe(true)
    expect(result.rateLimitInfos).toEqual([info])
  })

  test("readings are kept oldest-first even when the turn ends spent", async () => {
    const first = { status: "allowed_warning", rateLimitType: "five_hour" }
    const second = { status: "rejected", rateLimitType: "five_hour" }
    const result = await run([
      rateLimitEvent(first),
      rateLimitEvent(second),
      erroredResult("Claude AI usage limit reached"),
    ])

    expect(result.ok).toBe(false)
    expect(result.rateLimitInfos).toEqual([first, second])
  })

  test("a turn with nothing quotable still names its subtype rather than saying nothing", async () => {
    const result = await run([
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        duration_ms: 5,
        duration_api_ms: 4,
        num_turns: 1,
        session_id: "sess-1",
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        uuid: "44444444-4444-4444-8444-444444444444",
      } as unknown as SDKMessage,
    ])

    expect(result.ok).toBe(false)
    expect(result.message).toContain("error_max_turns")
  })

  test("a healthy turn still answers with the model's own reply, and an empty reading list", async () => {
    const result = await run([pong()])

    expect(result).toMatchObject({ ok: true, message: "pong", rateLimitInfos: [] })
  })
})

describe("the usage gauge on a probe turn", () => {
  test("is asked of the query object after the answer, and the probe waits for it", async () => {
    const observed: { accountId: string; source: unknown }[] = []
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant", message: { content: [] } } as unknown as SDKMessage
        yield pong()
      },
    }
    const probe = createSdkTestProbe({
      cliPathOverride: null,
      concurrency: createSdkConcurrency({ global: 4, perAccount: 2 }),
      resolveCli: () => CLI,
      runQuery: () => stream,
      usageGauge: {
        observe: async (accountId, source) => {
          observed.push({ accountId, source })
        },
      },
    })

    const result = await probe.run({
      accountId: "acc-1",
      configDir: "/data/claude/acc-1",
      model: "claude-sonnet-4-5",
      signal: AbortSignal.timeout(5_000),
    })

    expect(result.ok).toBe(true)
    expect(observed).toEqual([{ accountId: "acc-1", source: stream }])
  })
})
