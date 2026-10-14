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
})

const row = (
  over: Partial<{
    costBlock: Box | null
    costText: Box | null
    badges: BadgeMeas[]
    otherCells: Box[]
  }>,
) => ({
  costCell: CELL,
  costBlock: over.costBlock === undefined ? INSIDE : over.costBlock,
  costText: over.costText === undefined ? INSIDE : over.costText,
  badges: over.badges ?? [badge("rgb(18, 22, 31)")],
  otherCells: over.otherCells ?? [],
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
    assertAccounts(c, page([row({ badges: [badge("rgba(18, 22, 31, 0.14)")] })]))
    expect(c.failures.some((f) => f.includes("alpha 0.14"))).toBe(true)
  })

  test("a table whose cost selector matched nothing fails by name (#94's gap)", () => {
    const c = new Checker()
    assertAccounts(c, page([row({ costBlock: null, costText: null })]))
    expect(c.failures.some((f) => f.includes("zero cost blocks"))).toBe(true)
  })

  test("a clean measurement passes", () => {
    const c = new Checker()
    assertAccounts(c, page([row({})]))
    expect(c.failures).toEqual([])
  })
})

describe("assertKeys", () => {
  const keysPage = (spend: Box | null, neighbors: Box[]) =>
    ({
      tables: [
        {
          headers: ["Name", "State", "Scope", "Rate limit", "Usage · 7 days", "Cost · 7 days"],
          rows: [
            {
              costCell: CELL,
              costBlock: spend,
              costText: spend,
              badges: [],
              otherCells: neighbors,
            },
          ],
          badges: [badge("rgb(18, 22, 31)", { x: 10, y: 55, width: 30, height: 18 })],
        },
      ],
    }) as unknown as PageMeas

  test("a SpendCell bleeding into the neighbouring cell fails", () => {
    const bleeding: Box = { x: 100, y: 55, width: 220, height: 20 }
    const neighbor: Box = { x: 300, y: 50, width: 120, height: 80 }
    const c = new Checker()
    assertKeys(c, keysPage(bleeding, [neighbor]))
    expect(c.failures.some((f) => f.includes("intersects a neighbouring cell"))).toBe(true)
    expect(c.failures.some((f) => f.includes("escapes its cell"))).toBe(true)
  })

  test("a contained SpendCell with no State badge fails on the empty badge scope", () => {
    const c = new Checker()
    const meas = keysPage(INSIDE, [])
    assertKeys(c, { tables: [{ ...meas.tables[0], badges: [] }] })
    expect(c.failures.some((f) => f.includes("zero State badges"))).toBe(true)
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
