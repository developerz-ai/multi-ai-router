import { describe, expect, test } from "bun:test"
import {
  type BadgeMeas,
  type Box,
  backgroundAlpha,
  Checker,
  contained,
  intersects,
  type PageMeas,
} from "../../ui-geometry/geometry"
import { assertAccounts, assertKeys } from "../../ui-geometry/rules"

// The geometry gate's rules, tested the way the repo tests everything: failure
// case first, each one the prod fingerprint it exists to catch — the #62
// overlap, the translucent pill, the escaped cell, and the empty selector scope
// that is how #94 got through CI green.

const CELL: Box = { x: 100, y: 50, width: 200, height: 80 }
const INSIDE: Box = { x: 105, y: 55, width: 100, height: 20 }
const BADGE_BOX: Box = { x: 310, y: 55, width: 40, height: 18 }

const badge = (background: string, box: Box = BADGE_BOX): BadgeMeas => ({
  text: "stored",
  box,
  background,
  opacity: "1",
})

const row = (
  over: Partial<{
    costBlock: Box | null
    costText: Box | null
    badges: BadgeMeas[]
    others: { cell: Box; ink: Box }[]
  }>,
) => ({
  costCell: CELL,
  costBlock: over.costBlock === undefined ? INSIDE : over.costBlock,
  costText: over.costText === undefined ? INSIDE : over.costText,
  costBlockText: "$1.00",
  badges: over.badges ?? [badge("rgb(18, 22, 31)")],
  others: over.others ?? [],
})

const page = (
  rows: ReturnType<typeof row>[],
  badges: BadgeMeas[] = [badge("rgb(18, 22, 31)")],
): PageMeas => ({
  tables: [
    {
      headers: ["Account", "Status", "Availability", "Usage · 7 days", "Credential / login"],
      rows,
      badges,
    },
  ],
})

describe("assertAccounts", () => {
  test("a cost block pushed through the credential badge fails (#62)", () => {
    const overlapping: Box = { x: 300, y: 55, width: 60, height: 18 }
    const c = new Checker()
    assertAccounts(c, page([row({ costBlock: overlapping, costText: overlapping })]))
    expect(c.failures.some((f) => f.includes("intersects badge"))).toBe(true)
    expect(c.failures.some((f) => f.includes("escapes its cell"))).toBe(true)
  })

  test("a translucent badge background fails the alpha rule", () => {
    const c = new Checker()
    const translucent = badge("rgba(18, 22, 31, 0.14)")
    assertAccounts(c, page([row({ badges: [translucent] })], [translucent]))
    expect(c.failures.some((f) => f.includes("alpha 0.14"))).toBe(true)
  })

  test("a table whose cost selector matched nothing fails by name (#94's gap)", () => {
    const c = new Checker()
    assertAccounts(c, page([row({ costBlock: null, costText: null })]))
    expect(c.failures.some((f) => f.includes("zero cost blocks"))).toBe(true)
  })

  test("a translucent badge outside the credential column still fails the alpha rule", () => {
    const c = new Checker()
    assertAccounts(c, page([row({})], [badge("rgba(18, 22, 31, 0.14)")]))
    expect(c.failures.some((f) => f.includes("alpha 0.14"))).toBe(true)
  })

  test("cost blocks matched but no cost-text span fails by name", () => {
    const c = new Checker()
    assertAccounts(c, page([row({ costText: null })]))
    expect(c.failures.some((f) => f.includes("matched zero cost-text spans"))).toBe(true)
  })

  test("cost text ink overflowing a narrow figures box into the badge fails (#62 fingerprint)", () => {
    // The flex item is 48px wide (inside the cell, clear of the badge); its text
    // paints another ~100px to the right, through the badge at x=310.
    const inkThroughBadge: Box = { x: 105, y: 55, width: 260, height: 20 }
    const c = new Checker()
    assertAccounts(c, page([row({ costText: inkThroughBadge })]))
    expect(c.failures.some((f) => f.includes("cost text intersects badge"))).toBe(true)
  })

  test("a row silently dropping its cost selectors fails the row count, not just the zero guard", () => {
    const c = new Checker()
    assertAccounts(c, page([row({}), row({ costBlock: null, costText: null })]))
    expect(c.failures.some((f) => f.includes("1 of 2 rows have a cost block"))).toBe(true)
    expect(c.failures.some((f) => f.includes("1 of 2 rows have a cost-text span"))).toBe(true)
  })

  test("a table with no stored credential badge fails by name", () => {
    const c = new Checker()
    assertAccounts(c, page([row({ badges: [{ ...badge("rgb(18, 22, 31)"), text: "oauth" }] })]))
    expect(c.failures.some((f) => f.includes('no credential badge reading "stored"'))).toBe(true)
  })

  test("a clean measurement passes", () => {
    const c = new Checker()
    assertAccounts(c, page([row({})]))
    expect(c.failures).toEqual([])
  })
})

describe("assertKeys", () => {
  const keysPage = (
    spend: Box | null,
    neighbors: Box[],
    badges?: BadgeMeas[],
    droppedRows = 0,
  ): PageMeas => ({
    tables: [
      {
        headers: ["Name", "State", "Scope", "Rate limit", "Usage · 7 days", "Cost · 7 days"],
        rows: [
          {
            costCell: CELL,
            costBlock: spend,
            costText: spend,
            costBlockText: "$1.00",
            badges: [],
            others: neighbors.map((ink) => ({ cell: ink, ink })),
          },
          ...Array.from({ length: droppedRows }, () => ({
            costCell: CELL,
            costBlock: null,
            costText: null,
            costBlockText: null,
            badges: [],
            others: [],
          })),
        ],
        badges: badges ?? [badge("rgb(18, 22, 31)", { x: 10, y: 55, width: 30, height: 18 })],
      },
    ],
  })

  test("a SpendCell bleeding into the neighbouring cell fails", () => {
    const bleeding: Box = { x: 100, y: 55, width: 220, height: 20 }
    const neighbor: Box = { x: 300, y: 50, width: 120, height: 80 }
    const c = new Checker()
    assertKeys(c, keysPage(bleeding, [neighbor]))
    expect(c.failures.some((f) => f.includes("intersects a neighbouring cell"))).toBe(true)
    expect(c.failures.some((f) => f.includes("escapes its cell"))).toBe(true)
  })

  test("a contained SpendCell whose neighbour's content overflows into it fails", () => {
    // The block is inside its own cell; the neighbour's ink (not its td box)
    // reaches back over it.
    const neighborInk: Box = { x: 150, y: 55, width: 60, height: 18 }
    const c = new Checker()
    assertKeys(c, keysPage(INSIDE, [neighborInk]))
    expect(c.failures.some((f) => f.includes("intersects a neighbouring cell's content"))).toBe(
      true,
    )
    expect(c.failures.some((f) => f.includes("escapes its cell"))).toBe(false)
  })

  test("an overlong spend value spilling past the cell fails", () => {
    const spilled: Box = { x: 105, y: 55, width: 230, height: 20 }
    const c = new Checker()
    assertKeys(c, keysPage(spilled, []))
    expect(c.failures.some((f) => f.includes("SpendCell ink escapes its cell"))).toBe(true)
  })

  test("a Keys row silently dropping its SpendCell fails the row count", () => {
    const c = new Checker()
    assertKeys(c, keysPage(INSIDE, [], undefined, 1))
    expect(c.failures.some((f) => f.includes("1 of 2 rows have a SpendCell"))).toBe(true)
  })

  test("a neighbour whose content paints past its own cell fails even short of the SpendCell", () => {
    const cell: Box = { x: 0, y: 50, width: 60, height: 80 }
    const ink: Box = { x: 10, y: 55, width: 80, height: 18 }
    const meas = keysPage(INSIDE, [])
    const c = new Checker()
    assertKeys(c, {
      tables: meas.tables.map((t) => ({
        ...t,
        rows: t.rows.map((r) => ({ ...r, others: [{ cell, ink }] })),
      })),
    })
    expect(c.failures.some((f) => f.includes("neighbouring cell's content escapes its cell"))).toBe(
      true,
    )
    expect(c.failures.some((f) => f.includes("intersects a neighbouring"))).toBe(false)
  })

  test("a contained SpendCell with no State badge fails on the empty badge scope", () => {
    const c = new Checker()
    assertKeys(c, keysPage(INSIDE, [], []))
    expect(c.failures.some((f) => f.includes("zero State badges"))).toBe(true)
  })

  test("a SpendCell row with no neighbouring cells fails on the empty scope", () => {
    const c = new Checker()
    assertKeys(c, keysPage(INSIDE, []))
    expect(c.failures.some((f) => f.includes("matched zero neighbouring cells"))).toBe(true)
  })

  test("a clean keys measurement passes", () => {
    const c = new Checker()
    assertKeys(c, keysPage(INSIDE, [{ x: 300, y: 50, width: 120, height: 80 }]))
    expect(c.failures).toEqual([])
  })
})

describe("geometry primitives", () => {
  test("containment and intersection agree at the epsilon boundary", () => {
    const touching: Box = { x: 299.7, y: 55, width: 40, height: 18 }
    expect(contained(touching, CELL)).toBe(false)
    expect(intersects(INSIDE, BADGE_BOX)).toBe(false)
  })

  test("alpha parsing defaults opaque rgb() to 1 and rejects garbage", () => {
    expect(backgroundAlpha("rgb(18, 22, 31)")).toBe(1)
    expect(backgroundAlpha("rgba(18, 22, 31, 0)")).toBe(0)
    expect(Number.isNaN(backgroundAlpha("var(--surface-raised)"))).toBe(true)
  })
})
