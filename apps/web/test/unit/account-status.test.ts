import { describe, expect, test } from "bun:test"
import { AccountStatus } from "@multi-ai-router/core"
import {
  hasReset,
  isRoutable,
  needsOperator,
  STATUS_DISPLAY_ORDER,
  statusLabel,
  statusPresentation,
  statusToken,
} from "../../src/lib/account-status"

describe("STATUS_DISPLAY_ORDER", () => {
  // The drift gate. Presentation may reorder the vocabulary; it may never hold
  // a different set of values from the domain. A status added to core without a
  // presentation fails here.
  test("is a permutation of core's AccountStatus", () => {
    expect([...STATUS_DISPLAY_ORDER].sort()).toEqual([...AccountStatus.options].sort())
  })

  test("contains no duplicates", () => {
    expect(new Set(STATUS_DISPLAY_ORDER).size).toBe(STATUS_DISPLAY_ORDER.length)
  })
})

describe("statusPresentation", () => {
  test("covers every status core defines with a token, a label and a hint", () => {
    for (const status of AccountStatus.options) {
      const presentation = statusPresentation(status)
      expect(presentation.token.startsWith("--")).toBe(true)
      expect(presentation.label.length).toBeGreaterThan(0)
      expect(presentation.hint.length).toBeGreaterThan(0)
    }
  })

  test("uses only semantic token names, never a colour value", () => {
    const allowed = new Set(["--ok", "--warn", "--danger", "--text-muted"])
    for (const status of AccountStatus.options) {
      expect(allowed.has(statusToken(status))).toBe(true)
    }
  })

  // Non-negotiable 7: a clock fixes one, a human fixes the other. They must
  // never render identically.
  test("cooling_down and exhausted are visually distinct", () => {
    expect(statusToken("cooling_down")).not.toBe(statusToken("exhausted"))
    expect(statusLabel("cooling_down")).not.toBe(statusLabel("exhausted"))
  })

  test("exhausted is worded as a top-up, not as a wait", () => {
    const hint = statusPresentation("exhausted").hint.toLowerCase()
    expect(hint).toContain("top-up")
    expect(hint).not.toContain("countdown ")
  })

  // Both are --danger; the fill is what keeps them apart.
  test("needs_reauth is distinguishable from exhausted without colour", () => {
    expect(statusToken("needs_reauth")).toBe(statusToken("exhausted"))
    expect(statusPresentation("needs_reauth").fill).not.toBe(statusPresentation("exhausted").fill)
  })
})

describe("status predicates", () => {
  test("only active is routable", () => {
    expect(AccountStatus.options.filter(isRoutable)).toEqual(["active"])
  })

  test("exhausted and needs_reauth are the ones a human must clear", () => {
    expect(AccountStatus.options.filter(needsOperator).sort()).toEqual([
      "exhausted",
      "needs_reauth",
    ])
  })

  test("only cooling_down has a reset to count down to", () => {
    expect(AccountStatus.options.filter(hasReset)).toEqual(["cooling_down"])
  })
})
