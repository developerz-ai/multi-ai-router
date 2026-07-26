import { describe, expect, test } from "bun:test"
import { CredentialDecryptError, type ProviderId } from "@multi-ai-router/core"
import {
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_VERSION,
  httpDriver,
  type ProviderCredential,
} from "../../../src/providers"
import { account } from "./fixtures"

/**
 * Header construction is the detail providers punish hardest, and the Anthropic dialect has two
 * different contracts behind it:
 *
 * - **Anthropic's own API** — an API key on `x-api-key`; an OAuth token on `Authorization:
 *   Bearer` *plus* the `oauth-2025-04-20` beta. Neither form works in the other's clothes.
 * - **A compatible vendor** (z.ai, Kimi, MiniMax) — the key on `Authorization: Bearer`, verified
 *   from the operator's own `ANTHROPIC_AUTH_TOKEN` configuration. No `x-api-key`, and no OAuth
 *   beta: a vendor key is not an Anthropic subscription token and must not claim to be one.
 *
 * `anthropic-version: 2023-06-01` is on every Anthropic-dialect request either way.
 */

const API_KEY: ProviderCredential = { kind: "api-key", apiKey: "sk-test-key" }
const OAUTH: ProviderCredential = { kind: "oauth", accessToken: "oauth-access-token" }

function driverFor(id: ProviderId) {
  const driver = httpDriver(id)
  if (!driver) throw new Error(`no HTTP driver for ${id}`)
  return driver
}

function headersFor(id: ProviderId, credential: ProviderCredential, dialect?: "openai-chat") {
  return driverFor(id).buildHeaders(account({ provider: id, dialect }), credential)
}

/** Anthropic's own API, reached directly or through an operator's proxy. */
const ANTHROPIC_ENDPOINTS: readonly ProviderId[] = ["anthropic-api", "anthropic-compatible"]

/** Anthropic-shaped endpoints that belong to someone else. */
const VENDOR_ENDPOINTS: readonly ProviderId[] = ["zai", "kimi", "minimax"]

describe("Anthropic's own API", () => {
  for (const id of ANTHROPIC_ENDPOINTS) {
    test(`${id} sends an API key on x-api-key, with the version header and nothing else`, () => {
      const headers = headersFor(id, API_KEY)

      expect(headers.get("x-api-key")).toBe("sk-test-key")
      expect(headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION)
      expect(headers.get("anthropic-version")).toBe("2023-06-01")
      expect(headers.get("authorization")).toBeNull()
      expect(headers.get("anthropic-beta")).toBeNull()
    })

    test(`${id} sends an OAuth token on Authorization with the oauth beta, never x-api-key`, () => {
      const headers = headersFor(id, OAUTH)

      expect(headers.get("authorization")).toBe("Bearer oauth-access-token")
      expect(headers.get("anthropic-beta")).toBe(ANTHROPIC_OAUTH_BETA)
      expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20")
      expect(headers.get("anthropic-version")).toBe("2023-06-01")
      expect(headers.get("x-api-key")).toBeNull()
    })
  }
})

describe("compatible vendors on their Anthropic surfaces", () => {
  for (const id of VENDOR_ENDPOINTS) {
    test(`${id} sends the key as a Bearer token with the version header`, () => {
      const headers = headersFor(id, API_KEY)

      expect(headers.get("authorization")).toBe("Bearer sk-test-key")
      expect(headers.get("anthropic-version")).toBe("2023-06-01")
    })

    test(`${id} never sends x-api-key`, () => {
      expect(headersFor(id, API_KEY).get("x-api-key")).toBeNull()
      expect(headersFor(id, OAUTH).get("x-api-key")).toBeNull()
    })

    test(`${id} never attaches the Anthropic OAuth beta to a vendor key`, () => {
      expect(headersFor(id, API_KEY).get("anthropic-beta")).toBeNull()
      // Even a credential stored in the OAuth form: the beta belongs to Anthropic's own tokens.
      expect(headersFor(id, OAUTH).get("anthropic-beta")).toBeNull()
      expect(headersFor(id, OAUTH).get("authorization")).toBe("Bearer oauth-access-token")
    })

    test(`${id} sends exactly those two headers`, () => {
      expect([...headersFor(id, API_KEY).keys()].sort()).toEqual([
        "anthropic-version",
        "authorization",
      ])
    })
  }
})

describe("OpenAI-dialect drivers", () => {
  const openAiDialect: readonly ProviderId[] = [
    "openai-api",
    "openrouter",
    "gemini",
    "groq",
    "deepseek",
    "xai",
    "mistral",
    "together",
    "cerebras",
    "ollama",
    "openai-compatible",
  ]

  for (const id of openAiDialect) {
    test(`${id} authenticates with a Bearer token and no Anthropic headers`, () => {
      const headers = headersFor(id, API_KEY)

      expect(headers.get("authorization")).toBe("Bearer sk-test-key")
      expect(headers.get("x-api-key")).toBeNull()
      expect(headers.get("anthropic-version")).toBeNull()
      expect(headers.get("anthropic-beta")).toBeNull()
    })
  }

  test("an OAuth token uses the same Bearer header on the OpenAI dialect", () => {
    expect(headersFor("openai-api", OAUTH).get("authorization")).toBe("Bearer oauth-access-token")
  })
})

describe("z.ai picks its header form from the Account's surface", () => {
  test("the OpenAI surface drops the Anthropic version header", () => {
    const headers = headersFor("zai", API_KEY, "openai-chat")

    expect(headers.get("authorization")).toBe("Bearer sk-test-key")
    expect(headers.get("x-api-key")).toBeNull()
    expect(headers.get("anthropic-version")).toBeNull()
  })
})

describe("an upstream that authenticates nobody", () => {
  test("ollama with no credential sends no auth header at all", () => {
    const headers = driverFor("ollama").buildHeaders(account({ provider: "ollama" }), null)

    expect([...headers.keys()]).toEqual([])
  })

  test("ollama with one presents it, for the same endpoint behind a proxy", () => {
    expect(headersFor("ollama", API_KEY).get("authorization")).toBe("Bearer sk-test-key")
  })

  test("no other provider may be addressed anonymously — it fails loudly instead", () => {
    // The guard exists so a nullable credential can never quietly become a keyless call to a
    // provider that expects one. `authKind: "none"` is the whole permission.
    for (const id of ["anthropic-api", "openai-api", "openai-compatible"] as const) {
      expect(() => driverFor(id).buildHeaders(account({ provider: id }), null)).toThrow(
        CredentialDecryptError,
      )
    }
  })

  test("the refusal names the account and the provider, and no credential material", () => {
    let caught: unknown
    try {
      driverFor("anthropic-api").buildHeaders(account({ provider: "anthropic-api" }), null)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(CredentialDecryptError)
    expect((caught as CredentialDecryptError).message).toContain("anthropic-api")
    expect((caught as CredentialDecryptError).status).toBe(500)
  })
})

describe("credential material stays out of everything else", () => {
  test("buildHeaders does not mutate the Account", () => {
    const subject = account({ provider: "anthropic-api" })
    driverFor("anthropic-api").buildHeaders(subject, API_KEY)

    expect(JSON.stringify(subject)).not.toContain("sk-test-key")
  })
})
