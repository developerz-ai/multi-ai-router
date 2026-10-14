import { describe, expect, test } from "bun:test"
import { KEY_LABEL_SLUG, KEY_LABEL_SLUG_HTML_PATTERN } from "../../src/index"

// The browser compiles an HTML `pattern` as `^(?:<pattern>)$` with the `v` flag,
// where an unescaped `-` in a class is a syntax error and the field silently
// stops validating. Both spellings of the rule must accept and reject the same.
const html = new RegExp(`^(?:${KEY_LABEL_SLUG_HTML_PATTERN})$`, "v")

const ACCEPT = ["marta", "claude-code", "ci_team", "a.b", "0abc", "a", "a".repeat(64)]
const REJECT = ["", "Marta", "-lead", ".dot", "_u", "has space", "a/b", " marta ", "a".repeat(65)]

describe("key label slug", () => {
  test("the HTML pattern compiles under the v flag", () => {
    expect(() => new RegExp(`^(?:${KEY_LABEL_SLUG_HTML_PATTERN})$`, "v")).not.toThrow()
  })

  test.each(ACCEPT)("accepts %p in both spellings", (value) => {
    expect(KEY_LABEL_SLUG.test(value)).toBe(true)
    expect(html.test(value)).toBe(true)
  })

  test.each(REJECT)("rejects %p in both spellings", (value) => {
    expect(KEY_LABEL_SLUG.test(value)).toBe(false)
    expect(html.test(value)).toBe(false)
  })
})
