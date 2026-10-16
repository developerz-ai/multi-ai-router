import { afterEach, describe, expect, test } from "bun:test"
import {
  ATTRIBUTION,
  mount,
  option,
  resetUsagePage,
  settle,
  stub,
  summaryRequests,
  filterGroup,
} from "../support/usage-page"

/**
 * The Usage page's URL contract (issue #228): filters and the window live in the URL, so a deep
 * link restores the view and the fetch repeats the params. Mounted whole against a stubbed
 * `fetch`, so what is proven is the wiring and not just the panels.
 */

afterEach(resetUsagePage)

describe("Usage page URL state", () => {
  test("a deep link restores the window and every filter, and the fetch repeats the params", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount(
      "/usage?window=30d&owner=alice&owner=bob&tool=cli&model=claude-x",
    )
    try {
      await settle()
      const filtered = summaryRequests().find((url) => url.searchParams.has("owner"))
      expect(filtered).toBeDefined()
      expect(filtered?.searchParams.get("window")).toBe("30d")
      expect(filtered?.searchParams.getAll("owner")).toEqual(["alice", "bob"])
      expect(filtered?.searchParams.getAll("tool")).toEqual(["cli"])
      expect(filtered?.searchParams.getAll("model")).toEqual(["claude-x"])
      // Repeated, never joined: a comma-joined value would match no owner at all.
      expect(filtered?.search).not.toContain("alice%2Cbob")
      expect(filtered?.search).not.toContain("alice,bob")

      expect(option(container, "Owner", "alice").checked).toBe(true)
      // Absent from the unfiltered options, yet still shown selected so it can be removed.
      expect(option(container, "Owner", "bob").checked).toBe(true)
      expect(option(container, "Tool", "cli").checked).toBe(true)
      const pressed = container.querySelector('button[aria-pressed="true"]')
      expect(container.textContent).toContain("30 days")
      expect(pressed).not.toBeNull()
    } finally {
      dispose()
    }
  })

  test("toggling a filter writes the URL, refetches filtered, and the export carries it", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      expect(summaryRequests().every((url) => !url.searchParams.has("owner"))).toBe(true)

      option(container, "Owner", "alice").click()
      await settle()

      expect(new URLSearchParams(window.location.search).getAll("owner")).toEqual(["alice"])
      const last = summaryRequests().at(-1)
      expect(last?.searchParams.getAll("owner")).toEqual(["alice"])

      const anchor = Array.from(container.querySelectorAll("a")).find(
        (a) => a.textContent?.trim() === "Export CSV",
      )
      const href = new URL(anchor?.getAttribute("href") ?? "", "http://router.test")
      expect(href.searchParams.getAll("owner")).toEqual(["alice"])

      option(container, "Tool", "cli").click()
      await settle()
      expect(summaryRequests().at(-1)?.searchParams.getAll("tool")).toEqual(["cli"])
      expect(summaryRequests().at(-1)?.searchParams.getAll("owner")).toEqual(["alice"])

      option(container, "Owner", "alice").click()
      await settle()
      expect(new URLSearchParams(window.location.search).has("owner")).toBe(false)
    } finally {
      dispose()
    }
  })

  test("owner options are deduped by slug, so a person and a service alice are one option", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      const labels = Array.from(filterGroup(container, "Owner").querySelectorAll("label")).map(
        (el) => el.textContent?.trim(),
      )
      expect(labels.filter((label) => label === "alice")).toHaveLength(1)
      expect(labels).toContain("dana")
      // A bucket is not an owner anyone can filter on.
      expect(labels.some((label) => label?.includes("unassigned"))).toBe(false)
    } finally {
      dispose()
    }
  })
})
