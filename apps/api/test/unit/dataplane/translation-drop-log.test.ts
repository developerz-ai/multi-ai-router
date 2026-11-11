import { expect, test } from "bun:test"
import { createTranslationDropLog } from "../../../src/services/dataplane/translation-drop-log"

// Plan 101, 12.15: one client re-sending one body logged 15,379 identical warns.
test("one warn per signature per window; a new window or a new signature warns again", () => {
  let now = 0
  const log = createTranslationDropLog({ windowMs: 1_000, now: () => now })
  expect(log.shouldWarn("k|a|b|x")).toBe(true)
  expect(log.shouldWarn("k|a|b|x")).toBe(false)
  expect(log.shouldWarn("k|a|b|y")).toBe(true)
  now = 1_000
  expect(log.shouldWarn("k|a|b|x")).toBe(true)
})
