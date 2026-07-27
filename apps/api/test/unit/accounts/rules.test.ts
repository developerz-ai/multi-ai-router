import { describe, expect, test } from "bun:test"
import { ProviderId } from "@multi-ai-router/core"
import {
  type AccountShape,
  checkAccountShape,
  describeProvider,
  resolveBilling,
} from "../../../src/services/accounts"

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

describe("billing", () => {
  test("a metered provider takes either answer, because only the operator knows which was bought", () => {
    // The whole reason this is an account property. z.ai, Kimi and MiniMax each sell a flat-fee
    // coding plan behind the same endpoint and the same key shape as their metered API, and no
    // request the router can make tells them apart.
    for (const provider of ["zai", "kimi", "minimax"] as const) {
      expect(checkAccountShape(shape({ provider, billing: "metered" })).ok).toBe(true)
      expect(checkAccountShape(shape({ provider, billing: "subscription" })).ok).toBe(true)
    }
  })

  test("a subscription-only provider refuses to be called metered", () => {
    // There is no per-token price behind a Claude Max or ChatGPT plan, so `metered` would put an
    // invented charge in a spend column rather than record one.
    const result = checkAccountShape(
      shape({
        provider: "anthropic-oauth",
        hasCredential: false,
        configDir: "/data/claude/seb",
        billing: "metered",
      }),
    )
    expect(result.ok).toBe(false)
    expect(reason(result)).toStartWith("billing_fixed:")
    expect(reason(result)).toContain("subscription")
  })

  test("agreeing with a subscription-only provider is accepted, not refused for redundancy", () => {
    expect(
      checkAccountShape(
        shape({
          provider: "anthropic-oauth",
          hasCredential: false,
          configDir: "/data/claude/seb",
          billing: "subscription",
        }),
      ).ok,
    ).toBe(true)
  })

  test("saying nothing is always accepted — the provider's default answers", () => {
    for (const id of ProviderId.options) {
      const result = checkAccountShape(shape({ provider: id, billing: undefined }))
      if (!result.ok) expect(result.failure.code).not.toBe("billing_fixed")
    }
  })
})

describe("resolving what an account is billed as", () => {
  const describeOf = (id: ProviderId) => describeProvider(id)

  test("a metered provider takes the operator's answer", () => {
    expect(resolveBilling(describeOf("zai"), "subscription")).toBe("subscription")
    expect(resolveBilling(describeOf("zai"), "metered")).toBe("metered")
  })

  test("silence takes the provider's default rather than the column's", () => {
    // Written explicitly on every create: the column default is right for a metered provider and
    // wrong for a subscription-only one, and which of those this is comes off the driver.
    expect(resolveBilling(describeOf("zai"), undefined)).toBe("metered")
    expect(resolveBilling(describeOf("anthropic-oauth"), undefined)).toBe("subscription")
    expect(resolveBilling(describeOf("openai-oauth"), undefined)).toBe("subscription")
  })

  test("a subscription-only provider is its own answer, whatever was asked for", () => {
    // Belt and braces with `checkAccountShape`, which refuses the contradiction first. This is what
    // makes a caller that skipped the check still unable to write a metered Claude subscription.
    expect(resolveBilling(describeOf("anthropic-oauth"), "metered")).toBe("subscription")
    expect(resolveBilling(describeOf("openai-oauth"), "metered")).toBe("subscription")
  })

  test("exactly the two providers sold only as a plan are fixed there", () => {
    // A provider that grows a flat-fee plan alongside its API must not become fixed by accident:
    // fixed means "the operator cannot say otherwise", which is only true with no per-token price.
    const fixed = ProviderId.options.filter((id) => describeProvider(id).billingFixed)
    expect(fixed.sort()).toEqual(["anthropic-oauth", "openai-oauth"])
    for (const id of fixed) expect(describeProvider(id).defaultBilling).toBe("subscription")
  })

  test("every other provider defaults to metered", () => {
    for (const id of ProviderId.options) {
      const provider = describeProvider(id)
      if (provider.billingFixed) continue
      expect(provider.defaultBilling).toBe("metered")
    }
  })
})
