import { describe, expect, test } from "bun:test"
import {
  AUDIT_LIMIT_DEFAULT,
  auditDetailEntries,
  auditKinds,
  auditSubjectText,
  mergeKinds,
  safeAuditLimit,
} from "../../src/lib/api/audit"

/**
 * What the audit surface computes: the limit it is allowed to ask for, the kinds its filter can
 * offer, and how a detail object and a subject fit in a table cell without being dumped raw.
 */

describe("safeAuditLimit", () => {
  test("passes an accepted limit through untouched", () => {
    expect(safeAuditLimit(1)).toBe(1)
    expect(safeAuditLimit(50)).toBe(50)
    expect(safeAuditLimit(200)).toBe(200)
  })

  test("never sends a limit the server answers 400 to — it falls back rather than clamping", () => {
    // The server accepts 1..200 and rejects the rest. Clamping 500 to 200 would put a page on
    // screen nobody asked for; the default is the honest fallback.
    expect(safeAuditLimit(0)).toBe(AUDIT_LIMIT_DEFAULT)
    expect(safeAuditLimit(201)).toBe(AUDIT_LIMIT_DEFAULT)
    expect(safeAuditLimit(-5)).toBe(AUDIT_LIMIT_DEFAULT)
    expect(safeAuditLimit(50.5)).toBe(AUDIT_LIMIT_DEFAULT)
    expect(safeAuditLimit(Number.NaN)).toBe(AUDIT_LIMIT_DEFAULT)
  })
})

const event = (kind: string, detail: Readonly<Record<string, unknown>> | null = null) => ({
  id: kind,
  kind,
  subjectType: null,
  subjectId: null,
  detail,
  createdAt: "2026-07-25T11:00:00.000Z",
})

describe("the audit filter", () => {
  test("offers the kinds present, de-duplicated and ordered", () => {
    const kinds = auditKinds([event("key.viewed"), event("account.added"), event("key.viewed")])
    expect(kinds).toEqual(["account.added", "key.viewed"])
  })

  test("keeps kinds seen earlier, because a filtered page cannot list the ones to switch to", () => {
    expect(mergeKinds(["key.created"], ["account.added", "key.created"])).toEqual([
      "account.added",
      "key.created",
    ])
  })
})

describe("auditDetailEntries", () => {
  test("renders a detail object as key/value pairs rather than a JSON blob", () => {
    const entries = auditDetailEntries({ name: "ci", scope: "all", count: 3 })
    expect(entries.map((entry) => entry.key)).toEqual(["name", "scope", "count"])
    expect(entries[2]?.value).toBe("3")
  })

  test("truncates a long value for the cell while keeping the whole one for the tooltip", () => {
    const long = "x".repeat(120)
    const entry = auditDetailEntries({ reason: long })[0]
    expect(entry?.value.length).toBeLessThan(long.length)
    expect(entry?.value.endsWith("…")).toBe(true)
    expect(entry?.full).toBe(long)
  })

  test("no detail is no entries, never the string 'null' in a cell", () => {
    expect(auditDetailEntries(null)).toEqual([])
  })
})

describe("auditSubjectText", () => {
  test("shortens a uuid, because its head identifies it", () => {
    expect(auditSubjectText("0f6c9f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f")).toBe("0f6c9f4e…")
  })

  test("prints a non-uuid subject in full — a settings change and a login both name one", () => {
    expect(auditSubjectText("price_overrides")).toBe("price_overrides")
    expect(auditSubjectText("admin")).toBe("admin")
  })
})
