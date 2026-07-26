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
  "ollama",
  "openai-compatible",
  "anthropic-compatible",
] as const

/** Every HTTP provider is a key except the ChatGPT/Codex subscription, which is a refreshed token. */
const OAUTH_PROVIDERS: readonly string[] = ["openai-oauth"]

/** …and the local endpoint, which authenticates nobody. */
const NO_AUTH_PROVIDERS: readonly string[] = ["ollama"]

function expectedAuthKind(id: string): string {
  if (OAUTH_PROVIDERS.includes(id)) return "oauth"
  return NO_AUTH_PROVIDERS.includes(id) ? "none" : "api-key"
}

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
      expect(driver?.authKind).toBe(expectedAuthKind(id))
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

  test("ollama is the local endpoint: no pinned address, and no credential demanded", () => {
    const driver = httpDriver("ollama")

    expect(driver?.dialect).toBe("openai-chat")
    // The whole point of the id. `api-key` here would put a required field in front of an operator
    // whose upstream has no key to give.
    expect(driver?.authKind).toBe("none")
    expect(driver?.oauth).toBeUndefined()
    expect(() => driver?.resolveBaseUrl({ id: "probe", provider: "ollama" })).toThrow()
  })

  test("no other provider authenticates with nothing", () => {
    // `none` is a licence to address an upstream anonymously. It stays deliberate and narrow.
    const anonymous = HTTP_DRIVERS.filter((driver) => driver.authKind === "none").map(
      (driver) => driver.id,
    )

    expect(anonymous).toEqual(["ollama"])
  })

  test("every registered driver declares a dialect the translation layer knows", () => {
    for (const driver of HTTP_DRIVERS) {
      expect(["anthropic", "openai-chat", "openai-responses"]).toContain(driver.dialect)
    }
  })
})

/**
 * `max_tokens` and `max_completion_tokens` are two names for one openai-chat field, and no upstream
 * takes both. Which one a provider states is declared in its driver and asserted here, because
 * guessing it wrong is invisible in one direction — a vendor that never heard of the new name
 * ignores it and generates to its own default, dropping the ceiling the caller set.
 */
describe("the openai-chat output ceiling", () => {
  /** OpenAI deprecated `max_tokens` and its reasoning models refuse it outright. Nobody else has. */
  const NEW_NAME: readonly string[] = ["openai-api"]

  test("only OpenAI's own platform states max_completion_tokens", () => {
    const renamed = HTTP_DRIVERS.filter(
      (driver) =>
        driver.resolveChatCeiling({ id: "probe", provider: driver.id, dialect: "openai-chat" }) ===
        "max_completion_tokens",
    ).map((driver) => driver.id)

    expect(renamed).toEqual([...NEW_NAME])
  })

  test("every other driver states max_tokens, the name every compatible vendor knows", () => {
    for (const driver of HTTP_DRIVERS) {
      if (NEW_NAME.includes(driver.id)) continue
      const account = { id: "probe", provider: driver.id, dialect: driver.dialect }

      expect(driver.resolveChatCeiling(account)).toBe("max_tokens")
    }
  })

  test("it is a fact about the surface: openai-api's Responses surface states nothing new", () => {
    const driver = httpDriver("openai-api")
    const account = { id: "probe", provider: "openai-api" } as const

    expect(driver?.resolveChatCeiling({ ...account, dialect: "openai-chat" })).toBe(
      "max_completion_tokens",
    )
    expect(driver?.resolveChatCeiling({ ...account, dialect: "openai-responses" })).toBe(
      "max_tokens",
    )
  })
})
