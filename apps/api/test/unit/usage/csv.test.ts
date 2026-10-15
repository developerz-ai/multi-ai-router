import { describe, expect, test } from "bun:test"
import { parse } from "csv-parse/sync"
import { CSV_EOL, csvLine, verbatim } from "../../../src/services/usage-read/csv"

/**
 * The CSV writer for the usage export (issue #226), read back through a real RFC 4180 parser
 * (csv-parse) rather than a parser written to agree with the writer.
 *
 * Every text cell is guarded: any router-key holder chooses the `model` string, so the guard is
 * a property of the writer, not of one column.
 */
const read = (text: string): string[][] => parse(text, { relax_quotes: false }) as string[][]
const one = (cell: Parameters<typeof csvLine>[0][number]) => read(csvLine([cell]))[0]?.[0]

describe("csvLine", () => {
  test("ends every record with CRLF, never a bare LF", () => {
    expect(CSV_EOL).toBe("\r\n")
    const line = csvLine(["a", "b"])
    expect(line).toBe(`a,b${CSV_EOL}`)
  })

  test("a leading = + - @ tab or CR gets a leading apostrophe", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(one(`${lead}SUM(1)`)).toBe(`'${lead}SUM(1)`)
    }
  })

  test("the guard runs before quoting: the parsed value carries the apostrophe", () => {
    expect(one('=HYPERLINK("x")')).toBe('\'=HYPERLINK("x")')
    // The raw bytes are the quoted, doubled form of the guarded value.
    expect(csvLine(['=HYPERLINK("x")'])).toBe(`"'=HYPERLINK(""x"")"${CSV_EOL}`)
  })

  test("a model that is a formula or starts with a tab is guarded like any other text", () => {
    expect(one("@SUM(1)")).toBe("'@SUM(1)")
    expect(one("\t=cmd|' /C calc'!A0")).toBe("'\t=cmd|' /C calc'!A0")
  })

  test("only a leading character is guarded", () => {
    expect(one("a=b")).toBe("a=b")
    expect(one("gpt-4")).toBe("gpt-4")
    expect(one("")).toBe("")
  })

  test("a value with a comma, quote or newline keeps the column count", () => {
    const row = ["a,b", 'say "hi"', "line1\nline2", "plain", "=x,y"]
    const parsed = read(csvLine(row))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toEqual(["a,b", 'say "hi"', "line1\nline2", "plain", "'=x,y"])
  })

  test("null and undefined are empty cells", () => {
    expect(read(csvLine(["a", null, "c"]))[0]).toEqual(["a", "", "c"])
    expect(csvLine([null])).toBe(`${CSV_EOL}`)
  })

  test("numbers are never guarded, a negative one included", () => {
    expect(read(csvLine([0, 12, -3, 1.5]))[0]).toEqual(["0", "12", "-3", "1.5"])
  })

  test("a verbatim cell (a date, a decimal) is not guarded but is still quoted if it must be", () => {
    expect(one(verbatim("2026-10-15"))).toBe("2026-10-15")
    expect(one(verbatim("-0.500000"))).toBe("-0.500000")
    expect(csvLine([verbatim("a,b")])).toBe(`"a,b"${CSV_EOL}`)
  })

  test("several rows parse back with a constant column count", () => {
    const text = csvLine(["h1", "h2"]) + csvLine(["a,b", "=c"]) + csvLine(["", "d"])
    expect(read(text)).toEqual([
      ["h1", "h2"],
      ["a,b", "'=c"],
      ["", "d"],
    ])
  })
})
