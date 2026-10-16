import { describe, expect, test } from "bun:test"
import { isIsoDateTime } from "../../src/iso-datetime"

/** The contract the usage read's `from`/`to` and the console's URL parser both gate on. */

describe("isIsoDateTime", () => {
  test("accepts what the page writes and the API serves: full ISO with Z", () => {
    expect(isIsoDateTime("2026-10-01T00:00:00.000Z")).toBe(true)
    expect(isIsoDateTime("2026-10-01T00:00:00Z")).toBe(true)
  })

  test("refuses shapes Date.parse accepts but the API would 400", () => {
    for (const value of ["2026/10/01", "10/01/2026", "2026-10-01", "October 1, 2026"]) {
      expect(isIsoDateTime(value)).toBe(false)
    }
  })

  test("refuses offsets and missing seconds — z.iso.datetime is Z-only here", () => {
    expect(isIsoDateTime("2026-10-01T00:00:00+02:00")).toBe(false)
    expect(isIsoDateTime("2026-10-01T00:00Z")).toBe(false)
  })
})
