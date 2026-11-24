import { describe, expect, test } from "bun:test"
import {
  addedTtftMs,
  overheadMs,
  type RequestClocks,
  tokensIn,
  worstTokenDelayMs,
} from "../../../bench/clocks"

/**
 * The bench's arithmetic, on requests whose every timestamp is chosen here.
 *
 * The live bench tests can only say "a positive number came out". These say which number: a driver
 * that charged the upstream's wait to the router, ignored work between chunks, or started the
 * first-token clock at the upstream's first byte all produce a specific wrong answer below.
 */

/** A 100 ms request: sent at 1000, upstream called at 1003, first byte 1023, last 1093, read by 1100. */
function clocks(overrides: Partial<RequestClocks> = {}): RequestClocks {
  return {
    startedAt: 1_000,
    endedAt: 1_100,
    upstreamEnteredAt: 1_003,
    upstreamFirstByteAt: 1_023,
    upstreamLastByteAt: 1_093,
    clientFirstByteAt: 0,
    upstreamTokenAt: [],
    clientTokenAt: [],
    ...overrides,
  }
}

describe("overheadMs", () => {
  test("is the time before the upstream plus the time after its last byte — not the upstream's own 90 ms", () => {
    // 3 ms to reach the upstream, 7 ms after its last byte. The 90 ms in between is the upstream's.
    expect(overheadMs(clocks())).toBe(10)
  })

  test("a longer upstream wait changes nothing", () => {
    expect(overheadMs(clocks({ upstreamLastByteAt: 5_093, endedAt: 5_100 }))).toBe(10)
  })

  test("counts relay work between chunks, which the request's wall time cannot show", () => {
    // Token 1 was released at 1040 and reached the client at 1052: 12 ms of per-chunk work that
    // finished long before the stream ended, so the request is exactly as long as before.
    const streamed = clocks({
      upstreamTokenAt: [1_023, 1_040, 1_060],
      clientTokenAt: [1_024, 1_052, 1_061],
    })
    expect(worstTokenDelayMs(streamed)).toBe(12)
    // 3 ms before the upstream + the worse of the 7 ms tail and the 12 ms token.
    expect(overheadMs(streamed)).toBe(15)
  })

  test("token delays are lateness, not a sum: a client does not wait for them in series", () => {
    const streamed = clocks({
      upstreamTokenAt: [1_023, 1_040, 1_060],
      clientTokenAt: [1_025, 1_042, 1_062],
    })
    // Three tokens each 2 ms late is 2 ms late, and the 7 ms tail is the worse of the two.
    expect(overheadMs(streamed)).toBe(10)
  })

  test("a token only one side saw is not a measurement", () => {
    const streamed = clocks({
      upstreamTokenAt: [1_023, undefined, 1_060],
      clientTokenAt: [undefined, 1_090, 1_061],
    })
    expect(worstTokenDelayMs(streamed)).toBe(1)
  })

  test("a request that never reached the upstream, or whose upstream never finished, has no sample", () => {
    expect(overheadMs(clocks({ upstreamEnteredAt: 0 }))).toBeNull()
    expect(overheadMs(clocks({ upstreamLastByteAt: 0 }))).toBeNull()
  })

  test("never goes negative on a clock hiccup", () => {
    expect(overheadMs(clocks({ startedAt: 1_010, endedAt: 1_090 }))).toBe(0)
  })
})

describe("addedTtftMs", () => {
  test("is the client's wait from the request's start, less the upstream's own time to a first byte", () => {
    // Client: 1000 → 1024.5 = 24.5 ms. Upstream: 1003 → 1023 = 20 ms. The router added 4.5 ms.
    expect(addedTtftMs(clocks({ clientFirstByteAt: 1_024.5 }))).toBe(4.5)
  })

  test("a delay before the upstream is called is added time-to-first-token", () => {
    // The same relay — first byte reaches the client 1.5 ms after the upstream releases it — behind
    // 3 ms more of pre-upstream work. Measured from the upstream's first byte both read 1.5 ms.
    const quick = clocks({ clientFirstByteAt: 1_024.5 })
    const slow = clocks({
      upstreamEnteredAt: 1_006,
      upstreamFirstByteAt: 1_026,
      clientFirstByteAt: 1_027.5,
    })
    expect(addedTtftMs(slow)).toBe(7.5)
    expect((addedTtftMs(slow) ?? 0) - (addedTtftMs(quick) ?? 0)).toBe(3)
  })

  test("no first byte, no measurement", () => {
    expect(addedTtftMs(clocks())).toBeNull()
    expect(addedTtftMs(clocks({ clientFirstByteAt: 1_024, upstreamEnteredAt: 0 }))).toBeNull()
  })
})

describe("tokensIn", () => {
  test("finds the stub's stream tokens in any dialect's framing", () => {
    expect(tokensIn('data: {"delta":{"type":"text_delta","text":"tok7 "}}\n\n')).toEqual([7])
    expect(tokensIn('{"content":"tok0 "}{"content":"tok1 "}')).toEqual([0, 1])
    expect(tokensIn("event: message_stop\n\n")).toEqual([])
  })
})
