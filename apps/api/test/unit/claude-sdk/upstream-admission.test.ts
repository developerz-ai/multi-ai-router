import { describe, expect, test } from "bun:test"
import { createSdkConcurrency, createSdkInvoker } from "../../../src/providers"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import { sdkQueryStream, sdkTurn } from "./fixtures"

const body = new TextEncoder().encode(
  JSON.stringify({ messages: [{ role: "user", content: "ping" }], model: "claude" }),
)
const cli = { ok: true, source: "platform_package", path: "/fixture/claude", bytes: 1000 } as const
const invocation = {
  accountId: "a",
  configDir: "/fixture/a",
  model: "claude",
  body,
  signal: new AbortController().signal,
  session: { kind: "fresh", reason: "no-session" } as const,
}
const turn = sdkTurn({
  blocks: [
    [
      { type: "text", text: "" },
      { type: "text_delta", text: "ok" },
    ],
  ],
})

/** Lets the fire-and-forget turn epilogue finish — claims are released by it, not by the response. */
const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
describe("SDK final upstream admission", () => {
  test("guard runs after freshness wait and refusal releases capacity without query", async () => {
    let release: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    let admissions = 0
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const invoke = createSdkInvoker({
      concurrency,
      resolveCli: () => cli,
      freshness: {
        ensureFresh: () => waiting.then(() => ({ release: () => {} })),
        wouldRefresh: async () => false,
      },
      runQuery: () => {
        calls += 1
        return sdkQueryStream({ turns: [turn] })
      },
    })
    const result = invoke({
      ...invocation,
      beforeUpstreamStart: () => {
        admissions += 1
        throw new UpstreamAdmissionRefused()
      },
    })
    await Promise.resolve()
    expect(admissions).toBe(0)
    release?.()
    await expect(result).rejects.toBeInstanceOf(UpstreamAdmissionRefused)
    expect(calls).toBe(0)
    const slot = await concurrency.acquire("a", new AbortController().signal)
    slot.release()
  })
  test("a token that crosses the refresh boundary while queued is re-asked once the slot is in hand", async () => {
    // The post-slot re-ask: the window is closed at admission, the caller queues on the slot, the
    // credential crosses the CLI's refresh lead while it waits — and the gate must be asked again
    // with the slot granted rather than wave through an uncoordinated refresher. Deleting the
    // re-ask leaves one ask, and `callsAtQuery` is the assertion that catches it.
    let windowOpen = false
    let calls = 0
    let callsAtQuery = 0
    const events: string[] = []
    const claims: { readonly owning: boolean; released: () => boolean }[] = []
    const freshness = {
      ensureFresh: async () => {
        calls += 1
        events.push(windowOpen ? "open" : "closed")
        let released = false
        claims.push({ owning: windowOpen, released: () => released })
        return {
          release: (): void => {
            released = true
          },
        }
      },
      wouldRefresh: async () => windowOpen,
    }
    // A slot that stays queued until the test opens it, so the flip lands inside the wait.
    let openAdmission: (() => void) | undefined
    const admitted = new Promise<void>((resolve) => {
      openAdmission = resolve
    })
    const invoke = createSdkInvoker({
      concurrency: {
        acquire: async () => {
          await admitted
          return { release: (): void => {} }
        },
        get inFlight(): number {
          return 0
        },
        get queued(): number {
          return 0
        },
        inFlightFor: () => 0,
      },
      resolveCli: () => cli,
      freshness,
      runQuery: () => {
        callsAtQuery = calls
        return sdkQueryStream({ turns: [turn] })
      },
    })

    const result = invoke({ ...invocation })
    // Admitted: exactly one ask, credential warm, the caller now parked on the slot.
    await Promise.resolve()
    expect(events).toEqual(["closed"])

    windowOpen = true
    openAdmission?.()
    const response = await result
    expect(response.status).toBe(200)

    // Exactly two asks, and both before any subprocess — the second one is the re-ask under test.
    expect(events).toEqual(["closed", "open"])
    expect(callsAtQuery).toBe(2)
    expect(calls).toBe(2)
    // Both claims live to the turn's end and are released by it — the owning one included.
    await drain()
    expect(claims.map((claim) => claim.owning)).toEqual([false, true])
    expect(claims.every((claim) => claim.released())).toBe(true)
  })
  test("designated recovery preserves the first busy outcome without a second query", async () => {
    let queries = 0
    let admissions = 0
    const invoke = createSdkInvoker({
      concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
      resolveCli: () => cli,
      runQuery: () => {
        queries += 1
        return {
          // biome-ignore lint/correctness/useYield: refusal precedes all SDK output.
          async *[Symbol.asyncIterator]() {
            throw new Error("Session sess_9 is currently running as a background agent")
          },
        }
      },
    })
    await expect(
      invoke({
        ...invocation,
        session: { kind: "resume", sdkSessionId: "sess_9", lineage: "continuation", deltaFrom: 0 },
        beforeUpstreamStart: Object.assign(
          () => {
            admissions += 1
            if (admissions > 1) throw new UpstreamAdmissionRefused()
          },
          { singleStart: true },
        ),
      }),
    ).rejects.toThrow("currently running as a background agent")
    expect(admissions).toBe(1)
    expect(queries).toBe(1)
  })
  test("ordinary admission guard runs for both queries of a busy-session fork", async () => {
    let queries = 0
    let admissions = 0
    const invoke = createSdkInvoker({
      concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
      resolveCli: () => cli,
      runQuery: () => {
        queries += 1
        if (queries > 1) return sdkQueryStream({ turns: [turn] })
        return {
          // biome-ignore lint/correctness/useYield: busy refusal precedes SDK output.
          async *[Symbol.asyncIterator]() {
            throw new Error("Session sess_9 is currently running as a background agent")
          },
        }
      },
    })
    const response = await invoke({
      ...invocation,
      session: { kind: "resume", sdkSessionId: "sess_9", lineage: "continuation", deltaFrom: 0 },
      beforeUpstreamStart: () => {
        admissions += 1
      },
    })
    expect(response.status).toBe(200)
    expect(queries).toBe(2)
    expect(admissions).toBe(2)
  })
  test("the busy-session retry re-takes freshness beside its own slot before the second query", async () => {
    // The re-take on the busy fork: the first attempt's claims and slot are handed back, and the
    // retry queues honestly — its own freshness asks, its own slot. Reusing the first attempt's
    // claims would show two asks in total; the four-ask sequence below refuses that.
    const events: string[] = []
    const claims: { released: () => boolean }[] = []
    let calls = 0
    let queries = 0
    const freshness = {
      ensureFresh: async () => {
        calls += 1
        events.push(`fresh#${calls}`)
        let released = false
        claims.push({ released: () => released })
        return {
          release: (): void => {
            released = true
          },
        }
      },
      wouldRefresh: async () => false,
    }
    const invoke = createSdkInvoker({
      concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
      resolveCli: () => cli,
      freshness,
      runQuery: () => {
        queries += 1
        events.push(`query#${queries}`)
        if (queries > 1) return sdkQueryStream({ turns: [turn] })
        return {
          // biome-ignore lint/correctness/useYield: busy refusal precedes SDK output.
          async *[Symbol.asyncIterator]() {
            throw new Error("Session sess_9 is currently running as a background agent")
          },
        }
      },
    })
    const response = await invoke({
      ...invocation,
      session: { kind: "resume", sdkSessionId: "sess_9", lineage: "continuation", deltaFrom: 0 },
    })
    expect(response.status).toBe(200)
    // Two asks per attempt — before the slot and with it in hand — on each of the two queries.
    expect(events).toEqual(["fresh#1", "fresh#2", "query#1", "fresh#3", "fresh#4", "query#2"])
    expect(queries).toBe(2)
    await drain()
    expect(claims).toHaveLength(4)
    expect(claims.every((claim) => claim.released())).toBe(true)
  })
})
