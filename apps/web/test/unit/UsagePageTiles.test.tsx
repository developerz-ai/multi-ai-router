import { afterEach, describe, expect, test } from "bun:test"
import { mount, resetUsagePage, settle, stub } from "../support/usage-page"

/** The Usage page's headline tiles (issue #228): unpriced attempts, token counts, spend figures. */

afterEach(resetUsagePage)

describe("Usage page tiles", () => {
  test("Unpriced attempts shows the count", async () => {
    stub({ summary: { totals: { unpricedAttempts: 12 } } })
    const { container, dispose } = mount()
    try {
      await settle()
      const label = Array.from(container.querySelectorAll("span")).find(
        (el) => el.textContent === "Unpriced attempts",
      )
      expect(label?.nextElementSibling?.textContent).toBe("12")
    } finally {
      dispose()
    }
  })

  test("Unpriced attempts is a dash when the window predates measurement, never 0", async () => {
    stub({ summary: { totals: { unpricedAttempts: null } } })
    const { container, dispose } = mount()
    try {
      await settle()
      const label = Array.from(container.querySelectorAll("span")).find(
        (el) => el.textContent === "Unpriced attempts",
      )
      const tile = label?.parentElement
      expect(label?.nextElementSibling?.textContent).toBe("—")
      expect(tile?.getAttribute("aria-busy")).toBe("false")
    } finally {
      dispose()
    }
  })

  test("token tiles count every prompt token and say how much the cache served", async () => {
    stub({
      summary: { totals: { tokensIn: 600_000, cacheReadTokens: 400_000, tokensOut: 25_000 } },
    })
    const { container, dispose } = mount()
    try {
      await settle()
      const tile = (name: string) =>
        Array.from(container.querySelectorAll("span")).find((el) => el.textContent === name)
          ?.parentElement
      expect(tile("Input tokens")?.textContent).toContain("1M")
      expect(tile("Input tokens")?.textContent).toContain("400k from cache · 40")
      expect(tile("Output tokens")?.textContent).toContain("25k")
    } finally {
      dispose()
    }
  })

  test("no rendered figure adds metered and notional spend", async () => {
    stub({ summary: { totals: { metered: "1.00", notional: "2.00" } } })
    const { container, dispose } = mount()
    try {
      await settle()
      const text = container.textContent ?? ""
      expect(text).toContain("$1.00")
      expect(text).toContain("$2.00")
      expect(text).not.toContain("$3.00")
    } finally {
      dispose()
    }
  })
})
