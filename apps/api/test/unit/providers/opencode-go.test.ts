import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { account, response } from "./fixtures"

/**
 * Every body below is what the real endpoint answered on 2026-11-06, with the key removed. The
 * endpoint refuses any request that does not name its conversation, on every surface, so the header
 * declaration is the difference between this provider working and not.
 */

const KEY = { kind: "api-key", apiKey: "oc_sk_test" } as const

function driver() {
  const found = httpDriver("opencode-go")
  if (found === null) throw new Error("opencode-go has no HTTP driver")
  return found
}

function go(dialect?: "openai-chat" | "anthropic" | "openai-responses") {
  return account({ provider: "opencode-go", ...(dialect === undefined ? {} : { dialect }) })
}

describe("opencode-go surfaces", () => {
  test("is a key on a flat-fee plan, with no login to drive", () => {
    expect(driver().authKind).toBe("api-key")
    expect(driver().billing).toBe("subscription")
    expect(driver().oauth).toBeUndefined()
  })

  test("each surface is pinned to its own path", () => {
    const base = (dialect: "openai-chat" | "anthropic" | "openai-responses") =>
      driver().resolveBaseUrl(go(dialect)).toString()

    expect(base("openai-chat")).toBe("https://opencode.ai/inference/go/openai/v1")
    expect(base("openai-responses")).toBe("https://opencode.ai/inference/go/openai/v1")
    expect(base("anthropic")).toBe("https://opencode.ai/inference/go/anthropic")
  })

  for (const dialect of ["openai-chat", "anthropic", "openai-responses"] as const) {
    test(`${dialect} requires the conversation named`, () => {
      expect(driver().sessionHeader?.(go(dialect))).toBe("x-opencode-session")
    })

    test(`${dialect} says who is calling, under our own name`, () => {
      const headers = driver().buildHeaders(go(dialect), KEY)

      expect(headers.get("user-agent")).toBe("developerz.ai")
      expect(headers.get("authorization")).toBe("Bearer oc_sk_test")
      expect(headers.has("x-api-key")).toBe(false)
    })
  }

  test("no other HTTP provider names a conversation in a header", () => {
    const others = ["openai-api", "zai", "cerebras", "openai-compatible"] as const
    for (const provider of others) {
      expect(httpDriver(provider)?.sessionHeader?.(account({ provider }))).toBeUndefined()
    }
  })
})

describe("opencode-go failures, as the endpoint words them", () => {
  test("a dead balance is exhausted, never a clock", () => {
    const failure = driver().classifyFailure(
      response(402, {
        body: { error: { type: "invalid_request_error", message: "Insufficient account funds" } },
      }),
    )

    expect(failure?.kind).toBe("credits-exhausted")
    expect(failure?.signal).toBe("opencode-go:insufficient-funds")
  })

  test("a free-usage limit is rate-limited and keeps the stated Retry-After", () => {
    const failure = driver().classifyFailure(
      response(429, {
        headers: { "retry-after": "33947" },
        body: {
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
        },
      }),
    )

    expect(failure?.kind).toBe("rate-limited")
    expect(failure?.signal).toBe("opencode-go:free-usage-limit")
    expect(failure?.rateLimit?.retryAfterSeconds).toBe(33947)
  })

  test("a service-account key is refused as a credential, not retried as a limit", () => {
    const failure = driver().classifyFailure(
      response(403, {
        body: {
          error: {
            type: "permission_error",
            message:
              "Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models.",
          },
        },
      }),
    )

    expect(failure?.kind).toBe("auth")
  })

  for (const body of [
    { error: { type: "server_error", message: "Upstream request failed: Model is unavailable." } },
    {
      type: "error",
      error: { type: "api_error", message: "Upstream request failed: Model is unavailable." },
    },
  ]) {
    test(`a name the plan does not serve is the model's fault, not the account's (${JSON.stringify(body).length})`, () => {
      const failure = driver().classifyFailure(response(400, { body }))

      expect(failure?.kind).toBe("model-unsupported")
      expect(failure?.retryable).toBe(true)
    })
  }
})

describe("opencode-go model listing", () => {
  const read = (body: unknown) => driver().modelListing?.read(body)

  test("reads context and output sizes from the catalog's `limit`", () => {
    const body = {
      object: "list",
      data: [
        {
          id: "deepseek-v4.1-flash",
          capabilities: { reasoning: { supported: true, effort: ["low", "high", "max"] } },
          limit: { context: 1000000, output: 384000 },
        },
      ],
    }

    expect(read(body)).toEqual([
      { id: "deepseek-v4.1-flash", contextTokens: 1000000, maxOutputTokens: 384000 },
    ])
  })

  test("a row with no sizes still lists, and sizes it cannot read stay unknown", () => {
    expect(read({ data: [{ id: "a" }, { id: "b", limit: { context: "big" } }] })).toEqual([
      { id: "a", contextTokens: null, maxOutputTokens: null },
      { id: "b", contextTokens: null, maxOutputTokens: null },
    ])
  })

  test("a reshaped answer is refused whole, never half a list", () => {
    expect(read({ models: [] })).toBeNull()
  })
})
