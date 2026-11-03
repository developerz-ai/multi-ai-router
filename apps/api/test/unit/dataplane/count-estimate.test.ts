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
 *  - the count is a function of the **serialized prompt content** — every string value, and
 *    inside the content the object keys and the primitive leaves (numbers, booleans, null) that
 *    a tool input or a tool schema is made of, because a tokenizer meets them serialized into
 *    the conversation;
 *  - only the request envelope is excluded — the top-level fields that configure the call
 *    (`model`, `max_tokens`, `stream`, …), key and value alike;
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
    // The first regression: an earlier estimate stripped JSON punctuation characters out of the
    // raw body, which also stripped them out of prompt strings — a content growing by 100,000
    // colons estimated exactly the same as before it grew, and a client compacting on the
    // estimate compacted too late.
    const before = estimateTokenCount(request("say it"))
    const after = estimateTokenCount(request(`say it${":".repeat(100000)}`))

    expect(after.inputTokens).toBeGreaterThan(before.inputTokens)
    expect(after.inputTokens - before.inputTokens).toBeGreaterThanOrEqual(
      100000 / ESTIMATE_CHARS_PER_TOKEN,
    )
  })

  test("a tool_use.input array growing from empty to 100,000 numbers moves the count", () => {
    // The second regression, and the one a string-only walker cannot see: tool-call history
    // grows as serialized JSON, and a numeric leaf is text the model reads exactly like a string
    // is. An estimate that counted string values only left this growth invisible, and the client
    // compacting on it never compacted.
    const body = (input: readonly number[]) =>
      encode(
        JSON.stringify({
          model: "claude-opus-5",
          messages: [{ role: "assistant", content: [{ type: "tool_use", name: "plot", input }] }],
        }),
      )

    const before = estimateTokenCount(body([]))
    const after = estimateTokenCount(body(Array.from({ length: 100000 }, (_, i) => i)))

    expect(after.inputTokens).toBeGreaterThan(before.inputTokens)
    expect(after.inputTokens - before.inputTokens).toBeGreaterThanOrEqual(
      100000 / ESTIMATE_CHARS_PER_TOKEN,
    )
  })

  test("counts keys and primitive leaves of the content, not only strings", () => {
    // `n: 123`, `ok: true` and `note: null` are serialized into the conversation like the strings
    // around them. Counted — keys: "messages" (8), "role" (4), "content" (7), "type" (4), "name"
    // (4), "input" (5), "n" (1), "ok" (2), "note" (4) = 39; values: "user" (4), "tool_use" (8),
    // "plot" (4), "123" (3), "true" (4), "null" (4) = 27. "model" is envelope.
    const estimate = estimateTokenCount(
      encode(
        JSON.stringify({
          model: "m",
          messages: [
            {
              role: "user",
              content: [
                { type: "tool_use", name: "plot", input: { n: 123, ok: true, note: null } },
              ],
            },
          ],
        }),
      ),
    )
    expect(estimate.inputTokens).toBe(Math.ceil((39 + 27) / ESTIMATE_CHARS_PER_TOKEN))
  })

  test("counts every character of the prompt strings, punctuation included", () => {
    // Counted — keys: "messages" (8), "role" (4), "content" (7) = 19; values: "user" (4) and the
    // content (16, punctuation and all) = 20. `model` is envelope: excluded, key and value.
    const content = 'a:b, c[d]{e} "f"'
    expect([...content].length).toBe(16)

    const estimate = estimateTokenCount(request(content))
    expect(estimate.inputTokens).toBe(Math.ceil(39 / ESTIMATE_CHARS_PER_TOKEN))
  })

  test("counts content blocks, system text and tool inputs, not just plain string content", () => {
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

    // Keys: "system" (6), "messages" (8), "role" (4), "content" (7), "type" (4), "text" (4),
    // "type" (4), "name" (4), "input" (5), "pattern" (7) = 53. Values: "be brief" (8), "user"
    // (4), "text" (4), "hello" (5), "tool_use" (8), "grep" (4), "a.b" (3) = 36.
    expect(estimate.inputTokens).toBe(Math.ceil(89 / ESTIMATE_CHARS_PER_TOKEN))
  })

  test("a tool schema counts whole: its keys and primitives included", () => {
    // A schema reaches the model as serialized JSON, so it is prompt all the way down.
    const estimate = estimateTokenCount(
      encode(
        JSON.stringify({
          model: "m",
          tools: [
            {
              name: "grep",
              description: "search files",
              input_schema: {
                type: "object",
                properties: { pattern: { type: "string" } },
                required: ["pattern"],
              },
            },
          ],
        }),
      ),
    )

    // Keys: "tools" (5), "name" (4), "description" (11), "input_schema" (12), "type" (4),
    // "properties" (10), "pattern" (7), "type" (4), "required" (8) = 65. Values: "grep" (4),
    // "search files" (12), "object" (6), "string" (6), "pattern" (7) = 35.
    expect(estimate.inputTokens).toBe(Math.ceil(100 / ESTIMATE_CHARS_PER_TOKEN))
  })

  test("counts JSON-escaped content decoded, not as its escaped wire bytes", () => {
    // `say "hi" \ done` travels as `say \"hi\" \\ done`; a tokenizer meets the decoded text, so
    // the backslashes the JSON envelope added are not prompt.
    const estimate = estimateTokenCount(request('say "hi" \\ done'))

    // Keys "messages" (8), "role" (4), "content" (7); values "user" (4) and the decoded content
    // (15) — 38.
    expect(estimate.inputTokens).toBe(Math.ceil(38 / ESTIMATE_CHARS_PER_TOKEN))
  })

  test("only the request envelope is excluded: config fields change no number", () => {
    const messages = [{ role: "user", content: "count me" }]
    const estimate = (envelope: Record<string, unknown>) =>
      estimateTokenCount(encode(JSON.stringify({ ...envelope, messages })))

    const base = estimate({ model: "claude-opus-5", max_tokens: 64 })
    // The envelope is the request's configuration, and the model name in particular is not
    // context: renaming the model, re-tuning the sampling or stuffing the metadata moves
    // nothing, because none of it is text the tokenizer meets.
    expect(
      estimate({ model: "a-much-longer-model-name-than-before", max_tokens: 64000 }).inputTokens,
    ).toBe(base.inputTokens)
    expect(
      estimate({
        model: "claude-opus-5",
        stream: true,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ["STOP", "STOP AGAIN"],
        metadata: { user_id: "a-rather-long-user-id" },
        thinking: { type: "enabled", budget_tokens: 4096 },
        tool_choice: { type: "tool", name: "grep" },
        service_tier: "standard_only",
      }).inputTokens,
    ).toBe(base.inputTokens)
  })

  test("the envelope contributes nothing: pretty-printing changes no number", () => {
    const document = {
      model: "claude-opus-5",
      messages: [{ role: "user", content: "how many tokens is this" }],
    }

    const compact = estimateTokenCount(encode(JSON.stringify(document)))
    const pretty = estimateTokenCount(encode(JSON.stringify(document, null, 2)))

    // Same document, very different bytes: whitespace and structure are not prompt.
    expect(pretty.inputTokens).toBe(compact.inputTokens)
    expect(pretty.basis).toBe(ESTIMATE_BASIS)
  })

  test("an empty document estimates zero", () => {
    expect(estimateTokenCount(encode("[]")).inputTokens).toBe(0)
    expect(estimateTokenCount(encode("{}")).inputTokens).toBe(0)
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

    // Keys "messages" (8), "role" (4), "content" (7); values "user" (4) and 3 characters — 26.
    expect(estimate.inputTokens).toBe(Math.ceil(26 / ESTIMATE_CHARS_PER_TOKEN))
  })
})
