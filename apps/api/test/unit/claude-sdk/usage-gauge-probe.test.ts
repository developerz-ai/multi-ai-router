import { describe, expect, test } from "bun:test"
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type CliResolution,
  createSdkConcurrency,
  createSdkUsageGauge,
  createSdkUsageGaugeProbe,
  type IdleQuery,
  type SdkUsageGauge,
} from "../../../src/providers"

/**
 * The turn-free usage read for an idle subscription (`usage-gauge-probe.ts`). The property the
 * operator's rule depends on is pinned first: the query it opens is never fed a message, so nothing
 * is billed — the prompt yields nothing and the gauge is asked of the handshake alone.
 */

const CLI: CliResolution = {
  ok: true,
  source: "platform_package",
  path: "/opt/claude/claude",
  bytes: 245_000_000,
}

function fakeQuery() {
  const state = { prompts: [] as SDKUserMessage[], returned: 0, launched: [] as Options[] }
  const runQuery = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage>
    options: Options
  }): IdleQuery => {
    state.launched.push(options)
    void (async () => {
      for await (const message of prompt) state.prompts.push(message)
    })()
    const query: IdleQuery = {
      async *[Symbol.asyncIterator]() {},
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 12, resets_at: null } },
      }),
      return: async () => {
        state.returned += 1
        return undefined
      },
    }
    return query
  }
  return { runQuery, state }
}

function spyGauge(): SdkUsageGauge & {
  readonly observed: { accountId: string; source: unknown }[]
} {
  const observed: { accountId: string; source: unknown }[] = []
  return {
    observed,
    capture: () => undefined,
    observe: async (accountId, source) => {
      observed.push({ accountId, source })
    },
  }
}

describe("the idle usage probe", () => {
  test("opens a query, asks the gauge of it, and closes — with no prompt ever sent", async () => {
    const { runQuery, state } = fakeQuery()
    const gauge = spyGauge()
    const concurrency = createSdkConcurrency({ global: 2, perAccount: 1 })
    const probe = createSdkUsageGaugeProbe({
      gauge,
      concurrency,
      cliPathOverride: null,
      timeoutMs: 1_000,
      resolveCli: () => CLI,
      runQuery,
    })

    const read = await probe.read({ accountId: "sub-1", configDir: "/data/claude/sub-1" })

    expect(read).toBe("read")
    expect(gauge.observed).toHaveLength(1)
    expect(gauge.observed[0]?.accountId).toBe("sub-1")
    // Zero user messages reached the SDK: this is the turn-free property, and the whole point.
    expect(state.prompts).toEqual([])
    expect(state.returned).toBe(1)
    expect(concurrency.inFlight).toBe(0)
    // The same gates every other launcher carries.
    expect(state.launched[0]?.settingSources).toEqual([])
    expect(state.launched[0]?.cwd).toBe("/data/claude/sub-1")
  })

  test("no usable binary means no query and a no_cli answer, never a throw", async () => {
    const { runQuery, state } = fakeQuery()
    const gauge = spyGauge()
    const probe = createSdkUsageGaugeProbe({
      gauge,
      concurrency: createSdkConcurrency({ global: 2, perAccount: 1 }),
      cliPathOverride: "/nope",
      timeoutMs: 1_000,
      resolveCli: () =>
        ({ ok: false, source: "override", reason: "not executable" }) as CliResolution,
      runQuery,
    })

    expect(await probe.read({ accountId: "sub-1", configDir: "/data/claude/sub-1" })).toBe("no_cli")
    expect(gauge.observed).toEqual([])
    expect(state.launched).toEqual([])
  })

  /**
   * The 2026-09-06/07 regression: the gauge's turn-free query, spawned inside the CLI's refresh
   * window, was ended before the rotated refresh token was written. A cold credential gets no
   * query at all — the reading waits for the real turn the sweep spends first.
   */
  test("a cold credential is not read: no query, no slot, and the answer says why", async () => {
    const { runQuery, state } = fakeQuery()
    const gauge = spyGauge()
    const concurrency = createSdkConcurrency({ global: 2, perAccount: 1 })
    const probe = createSdkUsageGaugeProbe({
      gauge,
      concurrency,
      freshness: { ensureFresh: async () => {}, wouldRefresh: async () => true },
      cliPathOverride: null,
      timeoutMs: 1_000,
      resolveCli: () => CLI,
      runQuery,
    })

    expect(await probe.read({ accountId: "sub-1", configDir: "/data/claude/sub-1" })).toBe("cold")
    expect(gauge.observed).toEqual([])
    expect(state.launched).toEqual([])
    expect(concurrency.inFlight).toBe(0)
  })
})

test("idle gauge captures authority before queue wait and never recaptures after launch", async () => {
  const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
  const held = await concurrency.acquire("sub-1", new AbortController().signal)
  let version = 0,
    captures = 0,
    reads = 0,
    applied = 0
  const gauge = createSdkUsageGauge({
    enabled: true,
    timeoutMs: 1000,
    minIntervalMs: 0,
    capture: () => {
      captures++
      const original = version
      return {
        accepts: () => original === version,
        onReading: () => {
          applied++
        },
      }
    },
  })
  const fake = fakeQuery()
  const probe = createSdkUsageGaugeProbe({
    gauge,
    concurrency,
    cliPathOverride: null,
    timeoutMs: 1000,
    resolveCli: () => CLI,
    runQuery: (input) => {
      const query = fake.runQuery(input)
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async () => {
        reads++
        return { rate_limits_available: true, rate_limits: { five_hour: { utilization: 42 } } }
      }
      return query
    },
  })
  const reading = probe.read({ accountId: "sub-1", configDir: "/data/claude/sub-1" })
  expect(captures).toBe(1)
  version++
  held.release()
  expect(await reading).toBe("read")
  expect(captures).toBe(1)
  expect(reads).toBe(0)
  expect(applied).toBe(0)
  expect(concurrency.inFlight).toBe(0)
})
