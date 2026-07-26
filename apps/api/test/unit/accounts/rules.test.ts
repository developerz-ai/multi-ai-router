import { describe, expect, test } from "bun:test"
import { ProviderId } from "@multi-ai-router/core"
import { type AccountShape, checkAccountShape } from "../../../src/services/accounts"

/**
 * Write-time validation of an account's shape. Each rejection here is a failure
 * that would otherwise land on somebody's request hours later, as a routing
 * error with no hint of what was misconfigured.
 */

function shape(overrides: Partial<AccountShape> = {}): AccountShape {
  return {
    provider: "openrouter",
    hasCredential: true,
    configDir: null,
    baseUrl: null,
    dialect: null,
    ...overrides,
  }
}

function reason(result: ReturnType<typeof checkAccountShape>): string {
  return result.ok ? "accepted" : `${result.failure.code}: ${result.failure.message}`
}

describe("provider implementation", () => {
  test("a well-formed HTTP account is accepted", () => {
    expect(checkAccountShape(shape()).ok).toBe(true)
  })

  test("every declared provider can back an account — none is refused as unimplemented", () => {
    // The `provider_unimplemented` rule stays: it is what an id declared ahead of its driver hits.
    // Nothing hits it today, and asserting that is how the claim stays honest.
    for (const provider of ProviderId.options) {
      const result = checkAccountShape(shape({ provider, configDir: null }))
      expect(reason(result)).not.toStartWith("provider_unimplemented:")
    }
  })

  test("a gemini account needs nothing but its key", () => {
    expect(checkAccountShape(shape({ provider: "gemini" })).ok).toBe(true)
  })
})

describe("base URL", () => {
  test("a *-compatible provider without one is rejected — it has no address at all", () => {
    const result = checkAccountShape(shape({ provider: "openai-compatible" }))
    expect(result.ok).toBe(false)
    expect(reason(result)).toStartWith("base_url_required:")
  })

  test("the same provider with an operator-supplied endpoint is accepted", () => {
    const result = checkAccountShape(
      shape({ provider: "openai-compatible", baseUrl: "http://vllm.internal:8000/v1" }),
    )
    expect(result.ok).toBe(true)
  })

  test("a provider with a pinned endpoint needs nothing", () => {
    expect(checkAccountShape(shape({ provider: "anthropic-api" })).ok).toBe(true)
  })
})

describe("credentials versus config dirs", () => {
  test("an HTTP account with no credential is rejected", () => {
    const result = checkAccountShape(shape({ hasCredential: false }))
    expect(reason(result)).toStartWith("credential_required:")
  })

  test("a local endpoint may be created with no credential at all", () => {
    const result = checkAccountShape(
      shape({
        provider: "ollama",
        hasCredential: false,
        baseUrl: "http://ollama.internal:11434/v1",
      }),
    )

    expect(result.ok).toBe(true)
  })

  test("it accepts one anyway — the same endpoint behind a proxy takes a key", () => {
    const result = checkAccountShape(
      shape({
        provider: "ollama",
        hasCredential: true,
        baseUrl: "http://ollama.internal:11434/v1",
      }),
    )

    expect(result.ok).toBe(true)
  })

  test("its address is still required: no credential is not no configuration", () => {
    const result = checkAccountShape(shape({ provider: "ollama", hasCredential: false }))

    expect(reason(result)).toStartWith("base_url_required:")
  })

  test("the providers that may exist empty are exactly the three with a reason to", () => {
    // A subscription the SDK owns the credentials for, an account a login will fill in, and an
    // upstream that authenticates nobody. Any fourth id here would be an account quietly addressing
    // a paid upstream with no key, so the set is asserted whole rather than sampled.
    const mayBeEmpty = ProviderId.options.filter(
      (provider) =>
        checkAccountShape(
          shape({
            provider,
            hasCredential: false,
            baseUrl: "https://upstream.test/v1",
            configDir: provider === "anthropic-oauth" ? "/data/claude/seb" : null,
          }),
        ).ok,
    )

    expect(mayBeEmpty).toEqual(["anthropic-oauth", "openai-oauth", "ollama"])
  })

  test("a Claude subscription must never be handed a router-held credential", () => {
    const result = checkAccountShape(
      shape({ provider: "anthropic-oauth", hasCredential: true, configDir: "/data/claude/seb" }),
    )
    expect(result.ok).toBe(false)
    expect(reason(result)).toStartWith("credential_not_accepted:")
    expect(reason(result)).toContain("CLAUDE_CONFIG_DIR")
  })

  test("a Claude subscription needs its own config dir", () => {
    const result = checkAccountShape(shape({ provider: "anthropic-oauth", hasCredential: false }))
    expect(reason(result)).toStartWith("config_dir_required:")
  })

  test("a Claude subscription with a config dir and no credential is accepted", () => {
    const result = checkAccountShape(
      shape({ provider: "anthropic-oauth", hasCredential: false, configDir: "/data/claude/seb" }),
    )
    expect(result.ok).toBe(true)
  })

  test("an HTTP account has no business owning a config dir", () => {
    const result = checkAccountShape(shape({ configDir: "/data/claude/seb" }))
    expect(reason(result)).toStartWith("config_dir_not_accepted:")
  })
})

describe("dialect", () => {
  test("a surface the provider does not serve is rejected rather than silently ignored", () => {
    const result = checkAccountShape(shape({ provider: "kimi", dialect: "openai-responses" }))
    expect(result.ok).toBe(false)
    expect(reason(result)).toStartWith("dialect_unsupported:")
  })

  test("either of z.ai's two surfaces is accepted", () => {
    expect(checkAccountShape(shape({ provider: "zai", dialect: "anthropic" })).ok).toBe(true)
    expect(checkAccountShape(shape({ provider: "zai", dialect: "openai-chat" })).ok).toBe(true)
  })
})
