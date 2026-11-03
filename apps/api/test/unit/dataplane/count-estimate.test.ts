import { describe, expect, test } from "bun:test"
import {
  ESTIMATE_BASIS,
  ESTIMATE_CHARS_PER_TOKEN,
  estimateTokenCount,
} from "../../../src/services/dataplane/count-estimate"

/**
 * The router's own `count_tokens` estimate, as a pure function: bytes in, one number out.
 *
 * The rules pinned here:
 *
 *  - the count is a function of the **decoded prompt content** — every string value of the parsed
 *    body, punctuation included, because punctuation inside a prompt is text the model reads;
 *  - the JSON envelope contributes nothing — keys, structure and whitespace are not prompt;
 *  - JSON-escaped content is counted decoded, not as its escaped wire bytes;
 *  - it is total: the same bytes always produce the same number, and a body the parser rejects
 *    still produces a number rather than an exception.
 */

const encode = (body: string) => new TextEncoder().encode(body)

function request(content: unknown): Uint8Array {
  return encode(
    JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content }],
    }),
  )
}

describe("content sensitivity", () => {
  test("punctuation inside the prompt is prompt: 100,000 colons raise the count", () => {
    // The regression: an earlier estimate stripped JSON punctuation characters out of the raw
    // body, which also stripped them out of prompt strings — a content growing by 100,000 colons
    // estimated exactly the same as before it grew, and a client compacting on the estimate
    // compacted too late.
    const before = estimateTokenCount(request("say it"))
    const after = estimateTokenCount(request(`say it${":".repeat(100000)}`))

    expect(after.inputTokens).toBeGreaterThan(before.inputTokens)
    expect(after.inputTokens - before.inputTokens).toBeGreaterThanOrEqual(
      100000 / ESTIMATE_CHARS_PER_TOKEN,
    )
  })

  test("counts every character of the prompt strings, punctuation included", () => {
    // String values in this document: "claude-opus-5" (13), "user" (4) and the content below
    // (16, punctuation and all). Nothing else — the keys are envelope.
    const content = 'a:b, c[d]{e} "f"'
    expect([...content].length).toBe(16)

    const estimate = estimateTokenCount(request(content))
    expect(estimate.inputTokens).toBe(Math.ceil((13 + 4 + 16) / ESTIMATE_CHARS_PER_TOKEN))
  })

  test("counts content blocks and system text, not just plain string content", () => {
    const estimate = estimateTokenCount(
      encode(
        JSON.stringify({
          model: "m",
          system: "be brief",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "hello" },
                { type: "tool_use", name: "grep", input: { pattern: "a.b" } },
              ],
            },
          ],
        }),
      ),
    )

    // String values: "m" (1), "be brief" (8), "user" (4), "text" (4), "hello" (5), "tool_use" (8),
    // "grep" (4), "pattern" is a key (0), "a.b" (3) — 37 characters.
    expect(estimate.inputTokens).toBe(Math.ceil(37 / ESTIMATE_CHARS_PER_TOKEN))
  })

  test("counts JSON-escaped content decoded, not as its escaped wire bytes", () => {
    // `say "hi" \ done` travels as `say \"hi\" \\ done`; a tokenizer meets the decoded text, so
    // the backslashes the JSON envelope added are not prompt.
    const estimate = estimateTokenCount(request('say "hi" \\ done'))

    // "claude-opus-5" (13) + "user" (4) + the decoded content (15).
    expect(estimate.inputTokens).toBe(Math.ceil((13 + 4 + 15) / ESTIMATE_CHARS_PER_TOKEN))
  })

  test("the envelope contributes nothing: pretty-printing changes no number", () => {
    const document = {
      model: "claude-opus-5",
      messages: [{ role: "user", content: "how many tokens is this" }],
    }

    const compact = estimateTokenCount(encode(JSON.stringify(document)))
    const pretty = estimateTokenCount(encode(JSON.stringify(document, null, 2)))

    // Same document, very different bytes: whitespace, key quotes and structure are not prompt.
    expect(pretty.inputTokens).toBe(compact.inputTokens)
    expect(pretty.basis).toBe(ESTIMATE_BASIS)
  })

  test("non-string leaves are not prompt, and an empty document estimates zero", () => {
    const empty = estimateTokenCount(encode(JSON.stringify({ model: 5, messages: [] })))
    expect(empty.inputTokens).toBe(0)
    expect(estimateTokenCount(encode("[]")).inputTokens).toBe(0)
  })
})

describe("totality", () => {
  test("a body that is not JSON still estimates — the raw text, whole", () => {
    // No parsed document, so no content/envelope distinction to make: every character counts
    // rather than the estimate pretending it saw a prompt it did not.
    const raw = "not json at all {{"
    const estimate = estimateTokenCount(encode(raw))

    expect(estimate.inputTokens).toBe(Math.ceil([...raw].length / ESTIMATE_CHARS_PER_TOKEN))
  })

  test("a deeply nested body cannot turn the estimate into a crash", () => {
    // The walk is iterative: nesting depth is client-shaped input, and an estimate that overflowed
    // the call stack would 500 a request it could have answered.
    const deep = `${"[".repeat(50000)}${"]".repeat(50000)}`
    expect(() => estimateTokenCount(encode(deep))).not.toThrow()
  })

  test("multi-byte characters count once each", () => {
    // Counted as code points, the units a tokenizer meets — not as UTF-16 units or bytes.
    const estimate = estimateTokenCount(request("日本語"))

    // "claude-opus-5" (13) + "user" (4) + 3 characters.
    expect(estimate.inputTokens).toBe(Math.ceil(20 / ESTIMATE_CHARS_PER_TOKEN))
  })
})
