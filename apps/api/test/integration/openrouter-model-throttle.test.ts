import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * Prod, 2026-11-14: one request for a free OpenRouter model (`google/gemma-4-31b-it:free`) drew an
 * upstream `429` (`openrouter:code-429`), the router cooled the whole `openrouter-dz-coding-30d`
 * account, and the next request — a *paid* model, `deepseek/deepseek-v4.1-flash:floor` — was refused
 * "1 of 1 account in pool openrouter-coding is rate limited or out of quota". A throttle on one
 * model cools that (account, model) pair; a key-level wall still cools the account. Upstream mocked.
 */

const FREE = "google/gemma-4-31b-it:free"
const PAID = "deepseek/deepseek-v4.1-flash:floor"

const chat = (model: string) =>
  JSON.stringify({ model, messages: [{ role: "user", content: "fix the bug" }] })

function ok(): Response {
  return Response.json({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: PAID,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
  })
}

/** OpenRouter's upstream-provider throttle, as it relays one for a free variant. */
function freeModelThrottle(): Response {
  return Response.json(
    {
      error: {
        message: "Provider returned error",
        code: 429,
        metadata: {
          raw: `${FREE} is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations`,
          provider_name: "Google AI Studio",
        },
      },
    },
    { status: 429 },
  )
}

/** A key-level `429` on a paid model, no provider named: about the key, so about the account. */
function keyThrottle(): Response {
  return Response.json({ error: { message: "Rate limit exceeded", code: 429 } }, { status: 429 })
}

function setup(responses: (() => Response)[]) {
  return harness({
    accounts: [account("or", { provider: "openrouter", cipher: CRYPTOR })],
    responses,
  })
}

describe("an openrouter throttle on one model, failure case first", () => {
  test("a free-model 429 leaves the account serving a paid model", async () => {
    const { app, upstream } = setup([freeModelThrottle, ok])
    const refused = await app.request("/v1/chat/completions", post(chat(FREE), bearer()))
    expect(refused.status).toBe(429)
    await refused.text()

    const served = await app.request("/v1/chat/completions", post(chat(PAID), bearer()))
    expect(served.status).toBe(200)
    await served.text()
    expect(upstream.calls).toHaveLength(2)
  })

  test("the throttled model itself is held off the account, answered 429 with a Retry-After", async () => {
    const { app, upstream, health } = setup([freeModelThrottle, ok])
    await (await app.request("/v1/chat/completions", post(chat(FREE), bearer()))).text()
    expect(health.stateOf("or").breaker.status).toBe("active")
    expect(health.stateOf("or").refusedModels?.get(FREE)?.reason).toBe("rate-limited")

    const again = await app.request("/v1/chat/completions", post(chat(FREE), bearer()))
    expect(again.status).toBe(429)
    expect(again.headers.get("retry-after")).not.toBeNull()
    await again.text()
    expect(upstream.calls).toHaveLength(1)
  })

  test("any :free variant's 429 is that model's, even with no provider named", async () => {
    const { app, health } = setup([keyThrottle, ok])
    await (await app.request("/v1/chat/completions", post(chat(FREE), bearer()))).text()
    expect(health.stateOf("or").breaker.status).toBe("active")
    const served = await app.request("/v1/chat/completions", post(chat(PAID), bearer()))
    expect(served.status).toBe(200)
    await served.text()
  })

  test("a key-level 429 on a paid model still cools the whole account", async () => {
    const { app, health } = setup([keyThrottle, ok])
    await (await app.request("/v1/chat/completions", post(chat(PAID), bearer()))).text()
    expect(health.stateOf("or").breaker.status).toBe("cooling_down")
  })
})
