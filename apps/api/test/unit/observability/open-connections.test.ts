import { expect, test } from "bun:test"
import { createOpenConnectionsReading } from "../../../src/observability/open-connections"

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

// 12.18: the idle gauge reported capacity; the count now comes off the scrape path.
test("a scrape never waits: it reports the last landed count and starts one read", async () => {
  let reads = 0
  let release: (count: number) => void = () => undefined
  const reading = createOpenConnectionsReading({
    read: () => {
      reads++
      return new Promise<number>((resolve) => (release = resolve))
    },
    timeoutMs: 1_000,
  })
  expect(reading.sample()).toBeUndefined()
  expect(reading.sample()).toBeUndefined()
  expect(reads).toBe(1)
  release(4)
  await settle()
  expect(reading.sample()).toBe(4)
  expect(reads).toBe(2)
})

test("a read that lands past its deadline or fails is a skipped sample", async () => {
  let attempt = 0
  const reading = createOpenConnectionsReading({
    read: async () => {
      attempt++
      if (attempt === 1) return 3
      if (attempt === 2) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return 9
      }
      throw new Error("pool closed")
    },
    timeoutMs: 10,
  })
  reading.sample()
  await settle()
  expect(reading.sample()).toBe(3)
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(reading.sample()).toBe(3)
  await settle()
  expect(reading.sample()).toBe(3)
})
