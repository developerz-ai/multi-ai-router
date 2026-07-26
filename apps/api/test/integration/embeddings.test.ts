import { describe, expect, test } from "bun:test"
import { account, jsonResponse, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, KEY, MESSAGE, post, settle } from "./harness"

/**
 * `POST /v1/embeddings`, end to end: real Hono, real middleware, real routing, **mocked upstreams**.
 *
 * Every RAG toolchain — LangChain, LlamaIndex, Continue.dev — calls this beside its chat traffic,
 * and pointing one of them at a second base URL to get it defeats the point of pooling credentials
 * behind one endpoint. The rules this suite pins down:
 *
 *  - it is an ordinary data-plane request — same key, same scope intersection, same failover chain;
 *  - it is **passthrough or nothing**, and both OpenAI dialects are one family for it: the body
 *    names no chat surface, so an Account's chat pin does not decide whether it can embed;
 *  - an account whose provider states no embeddings endpoint is dropped by name, never answered
 *    with another model's vectors;
 *  - its `prompt_tokens` were genuinely spent, so unlike a token count they are accounted — as
 *    input alone, with the absent completion count landing as the zero it truthfully is.
 */

const EMBED = JSON.stringify({
  model: "text-embedding-3-small",
  input: "the quick brown fox",
})

const EMBEDDED = () =>
  jsonResponse(200, {
    object: "list",
    data: [{ object: "embedding", index: 0, embedding: [0.1, -0.2, 0.3] }],
    model: "text-embedding-3-small",
    usage: { prompt_tokens: 8, total_tokens: 8 },
  })

const openAi = (id = "acct-1", key = "sk-one") =>
  account(id, { provider: "openai-api", apiKey: key, cipher: CRYPTOR })

describe("passthrough", () => {
  test("forwards the body byte for byte to the OpenAI embeddings suffix", async () => {
    const { app, upstream } = harness({ accounts: [openAi()], responses: [EMBEDDED] })

    const res = await app.request("/v1/embeddings", post(EMBED, bearer()))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ object: "list", model: "text-embedding-3-small" })
    const call = upstream.calls[0]
    expect(call?.url).toBe("https://upstream.test/embeddings")
    expect(call?.method).toBe("POST")
    expect(call?.body).toBe(EMBED)
    // The router key never leaves; the account's credential is what the upstream sees.
    expect(call?.headers.get("authorization")).toBe("Bearer sk-one")
  })

  test("an account pinned to the Responses surface embeds off the same endpoint", async () => {
    const { app, upstream } = harness({
      accounts: [
        account("r", {
          provider: "openai-api",
          dialect: "openai-responses",
          apiKey: "sk-r",
          cipher: CRYPTOR,
        }),
      ],
      responses: [EMBEDDED],
    })

    const res = await app.request("/v1/embeddings", post(EMBED, bearer()))

    expect(res.status).toBe(200)
    // Not translated into a Responses body: an embeddings request has no chat surface to convert.
    expect(upstream.calls[0]?.url).toBe("https://upstream.test/embeddings")
    expect(upstream.calls[0]?.body).toBe(EMBED)
  })

  test("accepts the Anthropic key form too, and answers in the OpenAI error shape", async () => {
    const { app } = harness({ accounts: [openAi()], responses: [EMBEDDED] })

    expect((await app.request("/v1/embeddings", post(EMBED, { "x-api-key": KEY }))).status).toBe(
      200,
    )

    const unauthorized = await app.request("/v1/embeddings", post(EMBED))
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({
      error: { type: "authentication_error", param: null },
    })
  })

  test("applies the account's alias map, because the vectors must come from the model it bills", async () => {
    const { app, upstream } = harness({
      accounts: [
        account("acct-1", {
          provider: "openai-compatible",
          apiKey: "sk-compat",
          cipher: CRYPTOR,
          modelAliases: { "text-embedding-3-small": "bge-m3" },
        }),
      ],
      responses: [EMBEDDED],
    })

    await app.request("/v1/embeddings", post(EMBED, bearer()))

    const sent = JSON.parse(upstream.calls[0]?.body ?? "{}") as Record<string, unknown>
    expect(sent.model).toBe("bge-m3")
  })

  test("relays the upstream's own refusal instead of inventing a vector", async () => {
    // A chat-only OpenAI-compatible endpoint that never implemented embeddings. Its 404 is the
    // honest answer and it reaches the client unchanged.
    const { app } = harness({
      accounts: [
        account("compat", {
          provider: "openai-compatible",
          apiKey: "sk-compat",
          cipher: CRYPTOR,
        }),
      ],
      responses: [
        () => jsonResponse(404, { error: { message: "unknown route", type: "invalid" } }),
      ],
    })

    const res = await app.request("/v1/embeddings", post(EMBED, bearer()))

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { message: "unknown route" } })
  })
})

describe("routing", () => {
  test("fails over exactly like inference does", async () => {
    const { app, upstream, usage } = harness({
      accounts: [openAi("acct-1", "sk-one"), openAi("acct-2", "sk-two")],
      responses: [() => jsonResponse(429, {}), EMBEDDED],
    })

    const res = await app.request("/v1/embeddings", post(EMBED, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[1]?.url).toBe("https://upstream.test/embeddings")
    expect(usage.rows.map((row) => row.outcome)).toEqual(["quota_exhausted", "success"])
  })

  test("a mixed pool answers off the one account that can embed", async () => {
    const invoked: string[] = []
    const { app, upstream } = harness({
      accounts: [
        subscriptionAccount("sub"),
        account("anthropic", { apiKey: "sk-a", cipher: CRYPTOR }),
        openAi("o", "sk-o"),
      ],
      responses: [EMBEDDED],
      invokeSdk: async ({ configDir }) => {
        invoked.push(configDir)
        return jsonResponse(200, {})
      },
    })

    const res = await app.request("/v1/embeddings", post(EMBED, bearer()))

    expect(res.status).toBe(200)
    expect(upstream.calls[0]?.headers.get("authorization")).toBe("Bearer sk-o")
    // The subscription and the Anthropic key were dropped at planning, never attempted.
    expect(upstream.calls).toHaveLength(1)
    expect(invoked).toEqual([])
  })

  test("scope still decides the candidate set", async () => {
    const { app, upstream } = harness({
      accounts: [openAi()],
      scope: "accounts",
      accountIds: [],
      responses: [EMBEDDED],
    })

    expect((await app.request("/v1/embeddings", post(EMBED, bearer()))).status).toBe(403)
    expect(upstream.calls).toHaveLength(0)
  })

  test("an embedding model id filters accounts exactly as a chat one does", async () => {
    const { app, upstream } = harness({
      accounts: [
        // Declares its models and does not list this one — filtered before any egress decision, the
        // same way it would be for a chat model it never declared.
        account("chat-only", {
          provider: "openai-api",
          apiKey: "sk-chat",
          cipher: CRYPTOR,
          snapshot: { supportedModels: ["gpt-5"] },
        }),
        account("embeds", {
          provider: "openai-api",
          apiKey: "sk-embed",
          cipher: CRYPTOR,
          snapshot: { supportedModels: ["text-embedding-3-small"] },
        }),
      ],
      responses: [EMBEDDED],
    })

    expect((await app.request("/v1/embeddings", post(EMBED, bearer()))).status).toBe(200)
    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]?.headers.get("authorization")).toBe("Bearer sk-embed")
  })

  test("no in-scope account declaring the embedding model is a 503 naming the accounts", async () => {
    const { app, upstream } = harness({
      accounts: [
        account("chat-only", {
          provider: "openai-api",
          apiKey: "sk-chat",
          cipher: CRYPTOR,
          snapshot: { supportedModels: ["gpt-5"] },
        }),
      ],
      responses: [EMBEDDED],
    })

    const res = await app.request("/v1/embeddings", post(EMBED, bearer()))
    const body = (await res.json()) as { error: { message: string } }

    expect(res.status).toBe(503)
    expect(body.error.message).toContain("chat-only")
    expect(upstream.calls).toHaveLength(0)
  })
})

describe("accounts that cannot embed", () => {
  test("an anthropic-only pool is refused by name, never with another model's vectors", async () => {
    const { app, upstream } = harness({
      accounts: [account("a", { apiKey: "sk-a", cipher: CRYPTOR })],
      responses: [EMBEDDED],
    })

    const res = await app.request("/v1/embeddings", post(EMBED, bearer()))
    const body = (await res.json()) as { error: { message: string; type: string } }

    expect(res.status).toBe(503)
    expect(body.error.type).toBe("server_error")
    expect(body.error.message).toContain("anthropic")
    expect(upstream.calls).toHaveLength(0)
  })

  test("a Claude-subscription-only pool says so by name, and spawns no subprocess", async () => {
    const invoked: string[] = []
    const { app, upstream } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [EMBEDDED],
      invokeSdk: async ({ configDir }) => {
        invoked.push(configDir)
        return jsonResponse(200, {})
      },
    })

    const res = await app.request("/v1/embeddings", post(EMBED, bearer()))
    const body = (await res.json()) as { error: { message: string } }

    expect(res.status).toBe(503)
    expect(body.error.message).toContain("Claude Agent SDK")
    // Nothing was forged at api.anthropic.com and no subprocess was launched to guess a vector.
    expect(upstream.calls).toHaveLength(0)
    expect(invoked).toEqual([])
  })

  test("inference over that same anthropic pool still works — only embedding is narrowed", async () => {
    const { app } = harness({
      accounts: [account("a", { apiKey: "sk-a", cipher: CRYPTOR })],
      responses: [() => jsonResponse(200, { id: "msg_1", type: "message", role: "assistant" })],
    })

    expect((await app.request("/v1/messages", post(MESSAGE, bearer()))).status).toBe(200)
  })
})

describe("accounting", () => {
  test("records the input tokens it spent, and no output tokens", async () => {
    const { app, usage } = harness({ accounts: [openAi()], responses: [EMBEDDED] })

    await (await app.request("/v1/embeddings", post(EMBED, bearer()))).text()
    await settle()

    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      outcome: "success",
      egressMode: "passthrough",
      accountId: "acct-1",
      model: "text-embedding-3-small",
      tokensIn: 8,
      // An embedding produces no completion. Zero here is measured, not defaulted.
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      // This image ships no OpenAI price table, so the spend column stays honest about it.
      costEstimate: null,
      costBasis: "unknown",
    })
  })

  test("writes a row even when no account could embed", async () => {
    const { app, usage } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [EMBEDDED],
    })

    await app.request("/v1/embeddings", post(EMBED, bearer()))
    await settle()

    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      accountId: null,
      outcome: "no_healthy_account",
      errorClass: "NoHealthyAccountError",
    })
  })
})
