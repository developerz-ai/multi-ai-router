import { describe, expect, test } from "bun:test"
import { createRoutingScanner, MODEL_NAME_MAX_BYTES } from "../../../src/services/dataplane"

const encoder = new TextEncoder()
function scan(body: string, chunkSize = body.length) {
  const scanner = createRoutingScanner()
  const bytes = encoder.encode(body)
  for (let at = 0; at < bytes.length; at += chunkSize) {
    scanner.push(bytes.subarray(at, at + chunkSize))
  }
  return scanner.finish()
}

describe("routing scanner", () => {
  test.each([NaN, Infinity, -Infinity, 0, -1, 1.5, 65537])(
    "rejects unsafe prefix %p at the factory boundary",
    (value) => {
      expect(() => createRoutingScanner({ conversationPrefixBytes: value })).toThrow(RangeError)
    },
  )
  test.each([NaN, Infinity, -Infinity, 0, 1, -1, 2.5, 4097])(
    "rejects unsafe depth %p at the factory boundary",
    (value) => {
      expect(() => createRoutingScanner({ maximumJsonDepth: value })).toThrow(RangeError)
    },
  )
  test("bounded factory defaults and endpoints accept valid input", () => {
    for (const options of [
      {},
      { conversationPrefixBytes: 1 },
      { conversationPrefixBytes: 65536 },
      { maximumJsonDepth: 2 },
      { maximumJsonDepth: 4096 },
    ]) {
      const scanner = createRoutingScanner(options)
      scanner.push(encoder.encode('{"model":"m","messages":[{"role":"user","content":"hi"}]}'))
      if (options.maximumJsonDepth === 2) {
        expect(scanner.finish().depthExceeded).toBe(true)
      } else expect(scanner.finish().invalid).toBe(false)
    }
  })
  test.each([2, 8, 256, 4096])(
    "accepts configured depth %p and refuses one over",
    (maximumJsonDepth) => {
      const body = (depth: number) =>
        '{"model":"m","other":' + "[".repeat(depth - 1) + "0" + "]".repeat(depth - 1) + "}"
      const at = createRoutingScanner({ maximumJsonDepth })
      at.push(encoder.encode(body(maximumJsonDepth)))
      expect(at.finish().invalid).toBe(false)
      const over = createRoutingScanner({ maximumJsonDepth })
      over.push(encoder.encode(body(maximumJsonDepth + 1)))
      expect(over.finish().depthExceeded).toBe(true)
    },
  )
  test("rejects a non-object root permanently without capturing a child model", () => {
    for (const body of [
      '[{"model":"nested"}]',
      'null {"model":"nested"}',
      '42 {"model":"nested"}',
    ]) {
      for (const size of [1, 3, 99]) {
        const result = scan(body, size)
        expect(result.invalid).toBe(true)
        expect(result.model).toBeNull()
        expect(result.modelSpan).toBeNull()
      }
    }
  })

  test("finds the top-level model and its byte span", () => {
    const body = '{"model":"claude-opus-5","max_tokens":16}'
    const result = scan(body)

    expect(result.model).toBe("claude-opus-5")
    expect(body.slice(result.modelSpan?.start, result.modelSpan?.end)).toBe("claude-opus-5")
  })

  test("finds it identically however the bytes are chunked", () => {
    const body = '{"messages":[{"role":"user","content":"hi"}],"model":"gpt-5"}'
    for (const size of [1, 3, 7, 64]) {
      expect(scan(body, size).model).toBe("gpt-5")
    }
  })

  test("ignores a nested key named model — only the top level routes", () => {
    const result = scan('{"messages":[{"model":"decoy"}],"model":"real"}')
    expect(result.model).toBe("real")
  })

  test("is not fooled by a brace or a quote inside a string", () => {
    const result = scan('{"system":"a { \\" }","model":"real"}')
    expect(result.model).toBe("real")
  })

  test("captures the conversation prefix from either dialect's field", () => {
    const anthropic = scan('{"model":"m","messages":[{"role":"user","content":"alpha"}]}')
    const responses = scan('{"model":"m","input":[{"role":"user","content":"alpha"}]}')

    expect(new TextDecoder().decode(anthropic.conversationPrefix)).toContain("alpha")
    expect(new TextDecoder().decode(responses.conversationPrefix)).toContain("alpha")
  })

  test("reports nothing rather than throwing on a body that is not JSON at all", () => {
    expect(scan("not json").model).toBeNull()
  })

  test("continues validating after routing fields and requires explicit EOF", () => {
    const scanner = createRoutingScanner({ conversationPrefixBytes: 8 })
    scanner.push(encoder.encode('{"model":"m","messages":[{"role":"user"}]'))
    expect(scanner.done).toBe(false)
    scanner.push(encoder.encode("}"))
    expect(scanner.finish().invalid).toBe(false)
  })

  test("takes a model right up to the ceiling", () => {
    const name = "m".repeat(MODEL_NAME_MAX_BYTES)
    const result = scan(`{"model":"${name}"}`)

    expect(result.model).toBe(name)
    expect(result.modelTooLong).toBe(false)
  })

  test("refuses one byte past it, and captures neither the value nor its span", () => {
    const name = "m".repeat(MODEL_NAME_MAX_BYTES + 1)
    const result = scan(`{"model":"${name}","messages":[]}`)

    expect(result.modelTooLong).toBe(true)
    // Never truncated — a shortened model name is a substituted model.
    expect(result.model).toBeNull()
    expect(result.modelSpan).toBeNull()
  })

  test("an over-long model preserves its distinct refusal after EOF validation", () => {
    const scanner = createRoutingScanner({ conversationPrefixBytes: 8 })
    scanner.push(encoder.encode(`{"messages":[{"role":"user"}],"model":"${"m".repeat(9_000)}"}`))
    expect(scanner.done).toBe(false)
    expect(scanner.finish().modelTooLong).toBe(true)
  })

  test("duplicate models are ambiguous even when the first exceeds the ceiling", () => {
    const result = scan(`{"model":"${"m".repeat(9_000)}","model":"short"}`)

    expect(result.modelTooLong).toBe(true)
    expect(result.model).toBeNull()
    expect(result.duplicateModel).toBe(true)
  })

  test("an enormous key or payload value cannot mask, corrupt, or become the model", () => {
    // The other two strings the ceiling touches: a hostile top-level key, and a
    // `system` prompt, which is a top-level string and is routinely kilobytes.
    // Neither is accumulated — that part is a cost, not a behaviour, so what is
    // pinned here is that abandoning them mid-string leaves the scan intact and
    // the real model still comes out, at any chunking.
    const body = `{"${"k".repeat(9_000)}":"decoy","system":"${"s".repeat(200_000)}","model":"real"}`
    for (const size of [1, 997, 65_536]) {
      const result = scan(body, size)
      expect(result.model).toBe("real")
      expect(result.modelTooLong).toBe(false)
    }
  })
})

function captureSiblingUserOpening(item: object, split: number) {
  const body = encoder.encode(JSON.stringify({ model: "m", messages: [item] }))
  const scanner = createRoutingScanner()
  scanner.push(body.subarray(0, split))
  scanner.push(body.subarray(split))
  const result = scanner.finish()
  expect(result.invalid).toBe(false)
  return new TextDecoder().decode(result.conversationPrefix)
}
test("sibling metadata cannot change whether the actual user content array is usable", () => {
  for (const roleLast of [false, true]) {
    const content = [{ type: "text", text: "hello" }]
    const nonempty = roleLast
      ? { content, metadata: {}, role: "user" }
      : { role: "user", content, metadata: {} }
    const empty = roleLast
      ? { content: [], metadata: { x: 1 }, role: "user" }
      : { role: "user", content: [], metadata: { x: 1 } }
    const maximum = encoder.encode(JSON.stringify({ model: "m", messages: [nonempty] })).length
    for (let split = 0; split <= maximum; split++) {
      expect(captureSiblingUserOpening(nonempty, split)).toBe(JSON.stringify(nonempty))
      expect(captureSiblingUserOpening(empty, split)).toBe("")
    }
  }
})

test("U+FEFF inside selected strings preserves raw and escaped JSON semantics", () => {
  for (const size of [1, 2, 7, 1000]) {
    for (const prefix of ["\uFEFF", String.raw`\uFEFF`]) {
      const value = scan(`{"model":"${prefix}real"}`, size)
      expect(value.invalid).toBe(false)
      expect(value.model).toBe("\uFEFFreal")
      const key = scan(`{"${prefix}model":"decoy","model":"real"}`, size)
      expect(key.invalid).toBe(false)
      expect(key.duplicateModel).toBe(false)
      expect(key.model).toBe("real")
      const missing = scan(`{"${prefix}model":"decoy"}`, size)
      expect(missing.model).toBeNull()
      const role = scan(`{"model":"m","messages":[{"role":"${prefix}user","content":"hi"}]}`, size)
      expect(role.conversationPrefix).toHaveLength(0)
    }
  }
})

test("a BOM outside JSON strings remains an invalid root", () => {
  for (const size of [1, 2, 1000]) {
    const result = scan('\uFEFF{"model":"real"}', size)
    expect(result.invalid).toBe(true)
    expect(result.model).toBeNull()
  }
})
