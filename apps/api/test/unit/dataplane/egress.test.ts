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
  upstreamHeaders,
  upstreamUrl,
} from "../../../src/services/dataplane"
import { account, cipher } from "./fixtures"

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
    const decision = resolveEgress("openai-responses", account("a", { provider: "gemini" }))

    expect(decision.mode).toBe("rejected")
    if (decision.mode !== "rejected") return
    expect(decision.reason).toBe("unimplemented")
    // 503, not 400: the caller did nothing wrong and there is nothing they can change.
    expect(egressRejectionError(decision)).toBeInstanceOf(NoHealthyAccountError)
  })

  test("an account's chosen surface decides the dialect, not the provider default", () => {
    const zaiOpenAi = account("z", { provider: "zai", dialect: "openai-chat" })
    expect(resolveEgress("openai-chat", zaiOpenAi).mode).toBe("passthrough")
    // The same account on the other surface is a conversion, not a passthrough.
    expect(resolveEgress("anthropic", zaiOpenAi).mode).toBe("translate")
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
