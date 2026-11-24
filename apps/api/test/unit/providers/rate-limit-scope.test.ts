import { describe, expect, test } from "bun:test"
import { accountLevelReading, httpDriver, type RateLimitSignal } from "../../../src/providers"

const limited: RateLimitSignal = {
  limited: true,
  retryAfterSeconds: 60,
  resetSource: "provider-reported",
  windows: [
    { limiter: "requests", remaining: 0, utilizationSource: "none", resetSource: "unknown" },
  ],
}

function source(
  provider: "nvidia" | "gemini" | "openrouter" | "kilo" | "groq" | "deepseek",
  upstreamModel: string,
) {
  const driver = httpDriver(provider)
  if (driver === null) throw new Error(`no driver for ${provider}`)
  return { driver, upstreamModel }
}

describe("accountLevelReading", () => {
  test("a model's own limit cools no account, and its windows still show", () => {
    for (const from of [
      source("nvidia", "z-ai/glm-5.3-flash"),
      source("gemini", "gemini-3.8-flash"),
      source("groq", "openai/gpt-oss-120b"),
      source("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free"),
    ])
      expect(accountLevelReading(limited, from)).toEqual({ ...limited, limited: false })
  })

  test("a refusal classified model-scoped is the model's on any driver", () => {
    const from = { ...source("kilo", "m"), classification: { modelScoped: true } }
    expect(accountLevelReading(limited, from)?.limited).toBe(false)
  })

  test("a refusal that is not about the account cools nothing", () => {
    for (const kind of [
      "overloaded",
      "model-unsupported",
      "invalid-request",
      "stale-session",
      "busy-session",
    ] as const)
      expect(
        accountLevelReading(limited, { ...source("kilo", "m"), classification: { kind } }),
      ).toEqual({ ...limited, limited: false })
    const gated = { kind: "rate-limited", requestAttributable: true } as const
    expect(
      accountLevelReading(limited, { ...source("kilo", "m"), classification: gated })?.limited,
    ).toBe(false)
  })

  test("a refusal that is the account's keeps its reading", () => {
    for (const kind of [
      "rate-limited",
      "credits-exhausted",
      "auth",
      "server-error",
      "unknown",
    ] as const)
      expect(
        accountLevelReading(limited, { ...source("kilo", "m"), classification: { kind } }),
      ).toBe(limited)
  })

  // `429`s whose body says whose fault it is; the header parser reads only the status.
  test.each([
    ["zai", "1305", "The service may be temporarily overloaded, please try again later"],
    ["zai", "1311", "Your current subscription plan does not yet include access to GLM-5.2"],
    ["zai", "1211", "Unknown Model, please check the model code."],
  ] as const)("%s %s on a 429 is not the account's limit", (provider, code, message) => {
    const driver = httpDriver(provider)
    if (driver === null) throw new Error(`no driver for ${provider}`)
    const body = { error: { code, message } }
    const classification = driver.classifyFailure({
      status: 429,
      headers: new Headers(),
      body,
    })
    const reading = driver.parseRateLimit({ status: 429, headers: new Headers() })
    expect(reading?.limited).toBe(true)
    expect(
      accountLevelReading(reading, { driver, upstreamModel: "glm-5.2", classification })?.limited,
    ).toBe(false)
  })

  test("everything else is the account's, untouched", () => {
    expect(accountLevelReading(limited, source("deepseek", "m"))).toBe(limited)
    expect(accountLevelReading(limited, source("openrouter", "a/paid"))).toBe(limited)
    expect(accountLevelReading(limited, { ...source("kilo", "m"), classification: null })).toBe(
      limited,
    )
    expect(accountLevelReading(null, source("nvidia", "a/b"))).toBeNull()
  })
})
