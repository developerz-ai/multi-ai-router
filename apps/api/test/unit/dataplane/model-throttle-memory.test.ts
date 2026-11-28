import { describe, expect, test } from "bun:test"
import { createHealthStore } from "../../../src/services/dataplane"
import type { AttemptFailure } from "../../../src/services/routing"

/**
 * A free-tier vendor that throttles one model softly answers `429` to a share of requests and `200`
 * to the rest, with no `Retry-After` (prod 2026-11-28: one NVIDIA free key, 36% of `/v1/messages`
 * answered `429`, the share rising with the requests started in the last minute). Through 2.82.1
 * the (account, model) hold forgot its strikes the moment it lapsed, so with requests seconds apart
 * every `429` started the backoff over at its first one-second step and the model was never paced.
 *
 * The hold is the pace: a `429` steps it up, a run of successes steps it down, and nothing else
 * forgets it while it is recent.
 */

const MODEL = "vendor/some-free-model"
const T0 = new Date("2026-11-28T03:00:00.000Z")
const THROTTLE: AttemptFailure = { kind: "rate-limited", status: 429, message: "vendor:http-429" }
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1_000)

function store() {
  return createHealthStore({ jitter: () => 0, baseBackoffMs: 1_000, maxBackoffMs: 300_000 })
}

function hold(health: ReturnType<typeof store>) {
  return health.stateOf("a").refusedModels?.get(MODEL)
}

describe("a model throttle interleaved with successes, failure case first", () => {
  test("429, 200, 429, 200, 429 keeps stepping the hold instead of starting it over", () => {
    const health = store()
    health.throttleModel("a", MODEL, THROTTLE, at(0))
    health.modelServed("a", MODEL, at(5))
    health.throttleModel("a", MODEL, THROTTLE, at(10))
    health.modelServed("a", MODEL, at(15))
    health.throttleModel("a", MODEL, THROTTLE, at(20))

    // Third strike: 1 s, 2 s, then 4 s past the last 429.
    expect(hold(health)?.strikes).toBe(3)
    expect(hold(health)?.until).toEqual(at(24))
  })

  test("a run of successes steps the hold down one strike, never to nothing at once", () => {
    const health = store()
    for (const second of [0, 10, 20]) health.throttleModel("a", MODEL, THROTTLE, at(second))
    expect(hold(health)?.strikes).toBe(3)
    for (const second of [30, 31, 32]) health.modelServed("a", MODEL, at(second))
    expect(hold(health)?.strikes).toBe(2)
    health.throttleModel("a", MODEL, THROTTLE, at(40))
    expect(hold(health)?.strikes).toBe(3)
    expect(hold(health)?.until).toEqual(at(44))
  })

  test("a lapsed hold still refuses nothing: the strikes are memory, not a block", () => {
    const health = store()
    health.throttleModel("a", MODEL, THROTTLE, at(0))
    const kept = hold(health)
    expect(kept?.until).toEqual(at(1))
    // Lapsed at 1 s: routing reads `until`, which is in the past, so the model serves again.
    expect(kept !== undefined && kept.until.getTime() <= at(5).getTime()).toBe(true)
  })

  test("strikes are forgotten once a whole max-backoff span passes with no 429", () => {
    const health = store()
    for (const second of [0, 10, 20]) health.throttleModel("a", MODEL, THROTTLE, at(second))
    // The last hold lapsed at 24 s; 300 s later nothing is remembered.
    health.throttleModel("a", MODEL, THROTTLE, at(24 + 300 + 1))
    expect(hold(health)?.strikes).toBe(1)
  })

  test("another model's success does not step this model's hold", () => {
    const health = store()
    for (const second of [0, 10]) health.throttleModel("a", MODEL, THROTTLE, at(second))
    for (const second of [12, 13, 14, 15]) health.modelServed("a", "vendor/other", at(second))
    expect(hold(health)?.strikes).toBe(2)
  })
})

/**
 * Prod 2026-11-28, the first hour of 2.83.0: the holds climbed to two to five minutes and 241 of 756
 * `/v1/messages` were refused by the router itself on them. Two causes: requests already in flight
 * when a hold formed each came back `429` and each stepped it again, and a hold longer than
 * `ROUTING_MODEL_THROTTLE_WAIT_MS` is one no request waits for.
 */
describe("a model hold stays one a request can wait out, failure case first", () => {
  test("429s landing while the hold stands are one incident: one strike", () => {
    const health = store()
    health.throttleModel("a", MODEL, THROTTLE, at(0))
    // Two siblings started before the hold, refused inside it.
    health.throttleModel("a", MODEL, THROTTLE, at(0.2))
    health.throttleModel("a", MODEL, THROTTLE, at(0.5))
    expect(hold(health)?.strikes).toBe(1)
    expect(hold(health)?.until).toEqual(at(1))
  })

  test("an estimated hold never outgrows the request wait budget", () => {
    const health = createHealthStore({
      jitter: () => 0,
      baseBackoffMs: 1_000,
      maxBackoffMs: 300_000,
      modelThrottleMaxHoldMs: 30_000,
    })
    for (let second = 0; second < 600; second += 60)
      health.throttleModel("a", MODEL, THROTTLE, at(second))
    const held = hold(health)
    expect(held?.strikes).toBe(10)
    expect(held?.until).toEqual(at(540 + 30))
  })
})
