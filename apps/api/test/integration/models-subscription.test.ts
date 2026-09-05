import { describe, expect, test } from "bun:test"
import { CLAUDE_SUBSCRIPTION_ALIASES, CLAUDE_SUBSCRIPTION_MODELS } from "@multi-ai-router/core"
import type { AccountRow, ModelCatalogEntry, ModelCatalogRow } from "@multi-ai-router/db"
import { createLogger } from "../../src/logging/logger"
import {
  type CliResolution,
  createSdkConcurrency,
  createSdkModelLister,
  type IdleQuery,
} from "../../src/providers"
import {
  createModelCatalogStore,
  type ModelCatalogStore,
  refreshAccountCatalog,
} from "../../src/services/models"
import type { PoolSnapshot } from "../../src/services/routing"
import { jsonResponse, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, KEY } from "./harness"

/**
 * The production bug, over real HTTP: a key scoped to a pool of nothing but Claude subscriptions
 * asked `GET /v1/models` and got `data: []`. A subscription has no `supported_models` and no HTTP
 * listing to discover them from, so routing's view of it is empty — and until the Agent SDK's
 * handshake was made a catalog source, so was the listing.
 *
 * Two paths to a non-empty answer, both asserted here. (a) The shipped table, which stands in for a
 * subscription the sweep has not reached or could not ask. (b) A live list: the real lister with a
 * fake `query()` (never a `claude` CLI), through the real refresh, into an in-memory `model_catalog`,
 * loaded by the real warm store the route reads. Everything between the SDK boundary and the wire
 * is the production code.
 */

interface ListedRow {
  readonly id: string
  readonly object: string
  readonly owned_by: string
  readonly resolved_model?: string
}

const POOL_ID = "subs"

const pool = (): PoolSnapshot => ({
  id: POOL_ID,
  name: "subscriptions",
  policy: "sticky",
  members: [{ accountId: "sub-a" }, { accountId: "sub-b" }],
})

const subscriptions = () => [subscriptionAccount("sub-a"), subscriptionAccount("sub-b")]

function subscriptionPool(models?: ModelCatalogStore) {
  return harness({
    accounts: subscriptions(),
    pools: [pool()],
    scope: "pools",
    poolIds: [POOL_ID],
    responses: [() => jsonResponse(200, {})],
    ...(models === undefined ? {} : { models }),
  })
}

async function listed(app: ReturnType<typeof harness>["app"], headers = bearer()) {
  const res = await app.request("/v1/models", { headers })
  expect(res.status).toBe(200)
  return (await res.json()) as { object: string; data: ListedRow[] }
}

describe("GET /v1/models on a pool of Claude subscriptions", () => {
  test("(a) with no catalog rows yet, the shipped table answers — never data: []", async () => {
    const { app } = subscriptionPool()
    const body = await listed(app)

    expect(body.object).toBe("list")
    const ids = body.data.map((row) => row.id)
    expect(ids).not.toEqual([])
    for (const id of CLAUDE_SUBSCRIPTION_MODELS) expect(ids).toContain(id)
    for (const alias of Object.keys(CLAUDE_SUBSCRIPTION_ALIASES)) expect(ids).toContain(alias)
    // Two accounts, one row per model: deduplicated across the pool.
    expect(new Set(ids).size).toBe(ids.length)
    expect(body.data.every((row) => row.owned_by === "anthropic-oauth")).toBe(true)
  })

  test("an alias row says what it resolves to; a concrete id carries no such field", async () => {
    const { app } = subscriptionPool()
    const body = await listed(app)

    expect(body.data.find((row) => row.id === "sonnet")).toEqual({
      id: "sonnet",
      object: "model",
      created: expect.any(Number),
      owned_by: "anthropic-oauth",
      resolved_model: "claude-sonnet-5",
    })
    expect(body.data.find((row) => row.id === "fable")?.resolved_model).toBe("claude-fable-5-1")
    expect(body.data.find((row) => row.id === "claude-opus-5")).not.toHaveProperty("resolved_model")
  })

  test("the same set in the Anthropic shape for an x-api-key client", async () => {
    const { app } = subscriptionPool()
    const res = await app.request("/v1/models", { headers: { "x-api-key": KEY } })
    const body = (await res.json()) as {
      data: { type: string; id: string; resolved_model?: string }[]
      has_more: boolean
    }

    expect(body.has_more).toBe(false)
    expect(body.data.every((row) => row.type === "model")).toBe(true)
    expect(body.data.find((row) => row.id === "opus")?.resolved_model).toBe("claude-opus-5")
  })

  test("GET /v1/models/:id resolves an alias the same way", async () => {
    const { app } = subscriptionPool()
    const res = await app.request("/v1/models/haiku", { headers: bearer() })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: "haiku", resolved_model: "claude-haiku-4-5" })
  })

  test("(b) with a live SDK listing, the listing is what the pool advertises", async () => {
    // The SDK's answer for both accounts — one names a model this image has never heard of, which
    // is exactly the case a live source exists for.
    const live = [
      { value: "claude-opus-5", displayName: "Opus 5", description: "" },
      { value: "claude-sonnet-6", displayName: "Sonnet 6", description: "" },
      { value: "sonnet", resolvedModel: "claude-sonnet-6", displayName: "Sonnet", description: "" },
    ]
    const cli: CliResolution = {
      ok: true,
      source: "platform_package",
      path: "/opt/claude/claude",
      bytes: 1,
    }
    let spawned = 0
    const lister = createSdkModelLister({
      cliPathOverride: null,
      concurrency: createSdkConcurrency({ global: 2, perAccount: 1 }),
      resolveCli: () => cli,
      runQuery: () => {
        spawned += 1
        const fake: IdleQuery = {
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
          supportedModels: async () => live,
        }
        return fake
      },
    })

    // An in-memory `model_catalog`, replaced per account exactly as the repository does it.
    const table = new Map<string, ModelCatalogRow[]>()
    const catalog = {
      replaceForAccount: async (
        accountId: string,
        rows: readonly ModelCatalogEntry[],
        refreshedAt: Date,
      ) => {
        table.set(
          accountId,
          rows.map((row) => ({ accountId, ...row, refreshedAt })),
        )
      },
    }
    const deps = {
      catalog,
      cipher: { decrypt: (envelope: string) => envelope },
      timeoutMs: 5_000,
      fetch: async () => {
        throw new Error("a subscription is never fetched")
      },
      subscription: {
        lister,
        timeoutMs: 5_000,
        logger: createLogger({ level: "error", write: () => undefined }),
      },
    }
    const now = new Date("2026-07-28T12:00:00.000Z")
    for (const id of ["sub-a", "sub-b"]) {
      const row = { id, provider: "anthropic-oauth", status: "active", configDir: `/data/${id}` }
      expect(await refreshAccountCatalog(deps, row as AccountRow, now)).toEqual({
        kind: "refreshed",
        models: 3,
        source: "live",
      })
    }
    expect(spawned).toBe(2)

    const store = createModelCatalogStore({
      load: async () => [...table.values()].flat(),
      refreshIntervalMs: 60_000,
    })
    await store.refresh()

    const body = await listed(subscriptionPool(store).app)
    expect(body.data.map((row) => row.id)).toEqual(["claude-opus-5", "claude-sonnet-6", "sonnet"])
    // The SDK's resolution, not the shipped map's `claude-sonnet-5`.
    expect(body.data.find((row) => row.id === "sonnet")?.resolved_model).toBe("claude-sonnet-6")
  })

  test("scope still rules: a key that reaches no subscription sees none of this", async () => {
    const { app } = harness({
      accounts: subscriptions(),
      pools: [pool()],
      scope: "pools",
      poolIds: ["some-other-pool"],
      responses: [() => jsonResponse(200, {})],
    })
    expect((await listed(app)).data).toEqual([])
  })
})
