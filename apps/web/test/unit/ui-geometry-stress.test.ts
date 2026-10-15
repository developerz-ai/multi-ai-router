import { describe, expect, test } from "bun:test"
import { Checker, type PageMeas, type RowMeas } from "../../ui-geometry/geometry"
import { assertStress } from "../../ui-geometry/stress"

const BOX = { x: 0, y: 0, width: 10, height: 10 }
const row = (text: string | null, stored = false): RowMeas => ({
  costCell: BOX,
  costBlock: BOX,
  costText: BOX,
  costBlockText: text,
  badges: stored ? [{ text: "stored", box: BOX, background: "rgb(0, 0, 0)", opacity: "1" }] : [],
  others: [],
})
const page = (rows: RowMeas[]): PageMeas => ({ tables: [{ headers: [], rows, badges: [] }] })
const keys = { rows: 2, figures: [{ label: "big", text: "$45,679" }], storedRowNotZero: false }

describe("assertStress", () => {
  test("a stress cell reading $0.00 (id renamed on one side) fails by name", () => {
    const c = new Checker()
    assertStress(c, "keys", page([row("metered$0.00"), row("metered$34.56")]), keys)
    expect(c.failures.join("\n")).toContain('stress cell "big"')
  })

  test("a row count short of the fixture fails", () => {
    const c = new Checker()
    assertStress(c, "keys", page([row("metered$45,679")]), keys)
    expect(c.failures.join("\n")).toContain("rendered 1 rows, fixture defines 2")
  })

  test("a STORED row with a $0.00 figure fails; two real figures pass", () => {
    const want = { rows: 1, figures: [], storedRowNotZero: true }
    const bad = new Checker()
    assertStress(bad, "accounts", page([row("1 req$0.00 · $9.00 notional", true)]), want)
    expect(bad.failures.length).toBe(1)
    const good = new Checker()
    assertStress(good, "accounts", page([row("1 req$8.00 · $9.00 notional", true)]), want)
    expect(good.failures).toEqual([])
  })
})
