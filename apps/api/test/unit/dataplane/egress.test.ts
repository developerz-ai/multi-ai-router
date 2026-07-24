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

  test("differing dialects are refused by name, before any upstream call", () => {
    const decision = resolveEgress("anthropic", account("a", { provider: "openai-api" }))

    expect(decision.mode).toBe("rejected")
    if (decision.mode !== "rejected") return
    expect(decision.reason).toBe("cross-dialect")
    expect(egressRejectionError(decision)).toBeInstanceOf(TranslationError)
  })

  test("a Claude subscription is refused as the Agent-SDK path, not as a bad request", () => {
    const decision = resolveEgress("anthropic", account("a", { provider: "anthropic-oauth" }))

    expect(decision.mode).toBe("rejected")
    if (decision.mode !== "rejected") return
    expect(decision.reason).toBe("agent-sdk")
    // 503, not 400: the caller did nothing wrong and there is nothing they can change.
    expect(egressRejectionError(decision)).toBeInstanceOf(NoHealthyAccountError)
  })

  test("an account's chosen surface decides the dialect, not the provider default", () => {
    const zaiOpenAi = account("z", { provider: "zai", dialect: "openai-chat" })
    expect(resolveEgress("openai-chat", zaiOpenAi).mode).toBe("passthrough")
    expect(resolveEgress("anthropic", zaiOpenAi).mode).toBe("rejected")
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
