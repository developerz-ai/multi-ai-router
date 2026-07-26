import { describe, expect, test } from "bun:test"
import { ProviderId } from "@multi-ai-router/core"
import { describeProvider, describeProviders } from "../../../src/services/accounts"

/**
 * The descriptors the console renders its "add account" form from. Every
 * assertion here is really about *derivation*: nothing in this layer may hold a
 * second copy of the provider list, the endpoint defaults, or the dialects.
 */

describe("describeProviders", () => {
  test("covers the registry exactly — no provider is described twice or missed", () => {
    const described = describeProviders().map((provider) => provider.id)
    expect([...described].sort()).toEqual([...ProviderId.options].sort())
  })

  test("every descriptor is complete enough to render a form row", () => {
    for (const provider of describeProviders()) {
      expect(provider.transport).toBeOneOf(["http", "agent-sdk", "unimplemented"])
      expect(typeof provider.requiresBaseUrl).toBe("boolean")
      expect(typeof provider.creatable).toBe("boolean")
    }
  })
})

describe("base URL requirement", () => {
  test("the *-compatible escape hatches have no pinned endpoint and demand one", () => {
    expect(describeProvider("openai-compatible").requiresBaseUrl).toBe(true)
    expect(describeProvider("anthropic-compatible").requiresBaseUrl).toBe(true)
  })

  test("a provider with a pinned endpoint does not", () => {
    expect(describeProvider("anthropic-api").requiresBaseUrl).toBe(false)
    expect(describeProvider("openrouter").requiresBaseUrl).toBe(false)
    expect(describeProvider("zai").requiresBaseUrl).toBe(false)
  })
})

describe("dialects", () => {
  test("a single-surface provider offers exactly its native dialect", () => {
    const kimi = describeProvider("kimi")
    expect(kimi.supportedDialects).toEqual([kimi.nativeDialect ?? "openai-chat"])
  })

  test("a multi-surface provider offers every surface its driver declares", () => {
    const openai = describeProvider("openai-api")
    expect(openai.nativeDialect).toBe("openai-chat")
    expect([...openai.supportedDialects].sort()).toEqual(["openai-chat", "openai-responses"])
  })

  test("z.ai offers both surfaces, with the Anthropic one as its default", () => {
    const zai = describeProvider("zai")
    expect(zai.nativeDialect).toBe("anthropic")
    expect([...zai.supportedDialects].sort()).toEqual(["anthropic", "openai-chat"])
  })
})

describe("transport", () => {
  test("Claude subscriptions are served by the Agent SDK and want a config dir, not a key", () => {
    const claude = describeProvider("anthropic-oauth")
    expect(claude.transport).toBe("agent-sdk")
    expect(claude.requiresConfigDir).toBe(true)
    expect(claude.creatable).toBe(true)
    expect(claude.reason).toContain("claude-agent-sdk")
  })

  test("every declared provider is implemented, so the console greys none of them out", () => {
    // `unimplemented` is still a transport a descriptor can carry — it is where an id declared in
    // `packages/core` ahead of its driver lands. No provider sits there today, and this says so.
    for (const provider of describeProviders()) {
      expect(provider.transport).not.toBe("unimplemented")
      expect(provider.creatable).toBe(true)
    }
  })

  test("gemini is an HTTP key provider on one OpenAI surface, with a pinned endpoint", () => {
    const gemini = describeProvider("gemini")
    expect(gemini.transport).toBe("http")
    expect(gemini.authKind).toBe("api-key")
    expect(gemini.nativeDialect).toBe("openai-chat")
    expect(gemini.supportedDialects).toEqual(["openai-chat"])
    expect(gemini.requiresBaseUrl).toBe(false)
    expect(gemini.connectFlow).toBeNull()
  })

  test("the six OpenAI-shaped vendors render as one-surface key providers, nothing to connect", () => {
    for (const id of ["groq", "deepseek", "xai", "mistral", "together", "cerebras"] as const) {
      const provider = describeProvider(id)

      expect(provider.transport).toBe("http")
      expect(provider.authKind).toBe("api-key")
      expect(provider.supportedDialects).toEqual(["openai-chat"])
      expect(provider.requiresBaseUrl).toBe(false)
      expect(provider.requiresConfigDir).toBe(false)
      expect(provider.connectFlow).toBeNull()
    }
  })

  test("an HTTP provider reports the auth style its driver declares", () => {
    expect(describeProvider("kimi").transport).toBe("http")
    expect(describeProvider("kimi").authKind).toBe("api-key")
  })
})
