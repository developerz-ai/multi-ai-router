import { describe, expect, test } from "bun:test"
import { createBoundedQueue } from "../../../src/services/usage"

/**
 * The queue exists to make one guarantee true: **a slow database degrades reporting, never
 * traffic.** So it sheds rather than blocks, drops the *oldest* records, and counts what it dropped
 * instead of swallowing it.
 *
 * That guarantee has a cost half as well as a correctness half: shedding must not be *expensive*.
 * A queue that copied its buffer to make room would charge every request during a database outage
 * for the whole ceiling, which is backpressure by another name.
 */

/**
 * Cost is invisible from the interface — a queue that copies its whole buffer on every push answers
 * every question exactly like one that does not — so the copying itself is what gets measured:
 * elements copied by `slice`, and the longest the backing array ever grew. `run` is synchronous and
 * both prototypes are restored before this returns, so nothing outside it sees the patch.
 */
const measureArrayWork = (run: () => void): { copied: number; longest: number } => {
  const realSlice = Array.prototype.slice
  const realPush = Array.prototype.push
  let copied = 0
  let longest = 0

  Array.prototype.slice = function (this: unknown[], start?: number, end?: number) {
    const out = realSlice.call(this, start, end)
    copied += out.length
    return out
  }
  Array.prototype.push = function (this: unknown[], ...values: unknown[]) {
    const length = realPush.apply(this, values)
    longest = Math.max(longest, length)
    return length
  }

  try {
    run()
  } finally {
    Array.prototype.slice = realSlice
    Array.prototype.push = realPush
  }

  return { copied, longest }
}

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

  test("hands records back in order across a reclaim that leaves the queue non-empty", () => {
    // Five records stay resident while the head walks past them repeatedly: the reclaim that
    // catches up with it has to move the live window, not the whole array.
    const queue = createBoundedQueue<number>(10)
    const seen: number[] = []
    for (let value = 0; value < 5; value += 1) queue.push(value)
    for (let value = 5; value < 500; value += 1) {
      queue.push(value)
      seen.push(...queue.drain(1))
    }
    seen.push(...queue.drain(10))

    expect(queue.dropped).toBe(0)
    expect(queue.depth).toBe(0)
    expect(seen).toEqual(Array.from({ length: 500 }, (_, index) => index))
  })

  test("sheds without copying the buffer, and without growing one the writer never drains", () => {
    const ceiling = 1_000
    const pushes = 50_000
    const queue = createBoundedQueue<number>(ceiling)

    // No drain at all — a wedged writer, which is the same outage that caused the shedding.
    const work = measureArrayWork(() => {
      for (let value = 0; value < pushes; value += 1) queue.push(value)
    })

    // Reclaiming on every push copies the ceiling per shed: 49 000 × 1 000 elements here, all of it
    // on the request path. Amortized, it is one copy of the ceiling per ceiling of pushes.
    expect(work.copied).toBeLessThanOrEqual(pushes * 2)
    // Never reclaiming copies nothing at all and keeps every record ever pushed instead.
    expect(work.longest).toBeLessThanOrEqual(ceiling * 2)

    // Cheap is only half of it: the survivors are still the newest, in order.
    expect(queue.depth).toBe(ceiling)
    expect(queue.dropped).toBe(pushes - ceiling)
    expect(queue.drain(ceiling)).toEqual(
      Array.from({ length: ceiling }, (_, index) => pushes - ceiling + index),
    )
  })

  test("refuses a ceiling that cannot hold anything", () => {
    expect(() => createBoundedQueue<number>(0)).toThrow()
  })
})
