import { expect, test } from "bun:test"
import { createSdkConcurrency } from "../../../src/providers"
import { createWaiterQueue } from "../../../src/providers/claude-sdk/waiter-queue"

/**
 * A waiter leaves the gate's queue in constant time, whichever way it leaves. Cancelling the
 * newest waiter first is the worst case for a search-and-splice queue: every removal walks the
 * whole line, so a burst of N cancellations costs N squared and holds the event loop while it does.
 *
 * Nothing here reads a clock: a paused CI runner cannot fail correct code. The property is
 * structural, so it is asserted structurally. A line kept in an array can only remove by finding
 * the entry (`indexOf`, `findIndex`, `filter`, ...) or by shifting the rest (`splice`), and the
 * calls that do it are counted while the burst leaves. A linked line removes by handle and makes none.
 */

const WAITERS = 2_000

const SCANNING = [
  "indexOf",
  "lastIndexOf",
  "findIndex",
  "findLastIndex",
  "find",
  "findLast",
  "includes",
  "filter",
  "splice",
  "slice",
  "some",
  "every",
  "forEach",
  "map",
  "reduce",
  "flat",
] as const

/** Runs `work` and returns how many times any array scan or splice method was called inside it. */
async function arrayScanCalls(work: () => void | Promise<void>): Promise<number> {
  let calls = 0
  const proto = Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>
  const originals = new Map<string, (...args: unknown[]) => unknown>()
  for (const name of SCANNING) {
    const original = proto[name]
    if (original === undefined) continue
    originals.set(name, original)
    proto[name] = function (this: unknown, ...args: unknown[]) {
      calls += 1
      return original.apply(this, args)
    }
  }
  try {
    await work()
  } finally {
    for (const [name, original] of originals) proto[name] = original
  }
  return calls
}

test("cancelling a burst of queued waiters, newest first, does not scan the queue each time", async () => {
  const concurrency = createSdkConcurrency({ global: WAITERS + 1, perAccount: 1 })
  const holder = await concurrency.acquire("acct-a", new AbortController().signal)

  const controllers = Array.from({ length: WAITERS }, () => new AbortController())
  const outcomes = controllers.map((controller) =>
    concurrency.acquire("acct-a", controller.signal).then(
      () => "granted",
      () => "aborted",
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(concurrency.queued).toBe(WAITERS)

  const scans = await arrayScanCalls(() => {
    for (let index = controllers.length - 1; index >= 0; index -= 1)
      controllers[index]?.abort(new DOMException("client went away", "AbortError"))
  })

  expect(scans).toBe(0)
  expect(concurrency.queued).toBe(0)
  expect(new Set(await Promise.all(outcomes))).toEqual(new Set(["aborted"]))
  holder.release()
  expect(concurrency.inFlight).toBe(0)
})

test("the waiter queue keeps first-in-first-out order when entries leave from anywhere", () => {
  const queue = createWaiterQueue<number>()
  const handles = Array.from({ length: 6 }, (_, value) => queue.push(value))

  handles[5]?.remove() // newest
  handles[0]?.remove() // oldest
  handles[3]?.remove() // middle
  handles[3]?.remove() // a second leave is a no-op, not a second decrement
  expect(queue.size).toBe(3)

  const order: number[] = []
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) order.push(next)
  expect(order).toEqual([1, 2, 4])
  expect(queue.size).toBe(0)

  handles[1]?.remove() // already shifted out: must not corrupt an empty line
  expect(queue.size).toBe(0)
  queue.push(9)
  expect(queue.shift()).toBe(9)
})

test("a departure reads a constant number of links, however long the line is and wherever it leaves from", () => {
  // The array-method counter above cannot see a hand-written loop; this one counts the queue's own
  // link visits through its probe, so an O(N) walk inside remove() fails whatever it is written with.
  const MAX_VISITS_PER_DEPARTURE = 3 // the entry itself plus its two neighbours
  const costs = (size: number, pick: (handles: { remove(): void }[]) => number[]): number => {
    let visits = 0
    const queue = createWaiterQueue<number>(() => {
      visits += 1
    })
    const handles = Array.from({ length: size }, (_, value) => queue.push(value))
    const order = pick(handles)
    visits = 0
    for (const index of order) handles[index]?.remove()
    expect(queue.size).toBe(size - order.length)
    return visits / order.length
  }
  const newestFirst = (handles: unknown[]) => handles.map((_, index) => handles.length - 1 - index)
  const middleOut = (handles: unknown[]) => {
    const mid = Math.floor(handles.length / 2)
    return handles
      .map((_, index) => (index % 2 === 0 ? mid + index / 2 : mid - (index + 1) / 2))
      .filter((i) => i >= 0 && i < handles.length)
  }

  for (const pick of [newestFirst, middleOut]) {
    const small = costs(200, pick)
    const large = costs(WAITERS, pick)
    expect(small).toBeGreaterThan(0) // a queue that reports nothing proves nothing
    expect(small).toBeLessThanOrEqual(MAX_VISITS_PER_DEPARTURE)
    expect(large).toBeLessThanOrEqual(MAX_VISITS_PER_DEPARTURE)
  }
})
