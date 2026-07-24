import { describe, expect, test } from "bun:test"
import { NoHealthyAccountError, type ProviderId } from "@multi-ai-router/core"
import { httpDriver } from "../../../src/providers"
import { account } from "./fixtures"

/** The pinned defaults from docs/idea/03-providers.md, asserted verbatim. */
const PINNED: ReadonlyArray<readonly [ProviderId, string]> = [
  ["anthropic-api", "https://api.anthropic.com/"],
  ["openai-api", "https://api.openai.com/v1"],
  ["openrouter", "https://openrouter.ai/api/v1"],
  ["zai", "https://api.z.ai/api/anthropic"],
  ["kimi", "https://api.kimi.com/coding"],
  ["minimax", "https://api.minimax.io/anthropic"],
]

describe("resolveBaseUrl", () => {
  for (const [id, expected] of PINNED) {
    test(`${id} defaults to ${expected}`, () => {
      const url = httpDriver(id)?.resolveBaseUrl(account({ provider: id }))

      expect(url?.toString()).toBe(expected)
    })
  }

  test("an Account override wins over the pinned default", () => {
    const url = httpDriver("anthropic-api")?.resolveBaseUrl(
      account({ provider: "anthropic-api", baseUrl: "https://gateway.internal/anthropic" }),
    )

    expect(url?.toString()).toBe("https://gateway.internal/anthropic")
  })

  test("the escape hatches have no default and fail naming the Account", () => {
    const subject = account({ provider: "openai-compatible" })

    expect(() => httpDriver("openai-compatible")?.resolveBaseUrl(subject)).toThrow(
      NoHealthyAccountError,
    )
  })

  test("the escape hatches work on the operator's URL alone", () => {
    const url = httpDriver("anthropic-compatible")?.resolveBaseUrl(
      account({ provider: "anthropic-compatible", baseUrl: "http://localhost:11434/v1" }),
    )

    expect(url?.toString()).toBe("http://localhost:11434/v1")
  })

  test("an unusable override fails as an unroutable Account, not a raw throw", () => {
    const subject = account({ provider: "openai-api", baseUrl: "not a url" })
    let caught: unknown

    try {
      httpDriver("openai-api")?.resolveBaseUrl(subject)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(NoHealthyAccountError)
    expect((caught as NoHealthyAccountError).status).toBe(503)
  })
})

describe("surfaces", () => {
  test("z.ai's Anthropic surface is the default", () => {
    const driver = httpDriver("zai")
    const subject = account({ provider: "zai" })

    expect(driver?.resolveDialect(subject)).toBe("anthropic")
    expect(driver?.resolveBaseUrl(subject).toString()).toBe("https://api.z.ai/api/anthropic")
  })

  test("an Account choosing z.ai's OpenAI surface moves both the URL and the dialect", () => {
    const driver = httpDriver("zai")
    const subject = account({ provider: "zai", dialect: "openai-chat" })

    expect(driver?.resolveDialect(subject)).toBe("openai-chat")
    expect(driver?.resolveBaseUrl(subject).toString()).toBe("https://api.z.ai/api/coding/paas/v4")
  })

  test("a dialect the provider does not offer falls back to its default surface", () => {
    const driver = httpDriver("kimi")
    const subject = account({ provider: "kimi", dialect: "openai-responses" })

    expect(driver?.resolveDialect(subject)).toBe("anthropic")
  })

  test("openai-api offers both OpenAI surfaces on one base URL", () => {
    const driver = httpDriver("openai-api")

    expect(driver?.resolveDialect(account({ provider: "openai-api" }))).toBe("openai-chat")
    expect(
      driver?.resolveDialect(account({ provider: "openai-api", dialect: "openai-responses" })),
    ).toBe("openai-responses")
  })
})
