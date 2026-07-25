import { describe, expect, test } from "bun:test"
import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT_MAX_KEYS,
  type RateLimitedKey,
} from "../../../src/services/dataplane"
import { clock } from "./fixtures"

/**
 * The per-key sliding-window limiter, driven entirely by an injected clock — no timers, no flake.
 * `check()` both charges and answers, so every assertion here is about what one call decided, not
 * about a separate read of remaining headroom.
 */

function key(overrides: Partial<RateLimitedKey> = {}): RateLimitedKey {
  return {
    id: "key-1",
    rateLimitRequests: 3,
    rateLimitWindowSeconds: 60,
    ...overrides,
  }
}

describe("no configured ceiling", () => {
  test("a null count never touches the map", () => {
    const limiter = createRateLimiter()
    const testClock = clock()
    const k = key({ rateLimitRequests: null })

    expect(limiter.check(k, testClock.now().getTime())).toEqual({ allowed: true })
    expect(limiter.size).toBe(0)
  })

  test("a null window is treated the same as no ceiling at all", () => {
    const limiter = createRateLimiter()
    const testClock = clock()
    const k = key({ rateLimitWindowSeconds: null })

    expect(limiter.check(k, testClock.now().getTime())).toEqual({ allowed: true })
    expect(limiter.size).toBe(0)
  })

  test("a non-positive count or window never denies — misconfiguration is not 'deny everything'", () => {
    const limiter = createRateLimiter()
    const now = clock().now().getTime()

    expect(limiter.check(key({ rateLimitRequests: 0 }), now)).toEqual({ allowed: true })
    expect(limiter.check(key({ rateLimitWindowSeconds: 0 }), now)).toEqual({ allowed: true })
    expect(limiter.check(key({ rateLimitRequests: -1 }), now)).toEqual({ allowed: true })
  })
})

describe("the exact sliding window", () => {
  test("admits exactly the ceiling, then refuses", () => {
    const limiter = createRateLimiter()
    const testClock = clock()
    const k = key({ rateLimitRequests: 3, rateLimitWindowSeconds: 60 })

    for (let i = 0; i < 3; i++) {
      expect(limiter.check(k, testClock.now().getTime())).toEqual({ allowed: true })
      testClock.advance(1_000)
    }

    const decision = limiter.check(k, testClock.now().getTime())
    expect(decision.allowed).toBe(false)
  })

  test("the refusal carries a Retry-After of at least one second and an absolute reset", () => {
    const limiter = createRateLimiter()
    const testClock = clock()
    const k = key({ rateLimitRequests: 1, rateLimitWindowSeconds: 60 })

    const startMs = testClock.now().getTime()
    limiter.check(k, startMs)
    testClock.advance(59_500) // just inside the window
    const decision = limiter.check(k, testClock.now().getTime())

    if (decision.allowed) throw new Error("expected a refusal")
    expect(decision.retryAfterSeconds).toBe(1) // rounds up, never zero
    expect(decision.resetsAt.getTime()).toBe(startMs + 60_000)
  })

  test("a refused request is never charged — a spent window cannot push its own reset further away", () => {
    const limiter = createRateLimiter()
    const testClock = clock()
    const k = key({ rateLimitRequests: 1, rateLimitWindowSeconds: 60 })

    const startMs = testClock.now().getTime()
    limiter.check(k, startMs)

    testClock.advance(1_000)
    const first = limiter.check(k, testClock.now().getTime())
    testClock.advance(1_000)
    const second = limiter.check(k, testClock.now().getTime())

    if (first.allowed || second.allowed) throw new Error("expected both refused")
    // Same reset both times: the second refusal did not extend the window.
    expect(first.resetsAt.getTime()).toBe(second.resetsAt.getTime())
    expect(first.resetsAt.getTime()).toBe(startMs + 60_000)
  })

  test("window rollover: once the oldest instant leaves, headroom returns without a reset", () => {
    const limiter = createRateLimiter()
    const testClock = clock()
    const k = key({ rateLimitRequests: 2, rateLimitWindowSeconds: 10 })

    limiter.check(k, testClock.now().getTime()) // t=0
    testClock.advance(5_000)
    limiter.check(k, testClock.now().getTime()) // t=5s

    testClock.advance(5_001) // t=10.001s: the t=0 instant has left the 10s window
    const decision = limiter.check(k, testClock.now().getTime())
    expect(decision.allowed).toBe(true)

    // The window is full again immediately after — one slot freed, one consumed.
    const next = limiter.check(k, testClock.now().getTime())
    expect(next.allowed).toBe(false)
  })

  test("60/minute never allows 120 across a boundary — a fixed-window counter's classic bug", () => {
    const limiter = createRateLimiter()
    const testClock = clock()
    const k = key({ rateLimitRequests: 60, rateLimitWindowSeconds: 60 })

    // Burn the ceiling right at the close of a would-be fixed window.
    testClock.advance(59_000)
    for (let i = 0; i < 60; i++) {
      expect(limiter.check(k, testClock.now().getTime()).allowed).toBe(true)
    }
    // One tick later — a fixed-window counter keyed on wall-clock minute would reset here.
    testClock.advance(2_000)
    expect(limiter.check(k, testClock.now().getTime()).allowed).toBe(false)
  })
})

describe("edited ceilings", () => {
  test("changing the limit or window starts a fresh window rather than backdating it", () => {
    const limiter = createRateLimiter()
    const testClock = clock()

    limiter.check(
      key({ rateLimitRequests: 1, rateLimitWindowSeconds: 60 }),
      testClock.now().getTime(),
    )
    expect(
      limiter.check(
        key({ rateLimitRequests: 1, rateLimitWindowSeconds: 60 }),
        testClock.now().getTime(),
      ).allowed,
    ).toBe(false)

    // The operator raises the ceiling: a fresh window, not "one already used".
    const raised = limiter.check(
      key({ rateLimitRequests: 5, rateLimitWindowSeconds: 60 }),
      testClock.now().getTime(),
    )
    expect(raised.allowed).toBe(true)
  })
})

describe("revocation and eviction", () => {
  test("forget drops a key's window so a revoked key stops occupying memory", () => {
    const limiter = createRateLimiter()
    const testClock = clock()
    const k = key({ rateLimitRequests: 1, rateLimitWindowSeconds: 60 })

    limiter.check(k, testClock.now().getTime())
    expect(limiter.size).toBe(1)

    limiter.forget(k.id)
    expect(limiter.size).toBe(0)

    // A forgotten key starts clean: the prior charge is gone.
    expect(limiter.check(k, testClock.now().getTime()).allowed).toBe(true)
  })

  test("a spray of distinct keys is bounded by maxKeys, never grows unbounded", () => {
    const limiter = createRateLimiter({ maxKeys: 4 })
    const testClock = clock()

    for (let i = 0; i < 10; i++) {
      limiter.check(
        key({ id: `key-${i}`, rateLimitRequests: 1, rateLimitWindowSeconds: 60 }),
        testClock.now().getTime(),
      )
    }

    expect(limiter.size).toBeLessThanOrEqual(4)
  })

  test("the default ceiling is exported for callers that size other structures off it", () => {
    expect(DEFAULT_RATE_LIMIT_MAX_KEYS).toBeGreaterThan(0)
  })
})
