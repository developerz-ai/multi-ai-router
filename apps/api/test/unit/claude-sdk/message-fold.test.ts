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
