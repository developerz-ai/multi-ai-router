import { expect, test } from "bun:test"
import { createRecoveryLoop } from "../../../src/services/recovery/loop"

test("canceled loop callback cannot erase a newer restart timer", async () => {
  const scheduled: { run: () => void; cancelled: boolean }[] = []
  let stopped = false
  let ticks = 0
  const loop = createRecoveryLoop({
    intervalMs: 1000,
    stopped: () => stopped,
    tick: async () => {
      ticks++
    },
    schedule: (run) => {
      const entry = { run, cancelled: false }
      scheduled.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  })
  loop.start()
  const old = scheduled[0]
  stopped = true
  loop.stop()
  stopped = false
  loop.start()
  const current = scheduled[1]
  old?.run()
  expect(ticks).toBe(0)
  expect(current?.cancelled).toBe(false)
  current?.run()
  await Promise.resolve()
  await Promise.resolve()
  expect(ticks).toBe(1)
  expect(scheduled).toHaveLength(3)
})
