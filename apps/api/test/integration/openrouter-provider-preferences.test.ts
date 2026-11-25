import { describe, expect, test } from "bun:test"
import type { ProviderId, ProviderPreferences } from "@multi-ai-router/core"
import { loadCatalog } from "../../src/services/catalog"
import { accountRow } from "../support/account-row"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * An OpenRouter account's `provider` preferences reach the upstream in the body it is sent — on the
 * same-dialect passthrough and on a translated body alike — and nothing else changes: an account
 * without preferences, and every account whose surface takes no `provider` field, is sent the bytes
 * it was sent before. The upstream is a mock.
 */

const CODING: ProviderPreferences = {
  sort: "price",
  quantizations: ["fp8", "bf16"],
  allow_fallbacks: true,
}

function chatCompletion(): Response {
  return Response.json({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "deepseek/deepseek-v4.1-flash",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
  })
}

const CHAT = `{"model":"deepseek/deepseek-v4.1-flash",  "messages":[{"role":"user","content":"fix the bug"}]}`

const MESSAGES = JSON.stringify({
  model: "deepseek/deepseek-v4.1-flash",
  max_tokens: 64,
  messages: [{ role: "user", content: "fix the bug" }],
})

async function sent(input: {
  provider: ProviderId
  preferences?: ProviderPreferences
  path: "/v1/chat/completions" | "/v1/messages"
  body: string
  account?: ReturnType<typeof account>
}): Promise<string> {
  const { app, upstream } = harness({
    accounts: [
      input.account ??
        account("a", {
          provider: input.provider,
          cipher: CRYPTOR,
          ...(input.preferences === undefined ? {} : { providerPreferences: input.preferences }),
        }),
    ],
    responses: [chatCompletion],
  })
  const res = await app.request(input.path, post(input.body, bearer()))
  expect(res.status).toBe(200)
  await res.text()
  expect(upstream.calls).toHaveLength(1)
  return upstream.calls[0]?.body ?? ""
}

describe("openrouter provider preferences on egress", () => {
  test("a same-dialect body carries the account's object, the client's bytes otherwise intact", async () => {
    const body = await sent({
      provider: "openrouter",
      preferences: CODING,
      path: "/v1/chat/completions",
      body: CHAT,
    })
    expect(body).toBe(
      `{"provider":{"sort":"price","quantizations":["fp8","bf16"],"allow_fallbacks":true},${CHAT.slice(1)}`,
    )
  })

  test("a client's own provider field wins field by field", async () => {
    const client = JSON.stringify({ ...JSON.parse(CHAT), provider: { sort: "throughput" } })
    const body = await sent({
      provider: "openrouter",
      preferences: CODING,
      path: "/v1/chat/completions",
      body: client,
    })
    expect(JSON.parse(body).provider).toEqual({ ...CODING, sort: "throughput" })
  })

  test("a translated (Anthropic-wire) body carries it too", async () => {
    const body = await sent({
      provider: "openrouter",
      preferences: CODING,
      path: "/v1/messages",
      body: MESSAGES,
    })
    expect(JSON.parse(body).provider).toEqual(CODING)
  })

  test("an openrouter account with no preferences is sent the client's exact bytes", async () => {
    expect(await sent({ provider: "openrouter", path: "/v1/chat/completions", body: CHAT })).toBe(
      CHAT,
    )
  })

  test("an account whose surface takes no provider field never gets one, whatever it holds", async () => {
    const passthrough = await sent({
      provider: "deepseek",
      preferences: CODING,
      path: "/v1/chat/completions",
      body: CHAT,
    })
    expect(passthrough).toBe(CHAT)
    const translated = await sent({
      provider: "deepseek",
      preferences: CODING,
      path: "/v1/messages",
      body: MESSAGES,
    })
    expect(translated).not.toContain('"provider"')
  })
})

describe("price-sort defaults on the spend-driving OpenRouter models", () => {
  const ACCOUNT_ID = "8b609813-f618-409c-85e9-60373a618fcf"

  async function catalogAccount(): Promise<ReturnType<typeof account>> {
    const { accounts } = await loadCatalog(
      {
        read: async () => ({
          accounts: [accountRow({ id: ACCOUNT_ID, provider: "openrouter" })],
          pools: [],
          members: [],
          windows: [],
          recoveries: [],
        }),
      },
      undefined,
      { accountIds: new Set([ACCOUNT_ID]), preferences: CODING },
    )
    const loaded = accounts[0]
    if (loaded === undefined) throw new Error("configured account missing from catalog")
    return {
      ...loaded,
      // The catalog never carries the credential itself; the composition root injects it at
      // request time. The harness takes it on the fixture, with the mock upstream's key.
      authMaterial: CRYPTOR.encrypt("sk-upstream-mock"),
    }
  }

  for (const model of ["deepseek/deepseek-v4.1-flash", "tencent/hy4-flash"]) {
    test(`${model}: price-sort reaches the upstream and the model name is untouched`, async () => {
      const body = JSON.stringify({ model, messages: [{ role: "user", content: "fix" }] })
      const loaded = await catalogAccount()
      const { app, upstream } = harness({
        accounts: [loaded],
        responses: [
          () =>
            Response.json({
              id: "chatcmpl_1",
              object: "chat.completion",
              created: 1,
              model,
              choices: [
                { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
        ],
      })
      const res = await app.request("/v1/chat/completions", post(body, bearer()))
      expect(res.status).toBe(200)
      await res.text()
      expect(upstream.calls).toHaveLength(1)
      const sentBody = JSON.parse(upstream.calls[0]?.body ?? "")
      expect(sentBody.provider).toEqual(CODING)
      expect(sentBody.model).toBe(model)
    })
  }

  test("a client-supplied provider still wins field by field on an injected account", async () => {
    const body = JSON.stringify({
      model: "deepseek/deepseek-v4.1-flash",
      provider: { sort: "throughput", require_parameters: true },
      messages: [{ role: "user", content: "fix" }],
    })
    const loaded = await catalogAccount()
    const { app, upstream } = harness({ accounts: [loaded], responses: [chatCompletion] })
    const res = await app.request("/v1/chat/completions", post(body, bearer()))
    expect(res.status).toBe(200)
    await res.text()
    expect(JSON.parse(upstream.calls[0]?.body ?? "").provider).toEqual({
      ...CODING,
      sort: "throughput",
      require_parameters: true,
    })
  })
})
