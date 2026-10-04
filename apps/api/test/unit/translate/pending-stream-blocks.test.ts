import { expect, test } from "bun:test"
import { createPendingStreamBlocks } from "../../../src/services/translate/shared/pending-stream-blocks"

test("split surrogate fragments release precisely their reserved text and argument charges", () => {
  const pending = createPendingStreamBlocks(1024)
  for (let i = 0; i < 1000; i++) {
    expect(pending.text("\ud83d")).toBe(true)
    expect(pending.text("\ude42")).toBe(true)
    expect(pending.shift()).toMatchObject({ text: "🙂" })
    expect(pending.add("call", { id: "id", name: "f" })).toBe(true)
    expect(pending.append("call", "\ud83d")).toBe(true)
    expect(pending.append("call", "\ude42")).toBe(true)
    expect(pending.shift()).toMatchObject({ args: "🙂" })
  }
  expect(pending.text("x".repeat(897))).toBe(false)
  expect(pending.text("x".repeat(896))).toBe(true)
  expect(pending.shift()).toMatchObject({ text: "x".repeat(896) })
  expect(pending.text("x".repeat(896))).toBe(true)
})
