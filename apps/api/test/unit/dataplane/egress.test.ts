import { describe, expect, test } from "bun:test"
import {
  CredentialDecryptError,
  NoHealthyAccountError,
  TranslationError,
} from "@multi-ai-router/core"
import { httpDriver } from "../../../src/providers"
import {
  accountCredential,
  clientHeaders,
  egressRejectionError,
  resolveEgress,
  upstreamCountTokensUrl,
  upstreamEmbeddingsUrl,
  upstreamHeaders,
  upstreamUrl,
} from "../../../src/services/dataplane"
import { account, cipher, subscriptionAccount } from "./fixtures"

/** The egress decision, the endpoint it addresses, and the headers it swaps. */

describe("egress mode", () => {
  test("same dialect is a passthrough", () => {
    const decision = resolveEgress("anthropic", account("a", { provider: "anthropic-api" }))
    expect(decision.mode).toBe("passthrough")
  })

  test("differing dialects translate, carrying the pair that will do it", () => {
    const decision = resolveEgress("anthropic", account("a", { provider: "openai-api" }))

    expect(decision.mode).toBe("translate")
    if (decision.mode !== "translate") return
    expect(decision.from).toBe("anthropic")
    expect(decision.to).toBe("openai-chat")
    expect(decision.pair.ingress).toBe("anthropic")
    expect(decision.pair.egress).toBe("openai-chat")
  })

  test("an openai-responses client on an openai-chat account takes the documented downgrade", () => {
    const decision = resolveEgress("openai-responses", account("a", { provider: "openai-api" }))

    expect(decision.mode).toBe("translate")
    if (decision.mode !== "translate") return
    expect(decision.pair.ingress).toBe("openai-responses")
    expect(decision.pair.egress).toBe("openai-chat")
  })

  test("a dialect pair with no translator is a 400, not a capacity failure", () => {
    // Every crossing between the three HTTP dialects has a translator, so the rejection itself is
    // only reachable through the mapping — which is what a caller sees, and what must not become a
    // 503: the request is bad at every account needing the same conversion.
    const rejection = {
      mode: "rejected",
      reason: "no-translator",
      message: "no translation",
    } as const

    expect(egressRejectionError(rejection)).toBeInstanceOf(TranslationError)
  })

  test("an unimplemented provider is a capacity failure, not a bad request", () => {
    // Every declared provider has a driver today, so this rejection — like `no-translator` above —
    // is reachable only through the mapping. 503, not 400: the caller did nothing wrong and there
    // is nothing they can change, so a 400 would send them looking in the wrong place.
    const rejection = {
      mode: "rejected",
      reason: "unimplemented",
      message: "provider x has no driver",
    } as const

    expect(egressRejectionError(rejection)).toBeInstanceOf(NoHealthyAccountError)
  })

  test("gemini speaks Google's OpenAI-compatibility surface, so a chat client passes through", () => {
    const gemini = account("g", { provider: "gemini" })

    expect(resolveEgress("openai-chat", gemini).mode).toBe("passthrough")
    // Its native GenAI dialect is still deferred, so an Anthropic client is translated, not refused.
    expect(resolveEgress("anthropic", gemini).mode).toBe("translate")
  })

  test("an account's chosen surface decides the dialect, not the provider default", () => {
    const zaiOpenAi = account("z", { provider: "zai", dialect: "openai-chat" })
    expect(resolveEgress("openai-chat", zaiOpenAi).mode).toBe("passthrough")
    // The same account on the other surface is a conversion, not a passthrough.
    expect(resolveEgress("anthropic", zaiOpenAi).mode).toBe("translate")
  })
})

describe("counting tokens", () => {
  test("an anthropic-dialect account passes the count straight through", () => {
    const decision = resolveEgress("anthropic", account("a"), "count-tokens")
    expect(decision.mode).toBe("passthrough")
  })

  test("the same account still translates ordinary inference — only counting is narrowed", () => {
    expect(resolveEgress("anthropic", account("o", { provider: "openai-api" })).mode).toBe(
      "translate",
    )
  })

  test("an openai account cannot count, and is never estimated for", () => {
    const openAi = account("o", { provider: "openai-api" })
    const decision = resolveEgress("anthropic", openAi, "count-tokens")

    expect(decision.mode).toBe("rejected")
    if (decision.mode !== "rejected") return
    expect(decision.reason).toBe("unsupported-operation")
    expect(decision.message).toContain("openai-chat")
    // 503, not 400: the body is a valid anthropic request and only the operator can fix the pool.
    expect(egressRejectionError(decision)).toBeInstanceOf(NoHealthyAccountError)
  })

  test("a Claude subscription says so by name — the Agent SDK exposes no token count", () => {
    const decision = resolveEgress("anthropic", subscriptionAccount("sub"), "count-tokens")

    expect(decision.mode).toBe("rejected")
    if (decision.mode !== "rejected") return
    expect(decision.reason).toBe("unsupported-operation")
    expect(decision.message).toContain("Claude Agent SDK")
  })

  test("a gemini account cannot count either — Google's surface states no such endpoint", () => {
    const decision = resolveEgress(
      "anthropic",
      account("g", { provider: "gemini" }),
      "count-tokens",
    )

    expect(decision.mode).toBe("rejected")
    if (decision.mode !== "rejected") return
    expect(decision.reason).toBe("unsupported-operation")
  })
})

describe("embeddings", () => {
  test("an openai-chat account passes the body straight through", () => {
    const decision = resolveEgress(
      "openai-chat",
      account("o", { provider: "openai-api" }),
      "embeddings",
    )
    expect(decision.mode).toBe("passthrough")
  })

  test("an account pinned to the other OpenAI surface embeds too — the chat surface does not decide it", () => {
    // Ordinary inference across the two OpenAI dialects is a documented downgrade...
    const responses = account("r", { provider: "openai-api", dialect: "openai-responses" })
    expect(resolveEgress("openai-chat", responses).mode).toBe("translate")
    // ...but an embeddings body names no chat surface, so both reach the same endpoint untouched.
    const decision = resolveEgress("openai-chat", responses, "embeddings")

    expect(decision.mode).toBe("passthrough")
    if (decision.mode !== "passthrough") return
    expect(decision.dialect).toBe("openai-responses")
  })

  test("an anthropic account cannot embed, and is never answered with another model's vectors", () => {
    const decision = resolveEgress("openai-chat", account("a"), "embeddings")

    expect(decision.mode).toBe("rejected")
    if (decision.mode !== "rejected") return
    expect(decision.reason).toBe("unsupported-operation")
    expect(decision.message).toContain("anthropic")
    // 503, not 400: the body is a valid embeddings request and only the operator can fix the pool.
    expect(egressRejectionError(decision)).toBeInstanceOf(NoHealthyAccountError)
  })

  test("the same anthropic account still serves ordinary inference — only embedding is narrowed", () => {
    expect(resolveEgress("openai-chat", account("a")).mode).toBe("translate")
  })

  test("a Claude subscription says so by name — the Agent SDK is a completion transport", () => {
    const decision = resolveEgress("openai-chat", subscriptionAccount("sub"), "embeddings")

    expect(decision.mode).toBe("rejected")
    if (decision.mode !== "rejected") return
    expect(decision.reason).toBe("unsupported-operation")
    expect(decision.message).toContain("Claude Agent SDK")
  })

  test("a gemini account embeds — its compatibility surface serves the same OpenAI path", () => {
    const decision = resolveEgress(
      "openai-chat",
      account("g", { provider: "gemini" }),
      "embeddings",
    )

    expect(decision.mode).toBe("passthrough")
    if (decision.mode !== "passthrough") return
    expect(decision.dialect).toBe("openai-chat")
  })
})

describe("endpoint", () => {
  test("each dialect addresses its own path below the account's base URL", () => {
    const driver = httpDriver("anthropic-compatible")
    if (driver === null) throw new Error("expected a driver")
    const entry = account("a", {
      provider: "anthropic-compatible",
      baseUrl: "https://proxy.test/api",
    })

    expect(upstreamUrl(driver, entry.driver, "anthropic").toString()).toBe(
      "https://proxy.test/api/v1/messages",
    )
  })

  test("the OpenAI base already carries /v1, so the suffix does not repeat it", () => {
    const driver = httpDriver("openai-api")
    if (driver === null) throw new Error("expected a driver")
    const entry = account("o", { provider: "openai-api", baseUrl: undefined })

    expect(upstreamUrl(driver, { ...entry.driver, baseUrl: null }, "openai-chat").toString()).toBe(
      "https://api.openai.com/v1/chat/completions",
    )
  })

  test("the token count sits below the same base, on Anthropic's own suffix", () => {
    const driver = httpDriver("anthropic-compatible")
    if (driver === null) throw new Error("expected a driver")
    const entry = account("a", {
      provider: "anthropic-compatible",
      baseUrl: "https://proxy.test/api",
    })

    expect(upstreamCountTokensUrl(driver, entry.driver).toString()).toBe(
      "https://proxy.test/api/v1/messages/count_tokens",
    )
  })

  test("embeddings sit below the OpenAI base, which already carries /v1", () => {
    const driver = httpDriver("openai-api")
    if (driver === null) throw new Error("expected a driver")
    const entry = account("o", { provider: "openai-api" })

    expect(upstreamEmbeddingsUrl(driver, { ...entry.driver, baseUrl: null }).toString()).toBe(
      "https://api.openai.com/v1/embeddings",
    )
  })

  test("a self-hosted OpenAI-compatible endpoint keeps the path its base URL carries", () => {
    const driver = httpDriver("openai-compatible")
    if (driver === null) throw new Error("expected a driver")
    const entry = account("v", {
      provider: "openai-compatible",
      baseUrl: "https://vllm.internal/openai/v1",
    })

    expect(upstreamEmbeddingsUrl(driver, entry.driver).toString()).toBe(
      "https://vllm.internal/openai/v1/embeddings",
    )
  })
})

describe("header swap", () => {
  test("strips the router key and hop-by-hop headers, keeps everything else", () => {
    const client = new Headers({
      authorization: "Bearer mar_live_secret",
      "x-api-key": "mar_live_secret",
      "content-type": "application/json",
      "anthropic-beta": "some-future-flag",
      connection: "keep-alive",
      cookie: "session=1",
    })

    const out = upstreamHeaders(client, new Headers({ "x-api-key": "sk-upstream" }))

    expect(out.get("authorization")).toBeNull()
    expect(out.get("cookie")).toBeNull()
    expect(out.get("connection")).toBeNull()
    // A beta flag the router has never heard of survives — that is what passthrough is for.
    expect(out.get("anthropic-beta")).toBe("some-future-flag")
    expect(out.get("content-type")).toBe("application/json")
    expect(out.get("x-api-key")).toBe("sk-upstream")
  })

  test("driver headers win, so a client cannot displace the credential", () => {
    const client = new Headers({ "anthropic-version": "1999-01-01" })
    const out = upstreamHeaders(client, new Headers({ "anthropic-version": "2023-06-01" }))
    expect(out.get("anthropic-version")).toBe("2023-06-01")
  })

  test("response framing headers are dropped, because fetch already decoded the body", () => {
    const upstream = new Headers({
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
      "content-length": "42",
      "set-cookie": "a=b",
      "anthropic-ratelimit-requests-remaining": "9",
    })

    const out = clientHeaders(upstream)

    expect(out.get("content-encoding")).toBeNull()
    expect(out.get("content-length")).toBeNull()
    expect(out.get("set-cookie")).toBeNull()
    expect(out.get("content-type")).toBe("text/event-stream")
    expect(out.get("anthropic-ratelimit-requests-remaining")).toBe("9")
  })
})

describe("credential", () => {
  test("decrypts an API key", () => {
    const cryptor = cipher()
    const entry = account("a", { apiKey: "sk-live-123", cipher: cryptor })
    expect(accountCredential(entry, cryptor)).toEqual({ kind: "api-key", apiKey: "sk-live-123" })
  })

  test("recognizes a stored OAuth token pair by shape", () => {
    const cryptor = cipher()
    const entry = account("a", {
      apiKey: JSON.stringify({ accessToken: "at-1", refreshToken: "rt-1" }),
      cipher: cryptor,
    })
    expect(accountCredential(entry, cryptor)).toEqual({ kind: "oauth", accessToken: "at-1" })
  })

  test("an account with no material fails without naming any ciphertext", () => {
    const cryptor = cipher()
    const entry = { ...account("a", { cipher: cryptor }), authMaterial: null }
    expect(() => accountCredential(entry, cryptor)).toThrow(CredentialDecryptError)
  })
})
