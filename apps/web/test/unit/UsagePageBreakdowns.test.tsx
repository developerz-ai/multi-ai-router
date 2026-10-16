import { afterEach, describe, expect, test } from "bun:test"
import {
  ATTRIBUTION,
  dimensionButton,
  mount,
  resetUsagePage,
  settle,
  stub,
  tableRows,
} from "../support/usage-page"

/**
 * The Usage page's breakdown tables (issue #228): owner rows carry their kind, tool rows the
 * slug, and the unassigned / deleted / none buckets and retired keys render under their own
 * labels.
 */

afterEach(resetUsagePage)

describe("Usage page owner and tool breakdowns", () => {
  test("a person and a service sharing a slug render as two distinguishable rows", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      dimensionButton(container, "Owner").click()
      await settle()
      const rows = tableRows(container).filter((row) => row.includes("alice"))
      expect(rows).toHaveLength(2)
      expect(rows.some((row) => row.includes("person"))).toBe(true)
      expect(rows.some((row) => row.includes("service"))).toBe(true)
      // A no-kind owner says so rather than passing for a person.
      const dana = tableRows(container).find((row) => row.includes("dana"))
      expect(dana).toContain("unknown")
    } finally {
      dispose()
    }
  })

  test("the unassigned, deleted and none buckets render their own labels", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      dimensionButton(container, "Owner").click()
      await settle()
      const rows = tableRows(container)
      expect(rows.some((row) => row.includes("(unassigned)"))).toBe(true)
      expect(rows.some((row) => row.includes("(deleted)"))).toBe(true)
      expect(rows.some((row) => row.includes("(none)"))).toBe(true)
    } finally {
      dispose()
    }
  })

  test("the tool breakdown renders slugs and the unassigned bucket", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      dimensionButton(container, "Tool").click()
      await settle()
      const rows = tableRows(container)
      expect(rows.some((row) => row.includes("cli"))).toBe(true)
      expect(rows.some((row) => row.includes("(unassigned)"))).toBe(true)
    } finally {
      dispose()
    }
  })

  test("a retired key carries a marker and a live one does not", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      const rows = tableRows(container)
      expect(rows.find((row) => row.includes("old-runner"))).toContain("retired")
      expect(rows.find((row) => row.includes("live-runner"))).not.toContain("retired")
    } finally {
      dispose()
    }
  })
})
