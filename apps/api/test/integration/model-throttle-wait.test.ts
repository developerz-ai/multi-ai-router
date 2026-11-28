import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * Prod, 2026-11-28: a free NVIDIA key was the only account serving the models a coding lane pinned,
 * and the vendor's soft throttle answered a third of its `/v1/messages` with a bare `429` (no
 * `Retry-After`). Each reached the client in ~350 ms, the hold it took lapsed a second later and
 * forgot its strikes, and the client came back ~30 s on to the same lottery. Now the request waits
 * the model's hold out and asks again, before any byte is on the wire. Upstream mocked.
 */

const MODEL = "vendor/free-model"

const chat = () =>
  JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "fix the bug" }] })

function ok(): Response {
  return Response.json({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
  })
}

/** NVIDIA's throttle: RFC 7807 problem details, no `Retry-After`. */
function throttle(): Response {
  return Response.json({ status: 429, title: "Too Many Requests" }, { status: 429 })
}

function setup(responses: (() => Response)[], modelThrottleWaitMs: number) {
  // The harness clock stands still; each upstream answer moves it one step, as real time would
  // across a pause, so a retry after its hold is not read as a sibling inside it.
  let advance = (_ms: number) => {}
  const h = harness({
    accounts: [account("nv", { provider: "nvidia", cipher: CRYPTOR })],
    responses: responses.map((respond) => () => {
      advance(100)
      return respond()
    }),
    // Millisecond steps so the suite does not sleep for real seconds; the rule is the same.
    health: { baseBackoffMs: 20, maxBackoffMs: 1_000 },
    failover: { modelThrottleWaitMs },
  })
  advance = (ms) => h.clock.advance(ms)
  return h
}

describe("a model throttle on the only account, failure case first", () => {
  test("the request waits the hold out and is served by the same account", async () => {
    const { app, upstream, health } = setup([throttle, throttle, ok], 5_000)
    const started = performance.now()
    const served = await app.request("/v1/chat/completions", post(chat(), bearer()))
    expect(served.status).toBe(200)
    // The retries really waited the holds out: 20 ms, then 40 ms.
    expect(performance.now() - started).toBeGreaterThanOrEqual(55)
    await served.text()
    expect(upstream.calls).toHaveLength(3)
    // The account itself never cooled: only the model was held, and its strikes are kept.
    expect(health.stateOf("nv").breaker.status).toBe("active")
    expect(health.stateOf("nv").refusedModels?.get(MODEL)?.strikes).toBe(2)
  })

  test("past the budget the client hears the 429 with a Retry-After", async () => {
    const { app, upstream } = setup([throttle, throttle, throttle, ok], 30)
    const refused = await app.request("/v1/chat/completions", post(chat(), bearer()))
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).not.toBeNull()
    await refused.text()
    // 20 ms waited, then a 40 ms hold that would overrun the 30 ms budget.
    expect(upstream.calls).toHaveLength(2)
  })

  test("with no budget the 429 is the answer at once, as before", async () => {
    const { app, upstream } = setup([throttle, ok], 0)
    const refused = await app.request("/v1/chat/completions", post(chat(), bearer()))
    expect(refused.status).toBe(429)
    await refused.text()
    expect(upstream.calls).toHaveLength(1)
  })
})
