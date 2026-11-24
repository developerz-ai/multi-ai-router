import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * Prod, 2026-11-23: 31 `400`s on `gemini-free-1` in 5.4 h, each ending its request as a
 * `client-error` with a second Gemini account and six accounts of other providers behind it in the
 * pool. A `400` about Gemini's own wire (a tool call another vendor's model made carries no thought
 * signature) is refused alike by every Gemini account and served as it stands by another vendor.
 *
 * The review of #504 asked for this through the data plane: the pure planner test injects the flag
 * and the refused provider, so it would pass even if an HTTP refusal never reached the planner.
 * Here the real Gemini driver classifies a real body and the chain walks a real pool. Upstream
 * mocked, in call order.
 */

const MODEL = "shared-model"
const POOL = "mixed"

const chat = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "continue" }] })

/** Gemini refusing a replayed tool call for its own wire's reasons. */
function thoughtSignatureRefusal(): Response {
  return Response.json(
    {
      error: {
        code: 400,
        message:
          "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly.",
        status: "INVALID_ARGUMENT",
      },
    },
    { status: 400 },
  )
}

/** A `400` that is the request's own fault at any vendor. */
function plainBadRequest(): Response {
  return Response.json(
    { error: { code: 400, message: "messages: must not be empty", status: "INVALID_ARGUMENT" } },
    { status: 400 },
  )
}

function ok(): Response {
  return Response.json({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "upstream",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
  })
}

const gemini = (id: string) =>
  account(id, {
    provider: "gemini",
    baseUrl: `https://${id}.gemini.test/v1beta/openai`,
    modelAliases: { [MODEL]: "gemini-3-flash" },
    cipher: CRYPTOR,
  })
const openrouter = (id: string) =>
  account(id, {
    provider: "openrouter",
    baseUrl: `https://${id}.openrouter.test/api/v1`,
    modelAliases: { [MODEL]: "google/gemini-3-flash" },
    cipher: CRYPTOR,
  })

/** One pool, walked in the order given: both Gemini accounts ahead of anything else. */
function setup(accounts: ReturnType<typeof account>[], responses: (() => Response)[]) {
  return harness({
    accounts,
    pools: [
      {
        id: POOL,
        name: POOL,
        policy: "priority-failover",
        members: accounts.map((entry, priority) => ({ accountId: entry.id, priority })),
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

describe("a Gemini 400 about its own wire", () => {
  test("skips the second Gemini account and is served by another provider", async () => {
    const { app, upstream, health, usage } = setup(
      [gemini("g1"), gemini("g2"), openrouter("or")],
      [thoughtSignatureRefusal, ok],
    )

    const response = await send(app)
    expect(response.status).toBe(200)
    await response.text()

    // Two upstream calls, and the second Gemini account is not one of them.
    expect(hosts(upstream.calls)).toEqual(["g1.gemini.test", "or.openrouter.test"])

    // The account answered correctly about its wire: no strike, no cooldown, no hold, on anyone.
    for (const id of ["g1", "g2", "or"]) {
      const state = health.stateOf(id)
      expect(state.breaker.status).toBe("active")
      expect(state.breaker.consecutiveFailures).toBe(0)
      expect(state.refusedModels?.size ?? 0).toBe(0)
    }

    // One row per attempt, sharing the request: the refusal, then the answer.
    expect(usage.rows.map((row) => [row.accountId, row.httpStatus, row.outcome])).toEqual([
      ["g1", 400, "client_error"],
      ["or", 200, "success"],
    ])
    expect(new Set(usage.rows.map((row) => row.correlationId)).size).toBe(1)
  })

  test("with only Gemini accounts in scope the client hears that 400, after one attempt", async () => {
    const { app, upstream, usage } = setup(
      [gemini("g1"), gemini("g2")],
      [thoughtSignatureRefusal, ok],
    )

    const response = await send(app)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("thought_signature")
    expect(hosts(upstream.calls)).toEqual(["g1.gemini.test"])
    expect(usage.rows).toHaveLength(1)
  })

  test("the skip lasts the chain: a later provider failing does not bring Gemini back", async () => {
    const limited = () =>
      Response.json({ error: { message: "Rate limit exceeded", code: 429 } }, { status: 429 })
    const { app, upstream } = setup(
      [gemini("g1"), openrouter("or1"), gemini("g2"), openrouter("or2")],
      [thoughtSignatureRefusal, limited, ok],
    )

    const response = await send(app)
    expect(response.status).toBe(200)
    await response.text()
    expect(hosts(upstream.calls)).toEqual([
      "g1.gemini.test",
      "or1.openrouter.test",
      "or2.openrouter.test",
    ])
  })
})

test("a 400 that is the request's own fault still stops at the first account", async () => {
  const { app, upstream } = setup(
    [gemini("g1"), gemini("g2"), openrouter("or")],
    [plainBadRequest, ok],
  )

  const response = await send(app)
  expect(response.status).toBe(400)
  await response.text()
  expect(hosts(upstream.calls)).toEqual(["g1.gemini.test"])
})
