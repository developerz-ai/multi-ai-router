// Geometry extraction (runs inside the page) and the assertion engine (runs in
// the gate process). Split at the process boundary on purpose: the page side is
// pure DOM measurement returning JSON, the Node side owns every rule, so a
// failing rule reads as a sentence about layout, not about selectors.
//
// Selectors: Vite compiles SCSS-module locals to `_figures_<hash>_<n>` — the
// local name survives verbatim inside the generated class, so
// `[class*="_figures_"]` pins TrafficCell's cost block, `[class*="_spend_"]`
// SpendCell's dl (and TrafficCell's inline spend span — the cost *text*), and
// `[class*="_badge_"]` the Badge pill (singular; CredentialCell's plural
// `_badges_` container does not contain `_badge_`). If a component renames its
// locals, the zero-match rule below turns the drift into a failed run instead of
// a silently green one — that rule is the reason #94 could not happen to *this*
// gate.
import type { Page } from "playwright"

/** Sub-pixel tolerance: getBoundingClientRect rounds, CSS lays out in fractions. */
export const EPS = 0.5

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BadgeMeas {
  readonly text: string
  readonly box: Box
  readonly background: string
}

export interface RowMeas {
  readonly costCell: Box
  readonly costBlock: Box | null
  readonly costText: Box | null
  readonly badges: readonly BadgeMeas[]
  readonly otherCells: readonly Box[]
}

export interface TableMeas {
  readonly headers: readonly string[]
  readonly rows: readonly RowMeas[]
  readonly badges: readonly BadgeMeas[]
}

export interface PageMeas {
  readonly tables: readonly TableMeas[]
}

interface MeasureArgs {
  readonly costHeaderPrefix: string
  readonly credentialHeader: string | null
}

/** Serialized into the page by Playwright — no closures over gate-process state. */
function measureTables(args: MeasureArgs): PageMeas {
  const box = (el: Element): Box => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }
  const badgeEls = (root: ParentNode): Element[] => [...root.querySelectorAll('[class*="_badge_"]')]
  const badge = (el: Element): BadgeMeas => ({
    text: (el.textContent ?? "").trim(),
    box: box(el),
    background: getComputedStyle(el).backgroundColor,
  })

  return {
    tables: [...document.querySelectorAll("table")].map((table) => {
      const headers = [...table.querySelectorAll("thead th")].map((th) =>
        (th.textContent ?? "").trim(),
      )
      const costIdx = headers.findIndex((h) => h.startsWith(args.costHeaderPrefix))
      const credIdx = args.credentialHeader === null ? -1 : headers.indexOf(args.credentialHeader)
      const rows = [...table.querySelectorAll("tbody tr")].map((tr) => {
        const tds = [...tr.children]
        const costTd = costIdx === -1 ? null : (tds[costIdx] ?? null)
        const credTd = credIdx === -1 ? null : (tds[credIdx] ?? null)
        const blockEl = costTd?.querySelector('[class*="_figures_"], [class*="_spend_"]') ?? null
        const textEl = costTd?.querySelector('[class*="_spend_"]') ?? null
        return {
          costCell: costTd === null ? { x: 0, y: 0, width: 0, height: 0 } : box(costTd),
          costBlock: blockEl === null ? null : box(blockEl),
          costText: textEl === null ? null : box(textEl),
          badges: credTd === null ? [] : badgeEls(credTd).map(badge),
          otherCells:
            costIdx === -1 ? [] : tds.filter((_, i) => i !== costIdx).map((td) => box(td)),
        }
      })
      return { headers, rows, badges: badgeEls(table).map(badge) }
    }),
  }
}

/** Measure one rendered page. `costHeaderPrefix` picks the column the cost block lives in. */
export async function measure(page: Page, args: MeasureArgs): Promise<PageMeas> {
  return (await page.evaluate(measureTables, args)) as PageMeas
}

// ------------------------------------------------------------------ assertions

export interface Finding {
  readonly ok: boolean
  readonly detail: string
}

/** Collects findings; a run fails if any is not ok. */
export class Checker {
  private readonly items: Finding[] = []

  check(ok: boolean, detail: string): void {
    this.items.push({ ok, detail })
  }

  get failures(): readonly string[] {
    return this.items.filter((f) => !f.ok).map((f) => f.detail)
  }

  get passed(): number {
    return this.items.filter((f) => f.ok).length
  }
}

const right = (b: Box): number => b.x + b.width
const bottom = (b: Box): number => b.y + b.height

/** b inside outer on all four sides, within EPS. */
export function contained(inner: Box, outer: Box): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    right(inner) <= right(outer) + EPS &&
    bottom(inner) <= bottom(outer) + EPS
  )
}

/** Overlap beyond EPS on both axes. */
export function intersects(a: Box, b: Box): boolean {
  const overlapX = Math.min(right(a), right(b)) - Math.max(a.x, b.x)
  const overlapY = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y)
  return overlapX > EPS && overlapY > EPS
}

/** How far inside `inner` sits within `outer` — the number the report prints. */
export function clearance(inner: Box, outer: Box): number {
  return Math.min(
    inner.x - outer.x,
    inner.y - outer.y,
    right(outer) - right(inner),
    bottom(outer) - bottom(inner),
  )
}

/** Gap between two boxes; negative when they already overlap. */
export function gap(a: Box, b: Box): number {
  const dx = Math.max(a.x - right(b), b.x - right(a))
  const dy = Math.max(a.y - bottom(b), b.y - bottom(a))
  return Math.max(dx, dy)
}

/** `rgb(r, g, b)` or `rgba(r, g, b, a)` → alpha, defaulting to fully opaque. */
export function backgroundAlpha(color: string): number {
  const m = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+)\s*)?\)/.exec(color)
  if (m === null) return Number.NaN
  return m[1] === undefined ? 1 : Number.parseFloat(m[1])
}
