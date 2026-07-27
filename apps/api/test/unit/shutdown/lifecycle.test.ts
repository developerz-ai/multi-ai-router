import { describe, expect, test } from "bun:test"
import { createLifecycle } from "../../../src/services/shutdown/lifecycle"

/**
 * The latch behind both halves of a shutdown: what `/readyz` reads, and what tells a second
 * SIGTERM it is the second one. One fact, so the two can never disagree.
 */

describe("createLifecycle", () => {
  test("is not shutting down until something begins one", () => {
    expect(createLifecycle().shuttingDown()).toBe(false)
  })

  test("reports shutting down from the instant begin returns, before any of it has run", () => {
    const lifecycle = createLifecycle()

    expect(lifecycle.begin()).toBe(true)
    expect(lifecycle.shuttingDown()).toBe(true)
  })

  test("hands the shutdown to exactly one caller, however many arrive", () => {
    const lifecycle = createLifecycle()

    // The second signal must be recognisable as a repeat: running the flush twice would close the
    // pool underneath the first pass.
    expect([lifecycle.begin(), lifecycle.begin(), lifecycle.begin()]).toEqual([true, false, false])
  })

  test("never unlatches", () => {
    const lifecycle = createLifecycle()
    lifecycle.begin()
    lifecycle.begin()

    expect(lifecycle.shuttingDown()).toBe(true)
  })
})
