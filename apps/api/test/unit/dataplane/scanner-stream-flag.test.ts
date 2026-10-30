import { describe, expect, test } from "bun:test"
import { createRoutingScanner } from "../../../src/services/dataplane"

/**
 * The client's top-level `stream: true`, read by the same single pass that finds `model` — never a
 * second parse. It decides whether an attempt's response headers are bounded by the streaming
 * first-byte deadline (`upstream-deadline.ts`): a non-streamed answer sends its headers only once
 * the whole completion is done, so that deadline must never apply to one.
 */

const encoder = new TextEncoder()
function scan(body: string, chunkSize = body.length) {
  const scanner = createRoutingScanner()
  const bytes = encoder.encode(body)
  for (let at = 0; at < bytes.length; at += chunkSize)
    scanner.push(bytes.subarray(at, at + chunkSize))
  return scanner.finish()
}

describe("routing scanner: stream", () => {
  test.each([1, 3, 1_000])("top-level stream:true is captured (chunk size %p)", (size) => {
    expect(scan('{"model":"m","stream":true,"messages":[]}', size).stream).toBe(true)
    expect(scan('{"messages":[],"stream" : true }', size).stream).toBe(true)
  })

  test.each([
    ['{"model":"m","messages":[]}', "absent"],
    ['{"model":"m","stream":false}', "false"],
    ['{"model":"m","stream":"true"}', "a string"],
    ['{"model":"m","stream":null}', "null"],
    ['{"model":"m","stream_options":{"stream":true}}', "nested"],
    ['{"model":"m","messages":[{"role":"user","content":"x","stream":true}]}', "inside a message"],
  ])("%s is not a stream (%s)", (body) => {
    expect(scan(body).stream).toBe(false)
  })

  test("the last duplicate wins, as JSON.parse reads it", () => {
    expect(scan('{"stream":true,"stream":false}').stream).toBe(false)
    expect(scan('{"stream":false,"stream":true}').stream).toBe(true)
  })
})
