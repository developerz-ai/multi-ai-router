import { describe, expect, test } from "bun:test"
import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import {
  createDiscoverModelsService,
  type SupportedModelsEdit,
} from "../../../src/services/accounts"
import type { AuditEventInput } from "../../../src/services/admin"
import { accountRow as durableAccountRow } from "../../support/account-row"
import { testSupportedModelsWriter } from "../../support/supported-models-writer"

/**
 * "Discover models" — ask the upstream what it serves and merge the answer into `supportedModels`.
 *
 * The properties worth pinning: it addresses the account's own dialect's listing path, it reads
 * both wire shapes out of the one field they share, it never turns an unreadable or empty answer
 * into a declaration that the account serves nothing, and a Claude subscription is refused by name
 * rather than sent at an endpoint the Agent SDK owns.
 */

const NOW = new Date("2026-01-01T12:00:00.000Z")

function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return durableAccountRow({
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
  })
}

/** A one-row repository with the real lock semantics `editSupportedModels` promises. */
function oneRowRepository(initial: AccountRow) {
  let row = initial
  return {
    current: () => row,
    findById: async (id: string) => (id === row.id ? row : undefined),
    editSupportedModels: async (
      input: Parameters<AccountRepository["editSupportedModels"]>[0],
    ): ReturnType<AccountRepository["editSupportedModels"]> => {
      if (input.id !== row.id) return { kind: "not_found" }
      const decision = input.decide(row)
      if (decision.kind === "skip") return { kind: "skipped", row }
      row = {
        ...row,
        supportedModels: decision.supportedModels,
        supportedModelsRemoved: decision.supportedModelsRemoved,
        updatedAt: input.now,
      }
      return { kind: "written", row }
    },
  }
}

function harness(options: {
  readonly row?: AccountRow
  readonly fetch?: (request: Request) => Promise<Response>
  readonly log?: { warn: (message: string, fields?: Record<string, unknown>) => void }
}) {
  const repository = oneRowRepository(options.row ?? accountRow())
  const audited: AuditEventInput[] = []
  const audit = { record: async (event: AuditEventInput) => void audited.push(event) }
  const edits: SupportedModelsEdit[] = []
  const writer = testSupportedModelsWriter(repository, { audit })

  const service = createDiscoverModelsService({
    accounts: repository,
    models: {
      write: (id, edit, source) => {
        edits.push(edit)
        return writer.write(id, edit, source)
      },
    },
    cipher: { decrypt: (envelope) => envelope },
    audit,
    timeoutMs: 5_000,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.log === undefined ? {} : { log: options.log }),
  })

  return { service, audited, edits, stored: () => repository.current().supportedModels }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("createDiscoverModelsService", () => {
  test("reads the Anthropic listing and writes the ids, deduplicated and sorted", async () => {
    const seen: { url: string | null; method: string | null } = { url: null, method: null }
    const { service, stored } = harness({
      fetch: async (request) => {
        seen.url = request.url
        seen.method = request.method
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
    expect(seen.url).toContain("/v1/models")
    expect(seen.method).toBe("GET")
    expect(stored()).toEqual(["glm-4.6", "glm-4.7"])
  })

  test("reads the OpenAI listing off the same field, at that dialect's own path", async () => {
    const seen: { url: string | null } = { url: null }
    const { service, stored } = harness({
      row: accountRow({ dialect: "openai-chat" }),
      fetch: async (request) => {
        seen.url = request.url
        return jsonResponse(200, {
          object: "list",
          data: [{ id: "glm-4.7", object: "model", owned_by: "zai" }],
        })
      },
    })

    const result = await service.discover("acc-1")
    expect(result.ok).toBe(true)
    expect(seen.url).toContain("/models")
    expect(seen.url).not.toContain("/v1/models")
    expect(stored()).toEqual(["glm-4.7"])
  })

  test("asks for the whole catalog rather than the provider's default page", async () => {
    // Anthropic's listing pages at 20 by default. Discovering 20 of 60 models and writing them as
    // the declaration would take the other 40 out of selection.
    const seen: { url: string | null } = { url: null }
    const { service } = harness({
      fetch: async (request) => {
        seen.url = request.url
        return jsonResponse(200, { data: [{ id: "glm-4.7" }] })
      },
    })

    await service.discover("acc-1")
    expect(new URL(seen.url ?? "https://x.test").searchParams.get("limit")).toBe("1000")
  })

  test("an empty listing writes nothing — it is not a claim that the account serves nothing", async () => {
    const { service, edits: writes } = harness({
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
    const { service, edits: writes } = harness({
      fetch: async () => jsonResponse(200, { models: ["glm-4.7"] }),
    })

    const result = await service.discover("acc-1")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("discovery_unreadable")
    expect(writes).toEqual([])
  })

  test("an entry with no usable id is dropped without failing the whole listing", async () => {
    const { service, stored } = harness({
      fetch: async () =>
        jsonResponse(200, { data: [{ id: "glm-4.7" }, { id: 42 }, { id: "  " }, {}] }),
    })

    const result = await service.discover("acc-1")
    expect(result.ok).toBe(true)
    expect(stored()).toEqual(["glm-4.7"])
  })

  test("an upstream rejection is reported with its classification and writes nothing", async () => {
    const { service, edits: writes } = harness({
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
    const { service, edits: writes } = harness({
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
    expect(audited.map((event) => event.kind)).toEqual([
      "account.models_discovered",
      "account.supported_models_changed",
    ])
    expect(audited[0]?.subjectId).toBe("acc-1")
    expect(audited[0]?.detail).toEqual({ provider: "zai", count: 1, saved: true })
    expect(JSON.stringify(audited)).not.toContain("plaintext-key")
  })

  test("presents the account's credential upstream, the same way a real attempt would", async () => {
    // Through `runAttempt`, so the header form is the driver's — a compatible vendor's key on
    // `Authorization: Bearer`, with the mandated version header alongside it.
    const seen: { headers: Headers | null } = { headers: null }
    const { service } = harness({
      fetch: async (request) => {
        seen.headers = new Headers(request.headers)
        return jsonResponse(200, { data: [{ id: "glm-4.7" }] })
      },
    })

    await service.discover("acc-1")
    expect(seen.headers?.get("authorization")).toBe("Bearer plaintext-key")
    expect(seen.headers?.get("anthropic-version")).toBe("2023-06-01")
  })
})

describe("a discovery never removes an id (prod 2026-11-15)", () => {
  // The fingerprint: an OpenRouter account whose list carries a hand-added id the catalogue does
  // not list. The old discovery replaced the list, the id vanished, and every request for it was
  // refused `model-unsupported` for 19 h.
  const HAND_ADDED = "deepseek/deepseek-v4.1-flash-0925"
  const row = () =>
    accountRow({
      provider: "openrouter",
      supportedModels: ["deepseek/deepseek-v4.1-flash", HAND_ADDED],
    })
  const listing = async () =>
    jsonResponse(200, { data: [{ id: "deepseek/deepseek-v4.1-flash" }, { id: "z-ai/glm-5.3" }] })

  test("a discovery over a list with a hand-added id keeps it, and adds what is new", async () => {
    const { service, stored } = harness({ row: row(), fetch: listing })

    const result = await service.discover("acc-1")
    expect(result.ok).toBe(true)
    expect(stored()).toEqual(["deepseek/deepseek-v4.1-flash", HAND_ADDED, "z-ai/glm-5.3"])
  })

  test("the diff lists the hand-added id under notInCatalogue, and the new one under added", async () => {
    const { service } = harness({ row: row(), fetch: listing })

    const result = await service.discover("acc-1")
    if (!result.ok) throw new Error(result.failure.message)
    expect(result.value.added).toEqual(["z-ai/glm-5.3"])
    expect(result.value.notInCatalogue).toEqual([HAND_ADDED])
    expect(result.value.supportedModels).toEqual([
      "deepseek/deepseek-v4.1-flash",
      HAND_ADDED,
      "z-ai/glm-5.3",
    ])
    expect(result.value.message).toContain("not in the catalogue and were kept")
  })

  test("it asks the writer only to add — never to remove", async () => {
    const { service, edits } = harness({ row: row(), fetch: listing })
    await service.discover("acc-1")
    expect(edits).toEqual([
      { kind: "edit", add: ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3"], remove: [] },
    ])
  })

  test("the change is audited with the ids added and none removed", async () => {
    const { service, audited } = harness({ row: row(), fetch: listing })
    await service.discover("acc-1")
    const changed = audited.find((event) => event.kind === "account.supported_models_changed")
    expect(changed?.detail).toMatchObject({
      source: "discover",
      added: ["z-ai/glm-5.3"],
      removed: [],
    })
  })

  test("an empty listing removes nothing and writes nothing", async () => {
    const { service, stored, audited } = harness({
      row: accountRow({ supportedModels: ["glm-4.7"] }),
      fetch: async () => jsonResponse(200, { data: [] }),
    })
    await service.discover("acc-1")
    expect(stored()).toEqual(["glm-4.7"])
    expect(audited.map((event) => event.kind)).toEqual(["account.models_discovered"])
  })
})
