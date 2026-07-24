import { describe, expect, test } from "bun:test"
import { createBoundedQueue } from "../../../src/services/usage"

/**
 * The queue exists to make one guarantee true: **a slow database degrades reporting, never
 * traffic.** So it sheds rather than blocks, drops the *oldest* records, and counts what it dropped
 * instead of swallowing it.
 */

describe("bounded queue", () => {
  test("returns items oldest first", () => {
    const queue = createBoundedQueue<number>(10)
    queue.push(1)
    queue.push(2)

    expect(queue.drain(10)).toEqual([1, 2])
    expect(queue.depth).toBe(0)
  })

  test("drains at most the requested batch size", () => {
    const queue = createBoundedQueue<number>(10)
    for (const value of [1, 2, 3, 4]) queue.push(value)

    expect(queue.drain(2)).toEqual([1, 2])
    expect(queue.depth).toBe(2)
  })

  test("sheds the oldest on overflow and never refuses the newest", () => {
    const queue = createBoundedQueue<number>(3)

    expect([1, 2, 3].map((value) => queue.push(value))).toEqual([true, true, true])
    expect(queue.push(4)).toBe(false)

    // The newest survives; the oldest is what was given up.
    expect(queue.drain(10)).toEqual([2, 3, 4])
    expect(queue.dropped).toBe(1)
  })

  test("stays at its ceiling under sustained overflow rather than growing", () => {
    const queue = createBoundedQueue<number>(5)
    for (let value = 0; value < 1_000; value += 1) queue.push(value)

    expect(queue.depth).toBe(5)
    expect(queue.dropped).toBe(995)
    expect(queue.drain(5)).toEqual([995, 996, 997, 998, 999])
  })

  test("refuses a ceiling that cannot hold anything", () => {
    expect(() => createBoundedQueue<number>(0)).toThrow()
  })
})
