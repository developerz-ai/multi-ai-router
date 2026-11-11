import { describe, expect, test } from "bun:test"
import { cooldownLine } from "../../src/routes/accounts/AccountTestNow"

const NOW = Date.parse("2026-11-10T12:00:00.000Z")

describe("cooldownLine", () => {
  test("a cooldown still running counts down to the next allowed test", () => {
    expect(cooldownLine("2026-11-10T12:09:00.000Z", NOW)).toBe("On cooldown — next test in 9m")
  })

  test("a cooldown that already ended never reads as 'next test 9m ago'", () => {
    const line = cooldownLine("2026-11-10T11:51:00.000Z", NOW)
    expect(line).not.toContain("ago")
    expect(line).toBe("Cooldown over — ready to test again")
  })
})
