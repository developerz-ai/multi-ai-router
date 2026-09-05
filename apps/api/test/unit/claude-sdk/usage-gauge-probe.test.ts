import { describe, expect, test } from "bun:test"
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  type CliResolution,
  createSdkConcurrency,
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

    expect(read).toBe(true)
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

  test("no usable binary means no query and a false answer, never a throw", async () => {
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

    expect(await probe.read({ accountId: "sub-1", configDir: "/data/claude/sub-1" })).toBe(false)
    expect(gauge.observed).toEqual([])
    expect(state.launched).toEqual([])
  })
})
