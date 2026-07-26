import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import type { UpdateAccountBody } from "../../../src/services/accounts"
import { createDiscoverModelsService } from "../../../src/services/accounts"
import type { AuditEventInput } from "../../../src/services/admin"
import { ok } from "../../../src/services/admin/result"

/**
 * "Discover models" — ask the upstream what it serves and write the answer into `supportedModels`.
 *
 * The properties worth pinning: it addresses the account's own dialect's listing path, it reads
 * both wire shapes out of the one field they share, it never turns an unreadable or empty answer
 * into a declaration that the account serves nothing, and a Claude subscription is refused by name
 * rather than sent at an endpoint the Agent SDK owns.
 */

const NOW = new Date("2026-01-01T12:00:00.000Z")

function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acc-1",
    label: "acc-1",
    provider: "zai",
    status: "active",
    authMaterial: "plaintext-key",
    configDir: null,
    tokenExpiresAt: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    weight: 100,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function harness(options: {
  readonly row?: AccountRow
  readonly fetch?: (request: Request) => Promise<Response>
}) {
  const row = options.row ?? accountRow()
  const audited: AuditEventInput[] = []
  const writes: { id: string; patch: UpdateAccountBody }[] = []

  const service = createDiscoverModelsService({
    accounts: { findById: async (id) => (id === row.id ? row : undefined) },
    write: {
      update: async (id, patch) => {
        writes.push({ id, patch })
        // Only the outcome matters here; the accounts service has its own tests.
        return ok({ id }) as never
      },
    },
    cipher: { decrypt: (envelope) => envelope },
    audit: { record: async (event) => void audited.push(event) },
    timeoutMs: 5_000,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })

  return { service, audited, writes }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("createDiscoverModelsService", () => {
  test("reads the Anthropic listing and writes the ids, deduplicated and sorted", async () => {
    let seenUrl: string | null = null
    let seenMethod: string | null = null
    const { service, writes } = harness({
      fetch: async (request) => {
        seenUrl = request.url
        seenMethod = request.method
        return jsonResponse(200, {
          data: [
            { type: "model", id: "glm-4.7", display_name: "GLM 4.7" },
            { type: "model", id: "glm-4.6" },
            { type: "model", id: "glm-4.7" },
          ],
          has_more: false,
        })
      },
    })

    const result = await service.discover("acc-1")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.models).toEqual(["glm-4.6", "glm-4.7"])
    expect(result.value.saved).toBe(true)
    // z.ai's default surface is Anthropic, whose listing lives at `/v1/models`.
    expect(seenUrl).toContain("/v1/models")
    expect(seenMethod).toBe("GET")
    expect(writes).toEqual([{ id: "acc-1", patch: { supportedModels: ["glm-4.6", "glm-4.7"] } }])
  })

  test("reads the OpenAI listing off the same field, at that dialect's own path", async () => {
    let seenUrl: string | null = null
    const { service, writes } = harness({
      row: accountRow({ dialect: "openai-chat" }),
      fetch: async (request) => {
        seenUrl = request.url
        return jsonResponse(200, {
          object: "list",
          data: [{ id: "glm-4.7", object: "model", owned_by: "zai" }],
        })
      },
    })

    const result = await service.discover("acc-1")
    expect(result.ok).toBe(true)
    expect(seenUrl).toContain("/models")
    expect(seenUrl).not.toContain("/v1/models")
    expect(writes[0]?.patch).toEqual({ supportedModels: ["glm-4.7"] })
  })

  test("asks for the whole catalog rather than the provider's default page", async () => {
    // Anthropic's listing pages at 20 by default. Discovering 20 of 60 models and writing them as
    // the declaration would take the other 40 out of selection.
    let seenUrl: string | null = null
    const { service } = harness({
      fetch: async (request) => {
        seenUrl = request.url
        return jsonResponse(200, { data: [{ id: "glm-4.7" }] })
      },
    })

    await service.discover("acc-1")
    expect(new URL(seenUrl ?? "https://x.test").searchParams.get("limit")).toBe("1000")
  })

  test("an empty listing writes nothing — it is not a claim that the account serves nothing", async () => {
    const { service, writes } = harness({
      fetch: async () => jsonResponse(200, { data: [] }),
    })

    const result = await service.discover("acc-1")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.saved).toBe(false)
    expect(result.value.models).toEqual([])
    expect(writes).toEqual([])
  })

  test("an unreadable listing is a refusal, never a silent empty declaration", async () => {
    const { service, writes } = harness({
      fetch: async () => jsonResponse(200, { models: ["glm-4.7"] }),
    })

    const result = await service.discover("acc-1")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("discovery_unreadable")
    expect(writes).toEqual([])
  })

  test("an entry with no usable id is dropped without failing the whole listing", async () => {
    const { service, writes } = harness({
      fetch: async () =>
        jsonResponse(200, { data: [{ id: "glm-4.7" }, { id: 42 }, { id: "  " }, {}] }),
    })

    const result = await service.discover("acc-1")
    expect(result.ok).toBe(true)
    expect(writes[0]?.patch).toEqual({ supportedModels: ["glm-4.7"] })
  })

  test("an upstream rejection is reported with its classification and writes nothing", async () => {
    const { service, writes } = harness({
      fetch: async () =>
        jsonResponse(401, { error: { type: "authentication_error", message: "bad key" } }),
    })

    const result = await service.discover("acc-1")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("discovery_failed")
    expect(result.failure.message).toContain("could not read the model listing")
    expect(writes).toEqual([])
  })

  test("a Claude subscription is refused by name — the Agent SDK owns that catalog", async () => {
    let called = false
    const { service, writes } = harness({
      row: accountRow({
        provider: "anthropic-oauth",
        authMaterial: null,
        configDir: "/data/accounts/acc-1",
      }),
      fetch: async () => {
        called = true
        return jsonResponse(200, { data: [] })
      },
    })

    const result = await service.discover("acc-1")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("models_not_listable")
    expect(result.failure.status).toBe(400)
    expect(called).toBe(false)
    expect(writes).toEqual([])
  })

  test("an unknown account is a 404, and nothing is asked of any upstream", async () => {
    let called = false
    const { service } = harness({
      fetch: async () => {
        called = true
        return jsonResponse(200, { data: [] })
      },
    })

    const result = await service.discover("acc-missing")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.status).toBe(404)
    expect(called).toBe(false)
  })

  test("records one audit event carrying a count and a flag, never the credential", async () => {
    const { service, audited } = harness({
      fetch: async () => jsonResponse(200, { data: [{ id: "glm-4.7" }] }),
    })

    await service.discover("acc-1")
    expect(audited).toHaveLength(1)
    expect(audited[0]?.kind).toBe("account.models_discovered")
    expect(audited[0]?.subjectId).toBe("acc-1")
    expect(audited[0]?.detail).toEqual({ provider: "zai", count: 1, saved: true })
    expect(JSON.stringify(audited)).not.toContain("plaintext-key")
  })

  test("presents the account's credential upstream, the same way a real attempt would", async () => {
    // Through `runAttempt`, so the header form is the driver's — a compatible vendor's key on
    // `Authorization: Bearer`, with the mandated version header alongside it.
    let seen: Headers | null = null
    const { service } = harness({
      fetch: async (request) => {
        seen = new Headers(request.headers)
        return jsonResponse(200, { data: [{ id: "glm-4.7" }] })
      },
    })

    await service.discover("acc-1")
    expect(seen?.get("authorization")).toBe("Bearer plaintext-key")
    expect(seen?.get("anthropic-version")).toBe("2023-06-01")
  })
})
