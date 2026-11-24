import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * Prod, 2026-11-24 04:06Z: `openrouter-dz-coding-30d` answered `404 No endpoints found for the
 * request with quantization: fp8,bf16` three times, and each request ended there. The refusal is
 * that account's own provider preferences leaving no endpoint for the model. It says nothing about
 * the request, the model, or OpenRouter: a sibling key with no such filter serves the same body.
 *
 * Through the data plane, with the real OpenRouter driver reading the real body: the restricted
 * account is passed over for its unrestricted sibling, nothing is struck or held, and with nobody
 * left the client hears the upstream's own `404`. Upstream mocked, in call order.
 */

const MODEL = "nvidia/nemotron-3-ultra-550b-a55b"
const POOL = "coding"

const chat = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "fix the bug" }] })

/** The account's quantization filter leaves no endpoint for this model. */
function filteredOut(): Response {
  return Response.json(
    {
      error: {
        code: 404,
        message:
          "No endpoints found for the request with quantization: fp8,bf16. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
      },
    },
    { status: 404 },
  )
}

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

const openrouter = (id: string) =>
  account(id, {
    provider: "openrouter",
    baseUrl: `https://${id}.openrouter.test/api/v1`,
    cipher: CRYPTOR,
  })

/** One pool of OpenRouter keys, walked in the order given. */
function setup(ids: readonly string[], responses: (() => Response)[]) {
  return harness({
    accounts: ids.map(openrouter),
    pools: [
      {
        id: POOL,
        name: POOL,
        policy: "priority-failover",
        members: ids.map((accountId, priority) => ({ accountId, priority })),
      },
    ],
    scope: "pools",
    poolIds: [POOL],
    responses,
    maxAttempts: 8,
  })
}

const send = (app: ReturnType<typeof harness>["app"]) =>
  app.request("/v1/chat/completions", post(chat, bearer()))

const hosts = (calls: readonly { readonly url: string }[]) =>
  calls.map((call) => new URL(call.url).host)

describe("an OpenRouter 404 caused by the account's own provider filter", () => {
  test("the restricted account is passed over and its unrestricted sibling serves", async () => {
    const { app, upstream, health, usage } = setup(["restricted", "open"], [filteredOut, ok])

    const response = await send(app)
    expect(response.status).toBe(200)
    await response.text()

    // Same provider, next account: nothing was skipped on the vendor's account.
    expect(hosts(upstream.calls)).toEqual(["restricted.openrouter.test", "open.openrouter.test"])

    // No strike, no cooldown, and no hold on the model: the next plain request still reaches it.
    for (const id of ["restricted", "open"]) {
      const state = health.stateOf(id)
      expect(state.breaker.status).toBe("active")
      expect(state.breaker.consecutiveFailures).toBe(0)
      expect(state.refusedModels?.size ?? 0).toBe(0)
    }

    expect(usage.rows.map((row) => [row.accountId, row.httpStatus, row.outcome])).toEqual([
      ["restricted", 404, "client_error"],
      ["open", 200, "success"],
    ])
    expect(new Set(usage.rows.map((row) => row.correlationId)).size).toBe(1)
  })

  test("the restricted account is asked again by the next request: it was not held", async () => {
    const { app, upstream } = setup(["restricted", "open"], [filteredOut, ok, ok])

    await (await send(app)).text()
    const again = await send(app)
    expect(again.status).toBe(200)
    await again.text()
    expect(hosts(upstream.calls)).toEqual([
      "restricted.openrouter.test",
      "open.openrouter.test",
      "restricted.openrouter.test",
    ])
  })

  test("with every account filtered the client hears that 404, each account asked once", async () => {
    const { app, upstream, usage, health } = setup(
      ["restricted-1", "restricted-2"],
      [filteredOut, filteredOut, ok],
    )

    const response = await send(app)
    expect(response.status).toBe(404)
    expect(await response.text()).toContain("No endpoints found")
    expect(hosts(upstream.calls)).toEqual([
      "restricted-1.openrouter.test",
      "restricted-2.openrouter.test",
    ])
    expect(usage.rows).toHaveLength(2)
    expect(health.stateOf("restricted-1").breaker.status).toBe("active")
    expect(health.stateOf("restricted-2").breaker.status).toBe("active")
  })
})
