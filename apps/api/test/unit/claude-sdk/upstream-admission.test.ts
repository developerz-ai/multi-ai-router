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
      freshness: { ensureFresh: () => waiting },
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
})
