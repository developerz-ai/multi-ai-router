import { expect, test } from "bun:test"
import { createSdkConcurrency } from "../../../src/providers"

/**
 * A waiter leaves the gate's queue in constant time, whichever way it leaves. Cancelling the
 * newest waiter first is the worst case for a search-and-splice queue: every removal walks the
 * whole line, so a burst of N cancellations costs N squared and holds the event loop while it does.
 * The bound below is generous (a linked queue does this in a few tens of milliseconds); a quadratic
 * one needs seconds at this size.
 */

const WAITERS = 120_000
const BUDGET_MS = 750

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

  const started = performance.now()
  for (let index = controllers.length - 1; index >= 0; index -= 1)
    controllers[index]?.abort(new DOMException("client went away", "AbortError"))
  const elapsed = performance.now() - started

  expect(concurrency.queued).toBe(0)
  expect(new Set(await Promise.all(outcomes))).toEqual(new Set(["aborted"]))
  expect(elapsed).toBeLessThan(BUDGET_MS)
  holder.release()
  expect(concurrency.inFlight).toBe(0)
})
