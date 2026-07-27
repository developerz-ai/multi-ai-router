import { describe, expect, test } from "bun:test"
import {
  formatModelAliases,
  formatModelList,
  parseModelAliases,
} from "../../src/lib/account-models"

/**
 * The alias map's two sides are not interchangeable: a key is what a **client**
 * sends, a value is the name that goes **upstream** (`services/routing/model.ts`).
 * A map written the wrong way round is a router that answers 503 for the model
 * it was configured to serve, so the direction is what these pin down.
 */
describe("parseModelAliases", () => {
  test("reads one pair per line, left requested, right upstream", () => {
    const parsed = parseModelAliases("claude-sonnet-4-5 = glm-4.6\nclaude-opus-4-1 = glm-4.7")
    expect(parsed).toEqual({
      ok: true,
      aliases: { "claude-sonnet-4-5": "glm-4.6", "claude-opus-4-1": "glm-4.7" },
    })
  })

  test("an empty box is an empty map, not a failure", () => {
    expect(parseModelAliases("")).toEqual({ ok: true, aliases: {} })
    expect(parseModelAliases("\n\n   \n")).toEqual({ ok: true, aliases: {} })
  })

  test("tolerates spacing around the separator and blank lines between pairs", () => {
    const parsed = parseModelAliases("  a=b  \n\n   c   =   d\n")
    expect(parsed).toEqual({ ok: true, aliases: { a: "b", c: "d" } })
  })

  test("keeps everything after the first separator, so a target may contain one", () => {
    expect(parseModelAliases("a = b=c")).toEqual({ ok: true, aliases: { a: "b=c" } })
  })

  test("refuses a line that is not a pair, and says which line", () => {
    expect(parseModelAliases("a = b\nglm-4.6")).toEqual({
      ok: false,
      error: 'line 2 is not a pair — write "requested = upstream"',
    })
  })

  test("refuses a half-empty pair rather than mapping a name to nothing", () => {
    expect(parseModelAliases("a =")).toEqual({
      ok: false,
      error: "line 1 has an empty side — both names are required",
    })
    expect(parseModelAliases(" = b")).toEqual({
      ok: false,
      error: "line 1 has an empty side — both names are required",
    })
  })

  test("refuses a requested name mapped twice instead of quietly keeping one", () => {
    // Last-wins would store a map that does not do what the box on screen plainly says.
    expect(parseModelAliases("a = b\na = c")).toEqual({
      ok: false,
      error: '"a" is mapped twice — one rule per requested name',
    })
  })
})

describe("formatModelAliases", () => {
  test("round-trips a stored map back into the box unchanged", () => {
    const aliases = { "claude-sonnet-4-5": "glm-4.6", "claude-opus-4-1": "glm-4.7" }
    const parsed = parseModelAliases(formatModelAliases(aliases))
    expect(parsed).toEqual({ ok: true, aliases })
  })

  test("an account with no map is an empty box", () => {
    expect(formatModelAliases(null)).toBe("")
    expect(formatModelAliases({})).toBe("")
  })
})

describe("formatModelList", () => {
  test("prints the declared list in the order the account holds it", () => {
    expect(formatModelList(["glm-4.7", "glm-4.6"])).toBe("glm-4.7, glm-4.6")
  })

  test("an undeclared account is an empty box, which means passthrough", () => {
    expect(formatModelList(null)).toBe("")
    expect(formatModelList([])).toBe("")
  })
})
