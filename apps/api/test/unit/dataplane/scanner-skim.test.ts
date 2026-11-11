import { describe, expect, test } from "bun:test"
import { transcriptBody } from "../../../bench/transcript"
import { createRoutingScanner, type ScanResult } from "../../../src/services/dataplane/body/scanner"

/**
 * The skim (`body/skim.ts`) validates every subtree nothing is captured from, so it is held to
 * `JSON.parse` as an oracle: same verdict on valid and mutated bodies, at every chunking.
 */

const encoder = new TextEncoder()

function scan(bytes: Uint8Array, cuts: readonly number[]): ScanResult {
  const scanner = createRoutingScanner()
  let at = 0
  for (const cut of [...cuts, bytes.length]) {
    scanner.push(bytes.subarray(at, cut))
    at = cut
  }
  return scanner.finish()
}

/** Deterministic PRNG: a failing seed reproduces. */
function prng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

function parses(bytes: Uint8Array): boolean {
  try {
    // Fatal decoding: a mutated UTF-8 sequence is invalid to the scanner, so it must be to the oracle.
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    return typeof value === "object" && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
}

const BODIES = [
  transcriptBody({ model: "m", bytes: 6_000, stream: true }),
  JSON.stringify({
    model: "m",
    tools: [
      {
        name: "t",
        input_schema: { type: "object", properties: { a: { enum: [1, -2.5e3, true, null] } } },
      },
    ],
    messages: [
      { role: "user", content: 'hi é中😀 "q" \\ \n' },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", input: { a: [[], {}, [{}], "\u0001"] } }],
      },
    ],
    metadata: { nested: { deeper: [0, 0.5, 1e-7, "s"] } },
  }),
]
const MUTATIONS = encoder.encode('{}[],:"\\ 0-e.tx')

describe("skimmed subtrees", () => {
  test("agree with JSON.parse on valid and mutated bodies, at any chunking", () => {
    const random = prng(101)
    for (const body of BODIES) {
      const original = encoder.encode(body)
      for (let round = 0; round < 1_500; round++) {
        const bytes = original.slice()
        if (round > 0) {
          // Mutate past the model so the oracle's verdict is about grammar, not routing fields.
          const at = 20 + Math.floor(random() * (bytes.length - 20))
          bytes[at] = MUTATIONS[Math.floor(random() * MUTATIONS.length)] ?? 32
        }
        const cuts = Array.from({ length: 3 }, () => Math.floor(random() * bytes.length)).sort(
          (a, b) => a - b,
        )
        const whole = scan(bytes, [])
        const split = scan(bytes, cuts)
        expect(split).toEqual(whole)
        expect({ round, invalid: whole.invalid }).toEqual({ round, invalid: !parses(bytes) })
      }
    }
  })

  test("still enforces the depth limit inside a skimmed value", () => {
    const deep = `{"model":"m","tools":${"[".repeat(300)}${"]".repeat(300)}}`
    const result = scan(encoder.encode(deep), [40, 41])
    expect(result.invalid).toBe(true)
    expect(result.depthExceeded).toBe(true)
  })

  test("a duplicate top-level model after a skimmed value is still refused", () => {
    const body = `{"model":"a","tools":[{"model":"x"}],"messages":[{"role":"user","content":"hi"}],"model":"b"}`
    expect(scan(encoder.encode(body), [25]).duplicateModel).toBe(true)
  })
})
