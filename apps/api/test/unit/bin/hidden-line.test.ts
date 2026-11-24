import { describe, expect, test } from "bun:test"
import { createHiddenLineReader } from "../../../src/bin/hidden-line"

function type(...chunks: string[]) {
  const reader = createHiddenLineReader()
  const lines: string[] = []
  for (const chunk of chunks) {
    const read = reader.push(chunk)
    lines.push(...read.lines)
    if (read.aborted) return { lines, aborted: true }
  }
  return { lines, aborted: false }
}

describe("a hidden password prompt", () => {
  test("both lines pasted in one read are both kept", () => {
    expect(type("secret\rsecret\r").lines).toEqual(["secret", "secret"])
    expect(type("secret\r\nsecret\r\n").lines).toEqual(["secret", "secret"])
    expect(type("secret\r", "\nsecret\n").lines).toEqual(["secret", "secret"])
    expect(type("secret\rsec", "ret\r").lines).toEqual(["secret", "secret"])
  })

  test("a key that is not a character never becomes part of the password", () => {
    expect(type("ab\u001b[Dc\r").lines).toEqual(["abc"])
    expect(type("ab\u001b[1;5Dc\u001bOHd\r").lines).toEqual(["abcd"])
    expect(type("\u001b[200~pasted\u001b[201~\r").lines).toEqual(["pasted"])
    expect(type("a\u001b", "[", "Db\r").lines).toEqual(["ab"])
    expect(type("a\u0000\u0001\tb\r").lines).toEqual(["ab"])
  })

  test("a lone Escape never swallows Enter or Ctrl-C", () => {
    expect(type("abc\u001b\r").lines).toEqual(["abc"])
    expect(type("abc\u001b[\r").lines).toEqual(["abc"])
    expect(type("abc\u001b", "\u0003").aborted).toBe(true)
    expect(type("abc\u001b[", "\u0003").aborted).toBe(true)
    expect(type("abc\u001b\u001b[Dd\r").lines).toEqual(["abcd"])
  })

  test("a backspace takes back a whole character, and Ctrl-U the line", () => {
    expect(type("pässword😀\u007f\r").lines).toEqual(["pässword"])
    expect(type("\u007f\u007fa\r").lines).toEqual(["a"])
    expect(type("wrong\u0015right\r").lines).toEqual(["right"])
  })

  test("Ctrl-C aborts anywhere; Ctrl-D only on an empty line", () => {
    expect(type("abc\u0003").aborted).toBe(true)
    expect(type("\u0004").aborted).toBe(true)
    expect(type("abc\u0004d\r")).toEqual({ lines: ["abcd"], aborted: false })
  })

  test("spaces and every printable character are kept as typed", () => {
    expect(type(" a b~ü漢 \r").lines).toEqual([" a b~ü漢 "])
  })
})
