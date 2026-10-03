import { expect, test } from "bun:test"
import { createWriterLifecycle } from "../../../src/services/shutdown/writer-lifecycle"

test("an unexpectedly rejected flush reports uncertainty, still performs the final pending pass, and permits restart", async () => {
  let flushes = 0
  let pending = 1
  const reports: number[] = []
  const lifecycle = createWriterLifecycle({
    flush: async () => {
      if (++flushes === 1) throw new Error("unexpected bookkeeping failure")
      pending = 0
    },
    pending: () => pending,
    timeoutMs: 100,
    warn: (count) => reports.push(count),
  })
  await lifecycle.stop()
  expect(flushes).toBe(2)
  expect(reports).toEqual([1])
  expect(lifecycle.accepting()).toBe(false)
  expect(lifecycle.start()).toBe(true)
})

test("deadline expiry prevents a new final write pass after the held flush settles", async () => {
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let flushes = 0
  const reports: number[] = []
  const lifecycle = createWriterLifecycle({
    flush: async () => {
      flushes++
      await held
    },
    pending: () => 1,
    timeoutMs: 5,
    warn: (count) => reports.push(count),
  })
  await lifecycle.stop()
  expect(lifecycle.start()).toBe(false)
  release?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(flushes).toBe(1)
  expect(reports).toEqual([1])
  expect(lifecycle.start()).toBe(true)
})

test("a throwing uncertainty observer cannot trap the shutdown deadline", async () => {
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const lifecycle = createWriterLifecycle({
    flush: () => held,
    pending: () => 1,
    timeoutMs: 5,
    warn: () => {
      throw new Error("log transport unavailable")
    },
  })
  await lifecycle.stop()
  expect(lifecycle.accepting()).toBe(false)
  expect(lifecycle.start()).toBe(false)
  release?.()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(lifecycle.start()).toBe(true)
})
