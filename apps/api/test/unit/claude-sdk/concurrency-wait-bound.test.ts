import { describe, expect, test } from "bun:test"
import {
  createSdkConcurrency,
  createSdkWaitBudget,
  SdkGateWaitExpiredError,
} from "../../../src/providers"
import { manualGateClock, turns } from "./manual-gate-clock"

/**
 * The bounded gate wait (`concurrency.ts`, `gate-wait.ts`): a caller that passes a wait budget
 * queues for at most that budget across both gates, then fails with a typed expiry naming the half
 * it was still queued on. A caller without one keeps the unbounded queue every probe relies on.
 *
 * Time is the test's own: `manualGateClock` is injected into the gate, so nothing sleeps and no
 * timer is faked.
 */

const KNOB = 60_000

function gate(limits: { global: number; perAccount: number }) {
  const time = manualGateClock()
  const concurrency = createSdkConcurrency(limits, { now: time.now, timer: time.timer })
  return { time, concurrency }
}

const live = () => new AbortController().signal

async function expiry(promise: Promise<unknown>): Promise<SdkGateWaitExpiredError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(SdkGateWaitExpiredError)
  return error as SdkGateWaitExpiredError
}

describe("a caller with a wait budget", () => {
  test("queues, then rejects with the account-half expiry once the budget is spent", async () => {
    const { time, concurrency } = gate({ global: 4, perAccount: 1 })
    const holder = await concurrency.acquire("acct-a", live())

    const waiting = concurrency.acquire("acct-a", live(), createSdkWaitBudget(KNOB))
    const settled = expiry(waiting)
    await turns()
    expect(concurrency.queued).toBe(1)

    time.advance(KNOB - 1)
    await turns()
    expect(concurrency.queued).toBe(1)

    time.advance(1)
    const error = await settled

    expect(error.half).toBe("account")
    // The holder keeps its slot, and nothing is left queued or armed.
    expect(concurrency.inFlightFor("acct-a")).toBe(1)
    expect(concurrency.inFlight).toBe(1)
    expect(concurrency.queued).toBe(0)
    expect(time.armed).toBe(0)
    holder.release()
  })

  test("granted inside its budget, it resolves and holds its slot", async () => {
    const { time, concurrency } = gate({ global: 4, perAccount: 1 })
    const holder = await concurrency.acquire("acct-a", live())

    const waiting = concurrency.acquire("acct-a", live(), createSdkWaitBudget(KNOB))
    await turns()
    time.advance(KNOB / 2)
    holder.release()
    const slot = await waiting

    expect(concurrency.inFlightFor("acct-a")).toBe(1)
    expect(concurrency.queued).toBe(0)
    // The grant disarmed the timer: running out the clock later changes nothing.
    expect(time.armed).toBe(0)
    time.advance(KNOB * 2)
    expect(concurrency.inFlightFor("acct-a")).toBe(1)
    slot.release()
    expect(concurrency.inFlight).toBe(0)
  })

  test("is granted in arrival order, and one expiring does not reorder the rest", async () => {
    const { time, concurrency } = gate({ global: 8, perAccount: 1 })
    const holder = await concurrency.acquire("acct-a", live())
    const granted: string[] = []

    const first = concurrency
      .acquire("acct-a", live(), createSdkWaitBudget(KNOB))
      .then((slot) => (granted.push("first"), slot))
    await turns()
    time.advance(10_000)
    // Arrives later with its own, shorter budget: it expires while the others still queue.
    const second = expiry(concurrency.acquire("acct-a", live(), createSdkWaitBudget(5_000)))
    await turns()
    const third = concurrency
      .acquire("acct-a", live(), createSdkWaitBudget(KNOB))
      .then((slot) => (granted.push("third"), slot))
    await turns()
    expect(concurrency.queued).toBe(3)

    time.advance(5_000)
    expect((await second).half).toBe("account")
    expect(concurrency.queued).toBe(2)

    holder.release()
    const slotOne = await first
    expect(granted).toEqual(["first"])
    slotOne.release()
    const slotThree = await third
    expect(granted).toEqual(["first", "third"])
    slotThree.release()
    expect(concurrency.inFlight).toBe(0)
  })

  test("an abort while queued rejects with the signal's own reason, leaves the queue and leaks no permit", async () => {
    const { time, concurrency } = gate({ global: 4, perAccount: 1 })
    const holder = await concurrency.acquire("acct-a", live())
    const controller = new AbortController()

    const waiting = concurrency.acquire("acct-a", controller.signal, createSdkWaitBudget(KNOB))
    const outcome = waiting.then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    await turns()
    expect(concurrency.queued).toBe(1)

    const reason = new DOMException("client went away", "AbortError")
    controller.abort(reason)

    expect(await outcome).toBe(reason)
    expect(concurrency.queued).toBe(0)
    expect(time.armed).toBe(0)
    expect(concurrency.inFlightFor("acct-a")).toBe(1)
    holder.release()
    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.inFlightFor("acct-a")).toBe(0)
  })

  test("with the global gate full, it rejects with the global-half expiry and gives back its account permit", async () => {
    const { time, concurrency } = gate({ global: 1, perAccount: 4 })
    const holder = await concurrency.acquire("acct-x", live())

    const waiting = concurrency.acquire("acct-y", live(), createSdkWaitBudget(KNOB))
    const settled = expiry(waiting)
    await turns()
    // Y holds its own account permit and is queued on the global half.
    expect(concurrency.inFlightFor("acct-y")).toBe(1)
    expect(concurrency.queued).toBe(1)

    time.advance(KNOB)
    const error = await settled

    expect(error.half).toBe("global")
    expect(concurrency.inFlightFor("acct-y")).toBe(0)
    expect(concurrency.inFlight).toBe(1)
    expect(concurrency.queued).toBe(0)
    holder.release()
  })

  test("draws on one budget across both gates and across acquires", async () => {
    const { time, concurrency } = gate({ global: 1, perAccount: 1 })
    const holderA = await concurrency.acquire("acct-a", live())
    const budget = createSdkWaitBudget(KNOB)

    // The first acquire spends 40 s queued on account A's own gate, then is granted.
    const first = concurrency.acquire("acct-a", live(), budget)
    await turns()
    time.advance(40_000)
    holderA.release()
    const slot = await first
    expect(budget.remaining()).toBe(KNOB - 40_000)

    // The next acquire of the same request, on another account, queues on the global half and
    // gets only what is left: 20 s, not another 60.
    const next = expiry(concurrency.acquire("acct-b", live(), budget))
    await turns()
    time.advance(20_000)
    expect((await next).half).toBe("global")
    expect(budget.remaining()).toBe(0)
    slot.release()
  })

  test("with the budget already spent, a free slot is taken at once and a full gate refuses at once", async () => {
    const { time, concurrency } = gate({ global: 4, perAccount: 1 })
    const holder = await concurrency.acquire("acct-a", live())
    const budget = createSdkWaitBudget(KNOB)
    const spending = expiry(concurrency.acquire("acct-a", live(), budget))
    await turns()
    time.advance(KNOB)
    await spending
    expect(budget.remaining()).toBe(0)

    // A different account's gate has a free slot: taken without waiting.
    const free = await concurrency.acquire("acct-b", live(), budget)
    expect(concurrency.inFlightFor("acct-b")).toBe(1)
    free.release()

    // The full gate refuses without queueing, and without a single tick of time.
    const refusal = expiry(concurrency.acquire("acct-a", live(), budget))
    const error = await refusal
    expect(error.half).toBe("account")
    expect(concurrency.queued).toBe(0)
    expect(time.armed).toBe(0)
    holder.release()
  })
})

describe("a caller without a wait budget", () => {
  test("still waits past any amount of injected time: the probe path is unchanged", async () => {
    const { time, concurrency } = gate({ global: 4, perAccount: 1 })
    const holder = await concurrency.acquire("acct-a", live())

    const state: { outcome: "pending" | "granted" | "rejected" } = { outcome: "pending" }
    const waiting = concurrency.acquire("acct-a", live()).then(
      (slot) => {
        state.outcome = "granted"
        return slot
      },
      () => {
        state.outcome = "rejected"
        return undefined
      },
    )
    await turns()
    time.advance(24 * 60 * 60 * 1_000)
    await turns()

    expect(state.outcome).toBe("pending")
    expect(concurrency.queued).toBe(1)

    holder.release()
    const slot = await waiting
    expect(state.outcome).toBe("granted")
    slot?.release()
  })
})
