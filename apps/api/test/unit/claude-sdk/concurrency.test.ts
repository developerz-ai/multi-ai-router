import { describe, expect, test } from "bun:test"
import { createSdkConcurrency } from "../../../src/providers"

/**
 * `createSdkConcurrency` on its own — the semaphore pair `SdkInvoker` and the "Test now" probe both
 * take a slot against (`concurrency.ts`, `composition/index.ts`'s `sdkConcurrency`). No launch, no
 * subprocess, no HTTP: just the gate that stands between a request and the ~245 MB `claude` process
 * it would spawn.
 *
 * The property that matters is right there in the module's own doc comment — "excess callers
 * **queue** rather than fail" — so every test here proves a caller past the ceiling neither runs
 * nor is refused, only waits, and is admitted the moment a slot frees.
 */

describe("the global gate", () => {
  test("admits exactly the configured number of callers concurrently", async () => {
    const concurrency = createSdkConcurrency({ global: 2, perAccount: 2 })
    const one = await concurrency.acquire("acct-a", new AbortController().signal)
    const two = await concurrency.acquire("acct-b", new AbortController().signal)

    expect(concurrency.inFlight).toBe(2)
    expect(concurrency.queued).toBe(0)

    one.release()
    two.release()
    expect(concurrency.inFlight).toBe(0)
  })

  test("the (N+1)th caller queues — never admitted early, never refused", async () => {
    const concurrency = createSdkConcurrency({ global: 2, perAccount: 2 })
    const one = await concurrency.acquire("acct-a", new AbortController().signal)
    const two = await concurrency.acquire("acct-b", new AbortController().signal)

    let admitted = false
    const third = concurrency.acquire("acct-c", new AbortController().signal).then((slot) => {
      admitted = true
      return slot
    })
    // Enough microtask ticks for the third caller to reach the global gate and be enqueued —
    // nothing here is a subprocess, so there is no I/O to await instead.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(admitted).toBe(false)
    expect(concurrency.inFlight).toBe(2)
    expect(concurrency.queued).toBe(1)

    one.release()
    const slot = await third

    expect(admitted).toBe(true)
    expect(concurrency.inFlight).toBe(2)
    expect(concurrency.queued).toBe(0)

    two.release()
    slot.release()
    expect(concurrency.inFlight).toBe(0)
  })

  test("queued callers are admitted in the order they arrived, not the order a release happens to favor", async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const first = await concurrency.acquire("acct-a", new AbortController().signal)

    const order: string[] = []
    const second = concurrency.acquire("acct-b", new AbortController().signal).then((slot) => {
      order.push("second")
      return slot
    })
    await Promise.resolve()
    await Promise.resolve()
    const third = concurrency.acquire("acct-c", new AbortController().signal).then((slot) => {
      order.push("third")
      return slot
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(concurrency.queued).toBe(2)

    first.release()
    const secondSlot = await second
    expect(order).toEqual(["second"])
    expect(concurrency.queued).toBe(1)

    secondSlot.release()
    const thirdSlot = await third
    expect(order).toEqual(["second", "third"])

    thirdSlot.release()
    expect(concurrency.inFlight).toBe(0)
  })
})

describe("the per-account gate", () => {
  test("one Account's own ceiling queues it while a different Account still has global capacity", async () => {
    const concurrency = createSdkConcurrency({ global: 4, perAccount: 1 })
    const first = await concurrency.acquire("acct-a", new AbortController().signal)

    let admitted = false
    const second = concurrency.acquire("acct-a", new AbortController().signal).then((slot) => {
      admitted = true
      return slot
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Blocked by its own Account's gate, not the pool — the global slot it never reached stays free.
    expect(admitted).toBe(false)
    expect(concurrency.inFlightFor("acct-a")).toBe(1)
    expect(concurrency.inFlight).toBe(1)

    // A different Account never queues behind acct-a's own ceiling — the whole reason the gates are
    // ordered per-Account first (`concurrency.ts`'s own rationale).
    const other = await concurrency.acquire("acct-b", new AbortController().signal)
    expect(concurrency.inFlightFor("acct-b")).toBe(1)
    expect(concurrency.inFlight).toBe(2)

    first.release()
    const secondSlot = await second
    expect(admitted).toBe(true)

    other.release()
    secondSlot.release()
    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.inFlightFor("acct-a")).toBe(0)
  })
})

describe("aborting while queued", () => {
  test("throws the signal's own reason and never takes a slot", async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const held = await concurrency.acquire("acct-a", new AbortController().signal)

    const controller = new AbortController()
    const queued = concurrency.acquire("acct-a", controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort(Object.assign(new Error("deadline"), { name: "TimeoutError" }))

    await expect(queued).rejects.toMatchObject({ name: "TimeoutError" })
    expect(concurrency.queued).toBe(0)
    expect(concurrency.inFlight).toBe(1)

    held.release()
    expect(concurrency.inFlight).toBe(0)
  })

  test("a caller that aborts before it is ever admitted spawns nothing and takes nothing", async () => {
    const concurrency = createSdkConcurrency({ global: 4, perAccount: 4 })
    const controller = new AbortController()
    controller.abort(Object.assign(new Error("gone"), { name: "AbortError" }))

    await expect(concurrency.acquire("acct-a", controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.queued).toBe(0)
  })
})
