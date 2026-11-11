import { expect, test } from "bun:test"
import { buildSnapshot, createHealthStore } from "../../../src/services/dataplane"
import { account, catalog, NOW } from "./fixtures"

// Plan 101, 02.8 / 03.3: every request re-overlaid the whole fleet. Inputs are replaced, never
// mutated, so an account nothing touched reuses its view, and a touched one alone recomputes.
test("an untouched account's overlay is reused; a health write recomputes only that account", () => {
  const store = catalog([account("a"), account("b")])
  const health = createHealthStore()
  const first = buildSnapshot(store, health, NOW)
  const second = buildSnapshot(store, health, NOW)
  expect(second.accounts[0]).toBe(first.accounts[0])
  expect(second.accounts[1]).toBe(first.accounts[1])

  health.beginAttempt("b")
  const third = buildSnapshot(store, health, NOW)
  expect(third.accounts[0]).toBe(first.accounts[0])
  expect(third.accounts[1]).not.toBe(first.accounts[1])
  expect(third.accounts[1]?.health.inFlight).toBe(1)
})
