import { describe, expect, test } from "bun:test"
import { HTTP_DRIVERS, httpDriver } from "../../../src/providers"
import { inModelFamily } from "../../../src/services/routing/model-family"
import { account, response } from "./fixtures"

/** Bodies below are the ones each upstream answered, 2026-11-23, unless a source is named. */

const kilo = httpDriver("kilo")
const nvidia = httpDriver("nvidia")

describe("kilo", () => {
  test("a paid id on a keyless account is about the model, never the credential", () => {
    // Read as `auth` this parks a keyless account in "credential rejected" over one client's typo.
    const result = kilo?.classifyFailure(
      response(401, {
        body: {
          error: {
            code: "PAID_MODEL_AUTH_REQUIRED",
            message: "You need to sign in to use this model.",
          },
          error_type: "paid_model_auth_required",
        },
      }),
    )

    expect(result?.kind).toBe("model-unsupported")
    expect(result?.retryable).toBe(true)
  })

  test("a key Kilo no longer knows is the credential", () => {
    const result = kilo?.classifyFailure(
      response(401, {
        body: {
          error: { code: "INVALID_TOKEN", message: "Your authentication token is invalid." },
          error_type: "authentication_required",
        },
      }),
    )

    expect(result?.kind).toBe("auth")
  })

  test("a retired id lets the next account have its turn", () => {
    // Kilo-Org/cloud llm-proxy-helpers.ts: `error` is a string, the vocabulary sits beside it.
    const result = kilo?.classifyFailure(
      response(404, {
        body: {
          error: "Model not found",
          error_type: "model_not_found",
          message: "The requested model could not be found.",
        },
      }),
    )

    expect(result?.kind).toBe("model-unsupported")
    expect(result?.signal).toBe("kilo:model-refused")
  })

  test("one model's upstream throttle holds that model only", () => {
    const result = kilo?.classifyFailure(
      response(429, {
        body: {
          error: {
            message: "Provider returned error",
            code: 429,
            metadata: { raw: "particle-ai/particle-1:free is temporarily rate-limited upstream." },
          },
        },
      }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.modelScoped).toBe(true)
  })

  test("the spent hourly allowance is the account's, with an estimated reset", () => {
    const result = kilo?.classifyFailure(
      response(429, {
        body: {
          error: {
            message: "Rate limit exceeded for free models. Please try again later.",
            code: 429,
          },
        },
      }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.modelScoped).toBeUndefined()
    expect(result?.rateLimit?.resetSource).toBe("estimated")
    expect(result?.rateLimit?.retryAfterSeconds).toBe(300)
  })

  test("an undeclared account is a candidate for free ids and nothing metered", () => {
    const serves = (model: string) =>
      kilo?.modelFamily !== undefined && inModelFamily(kilo.modelFamily, model)

    for (const id of [
      "nvidia/nemotron-3.5-super-vl:free",
      "reflection/beam-free",
      "kilo-auto/free",
      "openrouter/free",
    ]) {
      expect(serves(id), id).toBe(true)
    }
    for (const id of [
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash:floor",
      "gpt-6-sol",
      "claude-opus-5-5",
    ]) {
      expect(serves(id), id).toBe(false)
    }
  })

  test("no credential means no auth header, and a key is sent as a bearer", () => {
    const subject = account({ provider: "kilo" })

    expect(kilo?.buildHeaders(subject, null).get("authorization")).toBeNull()
    expect(kilo?.buildHeaders(subject, { kind: "api-key", apiKey: "k" }).get("authorization")).toBe(
      "Bearer k",
    )
  })

  test("the listing is the free text models, with their sizes", () => {
    const text = { architecture: { output_modalities: ["text"] } }
    const read = kilo?.modelListing?.read({
      data: [
        {
          id: "nvidia/nemotron-3.5-super-vl:free",
          isFree: true,
          context_length: 1_000_000,
          top_provider: { context_length: 1_000_000, max_completion_tokens: 131_072 },
          ...text,
        },
        { id: "stealth/glyph-cluster", isFree: true, context_length: 256_000, ...text },
        { id: "deepseek/deepseek-v4.1-flash", isFree: false, context_length: 1_048_576, ...text },
        {
          id: "google/lyria-3-pro-preview",
          isFree: true,
          architecture: { output_modalities: ["text", "audio"] },
        },
        { id: "unmarked/model", ...text },
      ],
    })

    expect(read).toEqual([
      {
        id: "nvidia/nemotron-3.5-super-vl:free",
        contextTokens: 1_000_000,
        maxOutputTokens: 131_072,
      },
      { id: "stealth/glyph-cluster", contextTokens: 256_000, maxOutputTokens: null },
    ])
    expect(kilo?.modelListing?.read({ models: [] })).toBeNull()
  })
})

describe("nvidia", () => {
  test("an id it does not host, or may not run for this key, or retired, is about the model", () => {
    for (const [status, body] of [
      [404, "404 page not found\n"],
      [404, { status: 404, title: "Not Found", detail: "Function 'x': Not found for account 'y'" }],
      [410, { status: 410, title: "Gone", detail: "The model has reached its end of life" }],
    ] as const) {
      expect(nvidia?.classifyFailure(response(status, { body }))?.kind).toBe("model-unsupported")
    }
  })

  test("a rejected key is the credential, and its problem detail is the message", () => {
    const result = nvidia?.classifyFailure(
      response(403, { body: { status: 403, title: "Forbidden", detail: "Authorization failed" } }),
    )

    expect(result?.kind).toBe("auth")
    expect(result?.message).toBe("Authorization failed")
  })

  test("a 429 holds its model and never reads as a dead balance", () => {
    const result = nvidia?.classifyFailure(
      response(429, {
        body: { status: 429, title: "Too Many Requests", detail: "quota exceeded" },
      }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(nvidia?.rateLimitsPerModel?.("z-ai/glm-5.3-flash")).toBe(true)
  })

  test("only namespaced, unsuffixed ids are its own", () => {
    const family = nvidia?.modelFamily
    if (family === undefined) throw new Error("nvidia declares no family")

    expect(inModelFamily(family, "z-ai/glm-5.3-flash")).toBe(true)
    expect(inModelFamily(family, "nvidia/nemotron-3.5-super-vl:free")).toBe(false)
    expect(inModelFamily(family, "gpt-6-sol")).toBe(false)
  })
})

test("every free tier is dated and links to the vendor", () => {
  const stated = HTTP_DRIVERS.filter((driver) => driver.freeTier !== undefined)

  expect(stated.map((driver) => driver.id).sort()).toEqual(["kilo", "nvidia", "openrouter"])
  for (const { freeTier } of stated) {
    expect(freeTier?.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(freeTier?.url.startsWith("https://")).toBe(true)
  }
})
