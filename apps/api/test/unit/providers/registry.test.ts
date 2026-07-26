import { describe, expect, test } from "bun:test"
import { ProviderId } from "@multi-ai-router/core"
import { HTTP_DRIVERS, httpDriver, PROVIDER_REGISTRY } from "../../../src/providers"

/**
 * The registry is the Open/Closed rule made checkable: every declared `ProviderId` is accounted
 * for, and the ones with no HTTP driver say *why* rather than being absent or stubbed into
 * something that looks like it works.
 */

const HTTP_PROVIDERS = [
  "anthropic-api",
  "openai-api",
  "openai-oauth",
  "openrouter",
  "zai",
  "kimi",
  "minimax",
  "gemini",
  "groq",
  "deepseek",
  "xai",
  "mistral",
  "together",
  "cerebras",
  "openai-compatible",
  "anthropic-compatible",
] as const

/** Every HTTP provider is a key except the ChatGPT/Codex subscription, which is a refreshed token. */
const OAUTH_PROVIDERS: readonly string[] = ["openai-oauth"]

describe("PROVIDER_REGISTRY", () => {
  test("every declared ProviderId has an entry", () => {
    for (const id of ProviderId.options) {
      expect(PROVIDER_REGISTRY[id]).toBeDefined()
    }
    expect(Object.keys(PROVIDER_REGISTRY).sort()).toEqual([...ProviderId.options].sort())
  })

  test("each HTTP driver is registered under its own id", () => {
    for (const id of HTTP_PROVIDERS) {
      const driver = httpDriver(id)

      expect(driver?.id).toBe(id)
      expect(driver?.authKind).toBe(OAUTH_PROVIDERS.includes(id) ? "oauth" : "api-key")
    }
  })

  test("HTTP_DRIVERS lists exactly the HTTP-served providers", () => {
    expect(HTTP_DRIVERS.map((driver) => driver.id).sort()).toEqual([...HTTP_PROVIDERS].sort())
  })

  test("Claude subscriptions are the Agent SDK's, and no driver here pretends otherwise", () => {
    const support = PROVIDER_REGISTRY["anthropic-oauth"]

    expect(support.transport).toBe("agent-sdk")
    expect(httpDriver("anthropic-oauth")).toBeNull()
  })

  test("a ChatGPT/Codex subscription is an ordinary HTTP driver, tokens and all", () => {
    const driver = httpDriver("openai-oauth")

    expect(driver?.authKind).toBe("oauth")
    expect(driver?.dialect).toBe("openai-responses")
    expect(driver?.resolveBaseUrl({ id: "a", provider: "openai-oauth" }).toString()).toBe(
      "https://chatgpt.com/backend-api/codex",
    )
  })

  test("no declared provider is left without an implementation", () => {
    // The `unimplemented` transport still exists — it is where an id declared in `packages/core`
    // ahead of its driver lands, and what lets the data plane refuse it by name. Nothing sits
    // there today, and this is the assertion that says so out loud rather than by omission.
    const undriven = ProviderId.options.filter(
      (id) => PROVIDER_REGISTRY[id].transport === "unimplemented",
    )

    expect(undriven).toEqual([])
  })

  test("gemini is reached on Google's OpenAI-compatibility surface, not the native protocol", () => {
    const driver = httpDriver("gemini")

    expect(driver?.dialect).toBe("openai-chat")
    expect(driver?.authKind).toBe("api-key")
    expect(driver?.resolveBaseUrl({ id: "g", provider: "gemini" }).toString()).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai",
    )
  })

  test("the six OpenAI-shaped vendors are one pinned surface each, and a key apiece", () => {
    // They exist as ids rather than as `openai-compatible` accounts precisely because an id is what
    // carries the endpoint and the credit-exhaustion rules. If one of them ever needed an operator
    // to supply a base URL, it would have earned nothing over the escape hatch.
    const vendors = ["groq", "deepseek", "xai", "mistral", "together", "cerebras"] as const

    for (const id of vendors) {
      const driver = httpDriver(id)

      expect(driver?.dialect).toBe("openai-chat")
      expect(driver?.authKind).toBe("api-key")
      expect(driver?.oauth).toBeUndefined()
      expect(driver?.resolveBaseUrl({ id: "probe", provider: id }).protocol).toBe("https:")
    }
  })

  test("every registered driver declares a dialect the translation layer knows", () => {
    for (const driver of HTTP_DRIVERS) {
      expect(["anthropic", "openai-chat", "openai-responses"]).toContain(driver.dialect)
    }
  })
})
