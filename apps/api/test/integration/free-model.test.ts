import { describe, expect, test } from "bun:test"
import type { RoutableAccount } from "../../src/services/dataplane"
import type { PoolSnapshot } from "../../src/services/routing"
import { type AccountOptions, account, jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * The `free` model over real HTTP: the smartest free model first, the next one when it cannot
 * answer, and every other model name untouched. The failing case comes first throughout, because the
 * fingerprint is production's: 2026-11-23, `ling-3.2-flash:free` refused 84% of 344 requests with an
 * upstream throttle while another free model on the same key would have answered.
 */

const SUPER = "nvidia/nemotron-3.5-super-vl:free"
const ULTRA = "nvidia/nemotron-3-ultra-550b-a55b:free"
const PARTICLE = "particle-ai/particle-1:free"
const STEP5 = "stepfun-ai/step-5-preview"

const seat = (
  id: string,
  provider: NonNullable<AccountOptions["provider"]>,
  supportedModels: readonly string[],
  more: Partial<AccountOptions> = {},
): RoutableAccount =>
  account(id, {
    provider,
    apiKey: `sk-${id}`,
    cipher: CRYPTOR,
    baseUrl: `https://${id}.test/v1`,
    ...more,
    snapshot: { supportedModels, ...more.snapshot },
  })

const pool = (...accountIds: readonly string[]): PoolSnapshot => ({
  id: "free",
  name: "free",
  policy: "priority-failover",
  members: accountIds.map((accountId, priority) => ({ accountId, priority })),
})

const chat = (model: string, more: Record<string, unknown> = {}) =>
  post(JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...more }), bearer())

const answer = (model: string) => () =>
  jsonResponse(200, {
    id: "c",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

const throttled = () =>
  jsonResponse(429, {
    error: {
      message: "Provider returned error",
      code: 429,
      metadata: { raw: "temporarily rate-limited upstream" },
    },
  })

const asked = (calls: readonly { readonly url: string; readonly body: string }[]) =>
  calls.map(({ url, body }) => [
    new URL(url).hostname.replace(".test", ""),
    (JSON.parse(body) as { model: string }).model,
  ])

describe("model `free`", () => {
  test("a throttled model walks to the same model elsewhere, then to the next smartest", async () => {
    const { app, upstream, usage } = harness({
      accounts: [
        seat("kilo", "kilo", [PARTICLE, SUPER, ULTRA]),
        seat("or", "openrouter", [PARTICLE, SUPER, ULTRA]),
      ],
      pools: [pool("kilo", "or")],
      scope: "pools",
      poolIds: ["free"],
      responses: [throttled, throttled, answer(ULTRA)],
    })

    const res = await app.request("/v1/chat/completions", chat("free"))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { model: string }).model).toBe(ULTRA)
    await settle()

    expect(asked(upstream.calls)).toEqual([
      ["kilo", SUPER],
      ["or", SUPER],
      ["kilo", ULTRA],
    ])
    // Every attempt is on the record: `free` is what was asked, `upstream_model` what was tried.
    expect(usage.rows.map((row) => [row.model, row.upstreamModel, row.outcome])).toEqual([
      ["free", SUPER, "quota_exhausted"],
      ["free", SUPER, "quota_exhausted"],
      ["free", ULTRA, "success"],
    ])
  })

  test("the smartest model is asked first, wherever its account sits in the pool", async () => {
    const { app, upstream } = harness({
      accounts: [seat("kilo", "kilo", [SUPER]), seat("nim", "nvidia", [STEP5])],
      pools: [pool("kilo", "nim")],
      scope: "pools",
      poolIds: ["free"],
      responses: [answer(STEP5)],
    })

    expect((await app.request("/v1/chat/completions", chat("free"))).status).toBe(200)
    expect(asked(upstream.calls)).toEqual([["nim", STEP5]])
  })

  test("a held model is skipped by the next request, and its account still serves the rest", async () => {
    const { app, upstream } = harness({
      accounts: [seat("kilo", "kilo", [SUPER, ULTRA])],
      responses: [throttled, answer(ULTRA), answer(ULTRA)],
    })

    await app.request("/v1/chat/completions", chat("free"))
    await settle()
    expect((await app.request("/v1/chat/completions", chat("free"))).status).toBe(200)
    expect(asked(upstream.calls)).toEqual([
      ["kilo", SUPER],
      ["kilo", ULTRA],
      ["kilo", ULTRA],
    ])
  })

  test("an allowance that is the account's is not walked model by model", async () => {
    const { app, upstream } = harness({
      accounts: [
        seat("kilo", "kilo", [SUPER, ULTRA, PARTICLE]),
        seat("or", "openrouter", [PARTICLE]),
      ],
      pools: [pool("kilo", "or")],
      scope: "pools",
      poolIds: ["free"],
      responses: [
        () =>
          jsonResponse(429, {
            error: {
              message: "Rate limit exceeded for free models. Please try again later.",
              code: 429,
            },
          }),
        answer(PARTICLE),
      ],
    })

    expect((await app.request("/v1/chat/completions", chat("free"))).status).toBe(200)
    expect(asked(upstream.calls)).toEqual([
      ["kilo", SUPER],
      ["or", PARTICLE],
    ])
  })

  test("nothing a key pays for is ever asked, even when every free model failed", async () => {
    const { app, upstream } = harness({
      accounts: [
        seat("kilo", "kilo", [SUPER]),
        seat("or", "openrouter", [SUPER, "deepseek/deepseek-v4.1-flash"]),
        seat("compat", "openai-compatible", [], { snapshot: { supportedModels: [] } }),
        seat("renamed", "openrouter", ["anthropic/claude-opus-5.5"], {
          modelAliases: { [SUPER]: "anthropic/claude-opus-5.5" },
        }),
      ],
      pools: [pool("kilo", "or", "compat", "renamed")],
      scope: "pools",
      poolIds: ["free"],
      responses: [throttled],
    })

    const res = await app.request("/v1/chat/completions", chat("free"))
    expect(res.status).toBe(429)
    expect(asked(upstream.calls)).toEqual([
      ["kilo", SUPER],
      ["or", SUPER],
    ])
  })

  test("a request two models refuse for its own content stops there", async () => {
    const refuse = () =>
      jsonResponse(400, { error: { message: "messages: must not be empty", code: 400 } })
    const { app, upstream } = harness({
      accounts: [seat("kilo", "kilo", [SUPER, ULTRA, PARTICLE])],
      responses: [refuse],
    })

    expect((await app.request("/v1/chat/completions", chat("free"))).status).toBe(400)
    expect(upstream.calls).toHaveLength(2)
  })

  test("a pool with nothing free answers an unserved model, not a paid reply", async () => {
    const { app, upstream } = harness({
      accounts: [seat("or", "openrouter", ["deepseek/deepseek-v4.1-flash"])],
      responses: [answer("x")],
    })

    const res = await app.request("/v1/chat/completions", chat("free"))
    expect(res.status).toBe(404)
    expect(upstream.calls).toHaveLength(0)
  })

  test("an operator's own alias for `free` is theirs", async () => {
    const { app, upstream } = harness({
      accounts: [
        seat("or", "openrouter", ["z-ai/glm-5.3"], { modelAliases: { free: "z-ai/glm-5.3" } }),
        seat("kilo", "kilo", [SUPER]),
      ],
      responses: [answer("z-ai/glm-5.3")],
    })

    expect((await app.request("/v1/chat/completions", chat("free"))).status).toBe(200)
    expect(asked(upstream.calls)).toEqual([["or", "z-ai/glm-5.3"]])
  })

  test("a named model is never moved onto a free one", async () => {
    const { app, upstream } = harness({
      accounts: [seat("kilo", "kilo", [SUPER, ULTRA])],
      responses: [throttled],
    })

    expect((await app.request("/v1/chat/completions", chat(SUPER))).status).toBe(429)
    expect(asked(upstream.calls)).toEqual([["kilo", SUPER]])
  })
})

describe("GET /v1/free-models", () => {
  test("lists what the key reaches for nothing, smartest first", async () => {
    const { app } = harness({
      accounts: [
        seat("kilo", "kilo", [PARTICLE, SUPER]),
        seat("or", "openrouter", ["deepseek/deepseek-v4.1-flash", SUPER]),
        seat("nim", "nvidia", [STEP5]),
      ],
      responses: [answer("x")],
      models: { describe: () => null, modelsOf: () => [] },
    })

    const res = await app.request("/v1/free-models", { headers: bearer() })
    const body = (await res.json()) as {
      readonly ranking_as_of: string
      readonly data: readonly { id: string; rank: number; providers: readonly string[] }[]
    }

    expect(body.data.map(({ id, rank }) => [rank, id])).toEqual([
      [1, STEP5],
      [2, SUPER],
      [3, PARTICLE],
    ])
    expect([...(body.data[1]?.providers ?? [])].sort()).toEqual(["kilo", "openrouter"])
    expect(body.ranking_as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("takes a router key like every other data-plane path", async () => {
    const { app } = harness({ responses: [answer("x")] })
    expect((await app.request("/v1/free-models")).status).toBe(401)
  })
})
