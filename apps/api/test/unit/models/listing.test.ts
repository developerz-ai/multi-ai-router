import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { listUpstreamModels } from "../../../src/services/models"
import { accountRow as durableAccountRow } from "../../support/account-row"

/**
 * Reading a provider's model listing — the one call the operator's discover button and the hourly
 * sweep now share.
 *
 * Its job is to survive the fact that no two vendors spell a context window the same way, and to
 * be honest about the common case: **many listings state no size at all.** That was verified
 * against the live endpoints rather than assumed — z.ai, MiniMax and OpenAI answer with an id, an
 * object type and an owner. Anthropic's states `max_input_tokens` / `max_tokens`. The vendors that do state one each pick a
 * different field name, which is why the parser reads a union and not one key.
 */

const NOW = new Date("2026-07-28T12:00:00.000Z")

function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return durableAccountRow({
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
  })
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

  test("Anthropic's listing states both numbers as max_input_tokens and max_tokens", async () => {
    // Shape of `ModelInfo` in @anthropic-ai/sdk 0.131 (`resources/models.d.ts`): both fields are
    // always present and `number | null`.
    const listed = await entries(
      {
        data: [
          {
            type: "model",
            id: "claude-opus-5",
            display_name: "Claude Opus 5",
            created_at: "2026-05-01T00:00:00Z",
            capabilities: null,
            max_input_tokens: 1_000_000,
            max_tokens: 128_000,
          },
          {
            type: "model",
            id: "claude-unsized",
            display_name: "Unsized",
            created_at: "2026-05-01T00:00:00Z",
            capabilities: null,
            max_input_tokens: null,
            max_tokens: null,
          },
        ],
        has_more: false,
        first_id: "claude-opus-5",
        last_id: "claude-unsized",
      },
      accountRow({ provider: "anthropic-api" }),
    )

    expect(listed).toEqual([
      { id: "claude-opus-5", contextTokens: 1_000_000, maxOutputTokens: 128_000 },
      { id: "claude-unsized", contextTokens: null, maxOutputTokens: null },
    ])
  })

  test("vLLM's max_model_len is read as the window it is", async () => {
    // vLLM's OpenAI-compatible `ModelCard` — what an `openai-compatible` account usually fronts.
    const [entry] = await entries({
      object: "list",
      data: [{ id: "Qwen/Qwen3-32B", object: "model", owned_by: "vllm", max_model_len: 40_960 }],
    })

    expect(entry).toEqual({ id: "Qwen/Qwen3-32B", contextTokens: 40_960, maxOutputTokens: null })
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
    expect(result.status).toBe(401)
    expect(result.message).toContain("401")
  })

  test("a failure before any answer carries no status, rather than a made-up one", async () => {
    const result = await listUpstreamModels(
      deps(async () => {
        throw new TypeError("fetch failed")
      }),
      accountRow(),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("discovery_failed")
    expect(result.status).toBeUndefined()
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

/**
 * OpenCode Go, prod 2026-11-07: both seats serve on the anthropic surface, whose `/v1/models` names
 * ids only, so the catalog held 60 Go rows with no size and no `reasoning` — and `/v1/catalog`
 * stated neither for any Go model. The OpenAI listing states both. The fixture is that live reply
 * (2026-11-07), trimmed to five models and with `api`, `cost` and `modalities` dropped.
 */
const GO_OPENAI_LISTING = {
  object: "list",
  data: [
    {
      id: "deepseek-v4.1-flash",
      object: "model",
      created: 1794014354,
      owned_by: "opencode",
      name: "DeepSeek V4.1 Flash",
      canonical_id: "deepseek/deepseek-v4.1-flash",
      type: "chat",
      description: "DeepSeek V4.1 Flash model for reasoning and agentic coding",
      family: "deepseek-flash",
      open_weights: true,
      knowledge: "2025-05",
      release_date: "2026-09-10",
      last_updated: "2026-09-10",
      capabilities: {
        tools: {
          supported: true,
        },
        reasoning: {
          supported: true,
          effort: ["low", "high", "max"],
        },
        structured_output: true,
        temperature: true,
        top_p: true,
        top_k: true,
        system_updates: true,
        effort_updates: false,
      },
      limit: {
        context: 1000000,
        output: 384000,
      },
    },
    {
      id: "glm-5.3-flash",
      object: "model",
      created: 1794014354,
      owned_by: "opencode",
      name: "GLM-5.3-Flash",
      canonical_id: "zhipuai/glm-5.3-flash",
      type: "chat",
      description: "Native multimodal GLM model for efficient coding and long-horizon agent tasks",
      family: "glm-flash",
      open_weights: true,
      release_date: "2026-08-26",
      last_updated: "2026-08-26",
      capabilities: {
        tools: {
          supported: true,
        },
        reasoning: {
          supported: true,
          effort: ["low", "high", "max"],
        },
        structured_output: true,
        temperature: true,
        top_p: true,
        top_k: true,
        system_updates: true,
        effort_updates: false,
      },
      limit: {
        context: 1000000,
        output: 131072,
      },
    },
    {
      id: "gpt-6-luna",
      object: "model",
      created: 1794014354,
      owned_by: "opencode",
      name: "GPT-6 Luna",
      canonical_id: "openai/gpt-6-luna",
      type: "chat",
      description: "OpenAI's most efficient model for focused, high-volume tasks",
      family: "gpt-luna",
      open_weights: false,
      knowledge: "2026-05-18",
      release_date: "2026-09-22",
      last_updated: "2026-09-22",
      capabilities: {
        tools: {
          supported: true,
        },
        reasoning: {
          supported: true,
          effort: ["none", "low", "medium", "high", "xhigh", "max"],
        },
        structured_output: true,
        temperature: false,
        top_p: false,
        top_k: false,
        system_updates: true,
        effort_updates: true,
      },
      limit: {
        context: 1050000,
        input: 922000,
        output: 128000,
      },
    },
    {
      id: "minimax-m3.1-flash",
      object: "model",
      created: 1794014354,
      owned_by: "opencode",
      name: "MiniMax M3.1 Flash",
      canonical_id: "minimax/MiniMax-M3.1-Flash",
      type: "chat",
      description:
        "Frontier multimodal coding model with 1M context window and tunable thinking depth",
      family: "minimax",
      open_weights: true,
      release_date: "2026-10-19",
      last_updated: "2026-10-19",
      capabilities: {
        tools: {
          supported: true,
        },
        reasoning: {
          supported: true,
          effort: ["low", "medium", "high", "xhigh", "max"],
        },
        temperature: true,
        top_p: true,
        top_k: false,
        system_updates: true,
        effort_updates: false,
      },
      limit: {
        context: 1000000,
        output: 512000,
      },
    },
    {
      id: "qwen3.8-flash",
      object: "model",
      created: 1794014354,
      owned_by: "opencode",
      name: "Qwen3.8 Flash",
      canonical_id: "alibaba/qwen3.8-flash",
      type: "chat",
      description: "Qwen vision-language model for visual reasoning, documents, and agent tasks",
      family: "qwen",
      open_weights: false,
      release_date: "2026-08-26",
      last_updated: "2026-08-26",
      capabilities: {
        tools: {
          supported: true,
        },
        reasoning: {
          supported: true,
          toggle: true,
          effort: ["low", "medium", "xhigh"],
          budget: {},
        },
        structured_output: true,
        temperature: true,
        top_p: true,
        top_k: true,
        system_updates: true,
        effort_updates: false,
      },
      limit: {
        context: 1000000,
        output: 131072,
      },
    },
  ],
}

describe("opencode-go reads its listing off the OpenAI surface, whatever surface the seat serves", () => {
  for (const dialect of ["anthropic", "openai-chat", "openai-responses"] as const) {
    test(`a ${dialect} seat asks /openai/v1/models and keeps sizes and thinking modes`, async () => {
      const asked: string[] = []
      const result = await listUpstreamModels(
        deps(async (input?: unknown) => {
          asked.push(String(input instanceof Request ? input.url : input))
          return new Response(JSON.stringify(GO_OPENAI_LISTING), {
            headers: { "content-type": "application/json" },
          })
        }),
        accountRow({ provider: "opencode-go", dialect, billing: "subscription" }),
      )
      if (!result.ok) throw new Error(result.message)

      expect(asked[0]).toBe("https://opencode.ai/inference/go/openai/v1/models")
      const byId = new Map(result.entries.map((entry) => [entry.id, entry]))
      expect(byId.get("deepseek-v4.1-flash")).toEqual({
        id: "deepseek-v4.1-flash",
        contextTokens: 1_000_000,
        maxOutputTokens: 384_000,
        reasoning: { supported: true, effort: ["low", "high", "max"] },
      })
      expect(byId.get("glm-5.3-flash")?.contextTokens).toBe(1_000_000)
      expect(byId.get("gpt-6-luna")?.reasoning?.effort).toContain("none")
      expect(byId.get("qwen3.8-flash")?.reasoning).toEqual({
        supported: true,
        toggle: true,
        effort: ["low", "medium", "xhigh"],
      })
      for (const entry of result.entries) {
        expect(entry.contextTokens).not.toBeNull()
        expect(entry.reasoning?.supported).toBe(true)
      }
    })
  }
})

/**
 * Sweep 101, 04.6. A success body was read whole, bounded only by the attempt timeout: an
 * operator-typed base URL streaming hundreds of megabytes was buffered then parsed, hourly.
 */
describe("the listing body has a ceiling", () => {
  test("a body streaming past the ceiling is refused and the read cancelled", async () => {
    let pulled = 0
    let cancelled = false
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new TextEncoder().encode(`{"data":[${'{"id":"m"},'.repeat(100)}`))
      },
      cancel() {
        cancelled = true
      },
    })
    const result = await listUpstreamModels(
      { ...deps(async () => new Response(endless, { status: 200 })), maxResponseBytes: 4096 },
      accountRow(),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("discovery_unreadable")
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(10)
  })

  test("a declared length past the ceiling is refused before reading", async () => {
    const result = await listUpstreamModels(
      {
        ...deps(answering({ data: [{ id: "m" }], padding: "x".repeat(8192) })),
        maxResponseBytes: 1024,
      },
      accountRow(),
    )

    expect(result.ok).toBe(false)
  })

  test("has_more is carried as a truncated listing, not dropped", async () => {
    const result = await listUpstreamModels(
      deps(answering({ data: [{ id: "m" }], has_more: true })),
      accountRow({ provider: "anthropic-api" }),
    )

    expect(result).toMatchObject({ ok: true, truncated: true })
  })
})
