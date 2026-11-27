import { describe, expect, test } from "bun:test"
import { createSdkConcurrency, type IdleQuery, openIdleQuery } from "../../../src/providers"
import { prepareSdkProbe } from "../../../src/providers/claude-sdk/test-probe-preparation"
import { manualGateClock, turns } from "./manual-gate-clock"

/**
 * The paths the bounded gate wait deliberately does not touch.
 *
 * `CLAUDE_SDK_QUEUE_WAIT_MS` bounds a client's request. The Test-now probe (which is also the idle
 * probe, the credential keepalive and the `cooldown_recheck` re-test) and the idle query (the model
 * list and the usage-gauge read) keep the unbounded queue: nobody is waiting on them, each has its
 * own deadline, and refusing the keepalive at 60 s would skip a token refresh and end in
 * `needs_reauth` (router CLAUDE.md non-negotiable 13).
 *
 * Both are driven against a full gate whose clock is the test's own, advanced a day past any knob. A
 * caller that had been handed a wait budget would have expired by then; these must still be queued,
 * and must proceed once a slot frees.
 */

const A_DAY = 24 * 60 * 60 * 1_000

function fullGate() {
  const time = manualGateClock()
  const concurrency = createSdkConcurrency(
    { global: 4, perAccount: 1 },
    { now: time.now, timer: time.timer },
  )
  return { time, concurrency }
}

const idle: IdleQuery = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  initializationResult: async () => ({}),
  return: async () => ({ done: true, value: undefined }),
}

describe("the probe and keepalive path (test-probe-preparation)", () => {
  test("stays queued behind a full gate however long the clock runs, then proceeds", async () => {
    const { time, concurrency } = fullGate()
    const holder = await concurrency.acquire("acc-1", new AbortController().signal)
    const state: { outcome: "pending" | "settled" } = { outcome: "pending" }

    const preparing = prepareSdkProbe(
      {
        accountId: "acc-1",
        configDir: "/data/claude/acc-1",
        model: "claude-sonnet-4-5",
        signal: new AbortController().signal,
      },
      {
        resolveCli: () => ({ ok: true, source: "env_override", path: "/offline/claude", bytes: 1 }),
        concurrency,
        ceilingMessage: "the ceiling",
      },
    ).then((prepared) => {
      state.outcome = "settled"
      return prepared
    })
    await turns()
    expect(concurrency.queued).toBe(1)

    time.advance(A_DAY)
    await turns()
    expect(state.outcome).toBe("pending")
    expect(concurrency.queued).toBe(1)

    holder.release()
    const prepared = await preparing
    expect(prepared.ok).toBe(true)
    if (prepared.ok) prepared.slot.release()
    expect(concurrency.inFlight).toBe(0)
  })
})

describe("the idle query path (idle-query)", () => {
  test("stays queued behind a full gate however long the clock runs, then proceeds", async () => {
    const { time, concurrency } = fullGate()
    const holder = await concurrency.acquire("acc-1", new AbortController().signal)
    const state: { outcome: "pending" | "settled" | "rejected" } = { outcome: "pending" }

    const opening = openIdleQuery({
      accountId: "acc-1",
      configDir: "/data/claude/acc-1",
      cliPath: "/opt/claude/claude",
      concurrency,
      timeoutMs: A_DAY * 2,
      runQuery: ({ prompt }) => {
        void (async () => {
          for await (const _ of prompt) {
          }
        })()
        return idle
      },
    }).then(
      (handle) => {
        state.outcome = "settled"
        return handle
      },
      (error: unknown) => {
        state.outcome = "rejected"
        throw error
      },
    )
    await turns()
    expect(concurrency.queued).toBe(1)

    time.advance(A_DAY)
    await turns()
    expect(state.outcome).toBe("pending")
    expect(concurrency.queued).toBe(1)

    holder.release()
    const handle = await opening
    expect(state.outcome).toBe("settled")
    await handle.close()
    expect(concurrency.inFlight).toBe(0)
  })
})
