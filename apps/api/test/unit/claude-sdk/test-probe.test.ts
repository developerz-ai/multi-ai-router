import { describe, expect, test } from "bun:test"
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type CliResolution,
  createSdkConcurrency,
  createSdkTestProbe,
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
    expect(launched.allowedTools).toEqual([])
    expect(launched.permissionMode).toBe("dontAsk")
    // The model the operator asked about, never a substitute.
    expect(launched.model).toBe("claude-sonnet-4-5")
    expect(launched.cwd).toBe("/data/claude/acc-1")
  })
})
