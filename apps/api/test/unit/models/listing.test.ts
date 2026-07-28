import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { listUpstreamModels } from "../../../src/services/models"

/**
 * Reading a provider's model listing — the one call the operator's discover button and the hourly
 * sweep now share.
 *
 * Its job is to survive the fact that no two vendors spell a context window the same way, and to
 * be honest about the far more common case: **most listings state no size at all.** That was
 * verified against the live endpoints rather than assumed — z.ai, MiniMax, OpenAI and Anthropic
 * answer with an id, an object type and an owner. The vendors that do state one each pick a
 * different field name, which is why the parser reads a union and not one key.
 */

const NOW = new Date("2026-07-28T12:00:00.000Z")

function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acc-1",
    label: "acc-1",
    provider: "zai",
    status: "active",
    authMaterial: "plaintext-key",
    configDir: null,
    tokenExpiresAt: null,
    lastUsedAt: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    billing: "metered",
    weight: 100,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as AccountRow
}

function answering(body: unknown, status = 200) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
}

const deps = (fetch: () => Promise<Response>) => ({
  cipher: { decrypt: (envelope: string) => envelope },
  timeoutMs: 5_000,
  fetch,
})

async function entries(body: unknown, account = accountRow()) {
  const result = await listUpstreamModels(deps(answering(body)), account)
  if (!result.ok) throw new Error(`expected a listing, got ${result.code}: ${result.message}`)
  return result.entries
}

describe("reading a provider's model listing", () => {
  test("the ordinary case: an id and nothing else, which is what most vendors send", async () => {
    // Verbatim shape of z.ai's live answer.
    const listed = await entries({
      object: "list",
      data: [
        { id: "glm-4.6", object: "model", created: 1_759_276_800, owned_by: "z-ai" },
        { id: "glm-5.2", object: "model", created: 1_781_625_600, owned_by: "z-ai" },
      ],
    })

    expect(listed).toEqual([
      { id: "glm-4.6", contextTokens: null, maxOutputTokens: null },
      { id: "glm-5.2", contextTokens: null, maxOutputTokens: null },
    ])
  })

  test("every spelling a vendor uses for a context window is read", async () => {
    const listed = await entries({
      data: [
        { id: "aggregator", context_length: 1_000_000 },
        { id: "groq-style", context_window: 131_072 },
        { id: "mistral-style", max_context_length: 262_144 },
        { id: "google-style", inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 },
      ],
    })

    // Sorted by id: aggregator, google-style, groq-style, mistral-style.
    expect(listed.map((entry) => entry.contextTokens)).toEqual([
      1_000_000, 1_048_576, 131_072, 262_144,
    ])
    // Google's camelCase output ceiling came through beside its camelCase window.
    expect(listed[1]?.maxOutputTokens).toBe(65_536)
  })

  test("an aggregator's per-endpoint block beats its model-wide number", async () => {
    const [entry] = await entries({
      data: [
        {
          id: "some/model",
          context_length: 1_000_000,
          top_provider: { context_length: 200_000, max_completion_tokens: 32_768 },
        },
      ],
    })

    // The endpoint block describes what an account pointed at *that* provider actually gets.
    expect(entry).toEqual({ id: "some/model", contextTokens: 200_000, maxOutputTokens: 32_768 })
  })

  /**
   * A silently coerced `"128000"` would be indistinguishable from a number the provider sent, and
   * a window of zero is not a window. Both read as "this provider did not state a size".
   */
  test("a size that is not a positive integer is no size at all", async () => {
    const listed = await entries({
      data: [
        { id: "a", context_length: "128000" },
        { id: "b", context_length: 0 },
        { id: "c", context_length: -1 },
        { id: "d", context_length: 1.5 },
        { id: "e", context_length: null },
      ],
    })

    expect(listed.every((entry) => entry.contextTokens === null)).toBe(true)
  })

  test("one malformed row does not cost the whole listing", async () => {
    const listed = await entries({
      data: [{ id: "good" }, { id: 42 }, { id: "  " }, { object: "model" }, { id: "  spaced  " }],
    })

    expect(listed.map((entry) => entry.id)).toEqual(["good", "spaced"])
  })

  test("a model listed twice is one model, and the first answer stands", async () => {
    const listed = await entries({
      data: [
        { id: "dup", context_length: 100 },
        { id: "dup", context_length: 200 },
      ],
    })

    expect(listed).toEqual([{ id: "dup", contextTokens: 100, maxOutputTokens: null }])
  })

  test("an unreadable body is reported as such rather than as an empty catalog", async () => {
    const result = await listUpstreamModels(
      deps(answering({ models: ["not-the-documented-shape"] })),
      accountRow(),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("discovery_unreadable")
  })

  test("an upstream failure keeps its classification instead of becoming 'no models'", async () => {
    const result = await listUpstreamModels(
      deps(answering({ error: { message: "nope" } }, 401)),
      accountRow(),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("discovery_failed")
  })

  test("a provider with no HTTP driver is refused before any socket opens", async () => {
    let called = false
    const result = await listUpstreamModels(
      deps(async () => {
        called = true
        return new Response("{}")
      }),
      accountRow({ provider: "anthropic-oauth" }),
    )

    expect(called).toBe(false)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("provider_unavailable")
  })

  test("an endpoint the operator never supplied is named, not guessed at", async () => {
    const result = await listUpstreamModels(
      deps(answering({ data: [] })),
      accountRow({ provider: "openai-compatible", baseUrl: null }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("endpoint_unresolved")
  })
})
