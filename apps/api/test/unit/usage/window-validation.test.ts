import { expect, test } from "bun:test"
import { usageWindowQuery } from "../../../src/services/usage-read/window"

test("custom usage ranges require ordered complete bounds", () => {
  const from = "2026-10-01T00:00:00.000Z"
  const to = "2026-10-02T00:00:00.000Z"
  expect(usageWindowQuery.safeParse({ from, to }).success).toBe(true)
  expect(usageWindowQuery.safeParse({ to }).success).toBe(false)
  expect(usageWindowQuery.safeParse({ from }).success).toBe(false)
  expect(usageWindowQuery.safeParse({ from, to: from }).success).toBe(false)
  expect(usageWindowQuery.safeParse({ from: to, to: from }).success).toBe(false)
  expect(usageWindowQuery.safeParse({ window: "today", to }).success).toBe(false)
})
