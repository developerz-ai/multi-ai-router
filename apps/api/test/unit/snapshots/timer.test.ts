import { expect, test } from "bun:test"
import { createJitteredRefreshTimer } from "../../../src/services/snapshots/timer"

// Plan 101, 04.5: the timer the three warm stores shared by copy.
test("a failing tick reports once, keeps running, and stop ends it", async () => {
  let ticks = 0
  const errors: unknown[] = []
  const timer = createJitteredRefreshTimer({
    intervalMs: 5,
    jitter: (ms) => ms,
    refresh: async () => {
      ticks++
      if (ticks === 1) throw new Error("database unavailable")
    },
    onError: (error) => errors.push(error),
  })
  timer.start()
  timer.start()
  await new Promise((resolve) => setTimeout(resolve, 40))
  timer.stop()
  const stoppedAt = ticks
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(errors).toHaveLength(1)
  expect(stoppedAt).toBeGreaterThan(1)
  expect(ticks).toBe(stoppedAt)
})
