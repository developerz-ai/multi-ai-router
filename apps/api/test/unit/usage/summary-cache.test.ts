import { expect, test } from "bun:test"
import { createSummaryCache, summaryKey } from "../../../src/services/usage-read/summary-cache"

const now = () => new Date("2026-11-10T00:00:00Z")

test("a rejected read is never kept: the next identical read loads again", async () => {
  const cache = createSummaryCache<number>(60_000, now)
  let loads = 0
  await expect(
    cache.read("k", async () => {
      loads += 1
      throw new Error("snapshot failed")
    }),
  ).rejects.toThrow("snapshot failed")
  expect(await cache.read("k", async () => ++loads)).toBe(2)
})

test("the key ignores property order", () => {
  expect(summaryKey({ query: { window: "7d" }, filter: { a: ["x"], b: ["y"] } })).toBe(
    summaryKey({ filter: { b: ["y"], a: ["x"] }, query: { window: "7d" } }),
  )
})
