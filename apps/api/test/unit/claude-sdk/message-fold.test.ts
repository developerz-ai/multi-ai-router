import { expect, test } from "bun:test"
import { createMessageFold } from "../../../src/providers/claude-sdk/render/message"

test("citations fold onto the block's list, as a streaming client assembles them", () => {
  for (const block of [
    { type: "text", text: "", citations: [] },
    { type: "text", text: "", citations: null },
    { type: "text", text: "" },
  ]) {
    const fold = createMessageFold()
    const cited = (text: string) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "citations_delta", citation: { type: "char_location", cited_text: text } },
    })
    fold.push([
      { type: "message_start", message: { id: "m" } },
      { type: "content_block_start", index: 0, content_block: block },
      cited("one"),
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      cited("two"),
      { type: "content_block_stop", index: 0 },
    ])
    expect(fold.body().content).toEqual([
      {
        type: "text",
        text: "hi",
        citations: [
          { type: "char_location", cited_text: "one" },
          { type: "char_location", cited_text: "two" },
        ],
      },
    ])
  }
})

test("a citation is appended to one list the fold owns, never a fresh copy or the frame's", () => {
  const stated: unknown[] = ["stated"]
  const fold = createMessageFold()
  const cite = (citation: string) =>
    fold.push([
      { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation } },
    ])
  const held = (): unknown => {
    const content: unknown = fold.body().content
    const block: unknown = Array.isArray(content) ? content[0] : undefined
    return typeof block === "object" && block !== null ? Reflect.get(block, "citations") : undefined
  }
  fold.push([
    { type: "message_start", message: { id: "m" } },
    { type: "content_block_start", index: 0, content_block: { type: "text", citations: stated } },
  ])
  cite("one")
  const list = held()
  cite("two")
  expect(held()).toBe(list)
  expect(list).toEqual(["stated", "one", "two"])
  expect(stated).toEqual(["stated"])
})
