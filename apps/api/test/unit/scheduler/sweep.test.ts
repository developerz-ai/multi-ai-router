import { describe, expect, test } from "bun:test"
import { runSweeps, type Sweep } from "../../../src/scheduler/tasks/sweep"

/**
 * The half of `SWEEP_BATCH_SIZE` that boot validation exists to make unreachable.
 *
 * `runSweeps` learns a category is drained from a batch that comes back *shorter* than the
 * limit — and nothing is ever shorter than zero. At `SWEEP_BATCH_SIZE=0` the drain loop has no
 * exit, so this is not "the janitor deletes nothing": it is a tick that never returns, holding
 * its Postgres advisory lock and starving the event loop the abort signal is delivered on.
 *
 * `config/env.ts` refuses the value at boot. This is what it is refusing.
 */
describe("runSweeps with a batch size of zero", () => {
  const spinning = (onBatch: (limit: number) => void): Sweep => ({
    category: "usageRecords",
    deleteBatch: async (limit) => {
      onBatch(limit)
      return 0
    },
  })

  test("never learns the category is drained, and no macrotask gets a turn", async () => {
    let calls = 0
    let timerFired = false
    setTimeout(() => {
      timerFired = true
    }, 0)

    // The only way out is the sweep itself refusing to continue — which is the point.
    const report = await runSweeps(
      [
        spinning((limit) => {
          expect(limit).toBe(0)
          calls += 1
          if (calls >= 20_000) throw new Error("the drain loop has no exit at batchSize 0")
        }),
      ],
      { batchSize: 0, signal: new AbortController().signal },
    )

    expect(calls).toBe(20_000)
    expect(report.itemsProcessed).toBe(0)
    expect(report.outcome).toBe("failed")
    // Twenty thousand iterations and the 0 ms timer still has not run: a shutdown's abort could
    // not have been delivered either.
    expect(timerFired).toBe(false)
  })

  test("a batch size of one drains normally, so the loop itself is not the problem", async () => {
    let remaining = 3
    const report = await runSweeps(
      [
        {
          category: "usageRecords",
          deleteBatch: async (limit) => {
            expect(limit).toBe(1)
            if (remaining === 0) return 0
            remaining -= 1
            return 1
          },
        },
      ],
      { batchSize: 1, signal: new AbortController().signal },
    )

    expect(report.outcome).toBe("success")
    expect(report.itemsProcessed).toBe(3)
    expect(report.counts).toEqual({ usageRecords: 3 })
  })
})
