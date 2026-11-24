import { describe, expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { runBounded } from "../../../src/scheduler/runner-support"
import {
  createEgressProxyCheckTask,
  createEgressProxyCheckTasks,
  type EgressSweepReport,
} from "../../../src/scheduler/tasks/egress-proxy-check"

/** The task is only the schedule: it runs the sweep port and reports what the sweep reported. */
const NOW = new Date("2026-11-24T00:00:00.000Z")
const report = (over: Partial<EgressSweepReport> = {}): EgressSweepReport => ({
  checked: 0,
  failed: 0,
  reseals: 0,
  swaps: 0,
  noCandidate: 0,
  ...over,
})

function run(sweep: () => Promise<EgressSweepReport>, signal = new AbortController().signal) {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({ level: "info", write: (line) => void lines.push(JSON.parse(line)) })
  const task = createEgressProxyCheckTask({ sweep, intervalMs: 300_000 })
  return task.run({ now: NOW, logger, signal }).then((outcome) => ({ outcome, lines, task }))
}

describe("egress_proxy_check task", () => {
  test("no port builds no task; a port builds one on the port's cadence", () => {
    expect(createEgressProxyCheckTasks(undefined)).toEqual([])
    const [task] = createEgressProxyCheckTasks({ sweep: async () => report(), intervalMs: 42 })
    expect(task).toMatchObject({ name: "egress_proxy_check", intervalMs: 42 })
  })

  test("nothing proxied is a quiet success", async () => {
    const { outcome, lines } = await run(async () => report())
    expect(outcome).toEqual({ outcome: "success", itemsProcessed: 0 })
    expect(lines).toEqual([])
  })

  test("reports the sweep's counts, and partial when the sweep stopped short", async () => {
    const done = await run(async () => report({ checked: 3, failed: 1, swaps: 1 }))
    expect(done.outcome).toEqual({ outcome: "success", itemsProcessed: 3 })
    expect(done.lines[0]).toMatchObject({
      msg: "egress proxy check",
      checked: 3,
      failed: 1,
      swaps: 1,
    })
    const short = await run(async () => report({ checked: 50, partial: true }))
    expect(short.outcome).toEqual({ outcome: "partial", itemsProcessed: 50 })
    const aborted = new AbortController()
    aborted.abort()
    expect((await run(async () => report({ checked: 1 }), aborted.signal)).outcome.outcome).toBe(
      "partial",
    )
  })

  test("a throwing sweep is a failed run carrying the reason, never a thrown tick", async () => {
    const { outcome } = await run(async () => {
      throw new Error("vendor listing exploded")
    })
    expect(outcome).toMatchObject({ outcome: "failed", itemsProcessed: 0 })
    expect(outcome.error).toContain("vendor listing exploded")
  })

  // A fetch or CONNECT error commonly echoes the proxy URL, userinfo included. The task hands the
  // message on whole; the runner is what persists it, and it must store none of the credential.
  test("a sweep failing with a credentialed proxy URL persists none of it", async () => {
    const task = createEgressProxyCheckTask({
      sweep: async () => {
        throw new Error("connect ECONNREFUSED http://proxyuser:s3cr3t-pass@203.0.113.7:8080")
      },
      intervalMs: 300_000,
    })
    const logger = createLogger({ level: "error", write: () => undefined })
    const outcome = await runBounded(
      task,
      { now: NOW, logger, signal: new AbortController().signal },
      undefined,
    )
    expect(outcome.outcome).toBe("failed")
    expect(outcome.error).not.toContain("s3cr3t-pass")
    expect(outcome.error).not.toContain("proxyuser")
    expect(outcome.error).toContain("203.0.113.7")
  })
})
