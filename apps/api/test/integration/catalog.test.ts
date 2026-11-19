import { describe, expect, test } from "bun:test"
import { CLAUDE_SUBSCRIPTION_MODELS, type ModelDescriptor } from "@multi-ai-router/core"
import type { DataPlaneRoutesDeps } from "../../src/routes/v1"
import type { PoolSnapshot } from "../../src/services/routing"
import { account, jsonResponse, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, KEY } from "./harness"

/**
 * `GET /v1/catalog` and `GET /v1/providers` over real HTTP: real middleware, real key
 * verification, real scope intersection, mocked upstreams.
 *
 * What the unit tests cannot show is the wire: that these paths take a router key like every other
 * data-plane path, that an unauthenticated caller cannot enumerate the router, and that the JSON a
 * client actually parses says `null` where this router does not know rather than `0`.
 */

/** A warm catalog stub, keyed the way the real store is: account id, then upstream-side model id. */
function models(
  table: Record<string, Record<string, Partial<ModelDescriptor>>>,
): NonNullable<DataPlaneRoutesDeps["models"]> {
  const describe_ = (accountId: string, id: string): ModelDescriptor | null => {
    const entry = table[accountId]?.[id.toLowerCase()]
    if (entry === undefined) return null
    return {
      id,
      contextTokens: entry.contextTokens ?? null,
      maxOutputTokens: entry.maxOutputTokens ?? null,
      contextSource: entry.contextSource ?? null,
      listingSource: entry.listingSource ?? "upstream",
      resolvedModel: entry.resolvedModel ?? null,
      ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
    }
  }
  return {
    describe: describe_,
    modelsOf: (accountId) =>
      Object.keys(table[accountId] ?? {}).flatMap((id) => describe_(accountId, id) ?? []),
  }
}

interface CatalogBody {
  readonly object: string
  readonly context_table_as_of: string
  readonly data: readonly {
    readonly id: string
    readonly providers: readonly string[]
    readonly accounts: number
    readonly context_length: number | null
    readonly max_output_tokens: number | null
    readonly context_source: string | null
    readonly pricing: Record<string, unknown> | null
    readonly offers: readonly Record<string, unknown>[]
  }[]
}

const zaiAccount = () => account("acct-zai", { apiKey: "sk-one", cipher: CRYPTOR, provider: "zai" })

/** A pool of nothing but Claude subscriptions — the shape a team's shared Claude subs arrive in. */
const SUBSCRIPTION_POOL: PoolSnapshot = {
  id: "subs",
  name: "subscriptions",
  policy: "sticky",
  members: [{ accountId: "sub-a" }, { accountId: "sub-b" }],
}

describe("GET /v1/catalog", () => {
  test("answers with a size, a price, and the depth of the pool behind each model", async () => {
    const { app } = harness({
      accounts: [zaiAccount()],
      responses: [() => jsonResponse(200, {})],
      models: models({
        "acct-zai": {
          "glm-4.6": { contextTokens: 204_800, maxOutputTokens: 131_072, contextSource: "shipped" },
        },
      }),
    })

    const res = await app.request("/v1/catalog", { headers: bearer() })
    const body = (await res.json()) as CatalogBody

    expect(res.status).toBe(200)
    expect(body.object).toBe("catalog")
    expect(body.data).toEqual([
      {
        id: "glm-4.6",
        providers: ["zai"],
        accounts: 1,
        context_length: 204_800,
        max_output_tokens: 131_072,
        context_source: "shipped",
        pricing: {
          currency: "USD",
          input_per_mtok: 0.6,
          output_per_mtok: 2.2,
          cache_read_per_mtok: 0.11,
          cache_write_per_mtok: 0,
        },
        offers: [
          {
            provider: "zai",
            accounts: 1,
            context_length: 204_800,
            max_output_tokens: 131_072,
            context_source: "shipped",
            pricing: {
              currency: "USD",
              input_per_mtok: 0.6,
              output_per_mtok: 2.2,
              cache_read_per_mtok: 0.11,
              cache_write_per_mtok: 0,
            },
          },
        ],
      },
    ])
    // The shipped table's own date rides the response: a `shipped` window is only as current as
    // this, and a listing that could not age visibly is one nobody can judge.
    expect(body.context_table_as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("a tiered price states the long-context card and where it takes over", async () => {
    const { app } = harness({
      accounts: [account("acct-mm", { apiKey: "sk-mm", cipher: CRYPTOR, provider: "minimax" })],
      responses: [() => jsonResponse(200, {})],
      models: models({ "acct-mm": { "minimax-m3": { contextTokens: 1_000_000 } } }),
    })

    const res = await app.request("/v1/catalog", { headers: bearer() })
    const body = (await res.json()) as CatalogBody

    expect(body.data[0]?.pricing).toEqual({
      currency: "USD",
      input_per_mtok: 0.3,
      output_per_mtok: 1.2,
      cache_read_per_mtok: 0.06,
      cache_write_per_mtok: 0,
      long_context: {
        from_prompt_tokens: 512_000,
        input_per_mtok: 0.6,
        output_per_mtok: 2.4,
        cache_read_per_mtok: 0.12,
        cache_write_per_mtok: 0,
      },
    })
  })

  test("publishes the size every account can take, and each provider's own answer in offers", async () => {
    const { app } = harness({
      accounts: [
        zaiAccount(),
        account("acct-or", { apiKey: "sk-two", cipher: CRYPTOR, provider: "openai-compatible" }),
      ],
      responses: [() => jsonResponse(200, {})],
      models: models({
        "acct-zai": { shared: { contextTokens: 204_800, contextSource: "shipped" } },
        "acct-or": { shared: { contextTokens: 128_000, contextSource: "upstream" } },
      }),
    })

    const res = await app.request("/v1/catalog", { headers: bearer() })
    const body = (await res.json()) as CatalogBody
    const shared = body.data.find((row) => row.id === "shared")

    expect(shared).toMatchObject({ context_length: 128_000, context_source: "upstream" })
    expect(shared?.offers).toEqual([
      expect.objectContaining({ provider: "openai-compatible", context_length: 128_000 }),
      expect.objectContaining({
        provider: "zai",
        context_length: 204_800,
        context_source: "shipped",
      }),
    ])
  })

  test("states the thinking modes a listing gave, and nothing where none was given", async () => {
    const reasoning = { supported: true, effort: ["low", "high", "max"] }
    const { app } = harness({
      accounts: [zaiAccount()],
      responses: [() => jsonResponse(200, {})],
      models: models({ "acct-zai": { "glm-4.6": { reasoning }, "glm-4.5": {} } }),
    })

    const res = await app.request("/v1/catalog", { headers: bearer() })
    const body = (await res.json()) as { data: { id: string }[] }

    expect(body.data.find((row) => row.id === "glm-4.6")).toMatchObject({ reasoning })
    expect(body.data.find((row) => row.id === "glm-4.5")).not.toHaveProperty("reasoning")
  })

  /**
   * The whole reason the endpoint exists. This account declares no `supported_models` and has no
   * aliases, so `/v1/models` has nothing to enumerate — while the sweep knows exactly what its
   * upstream serves.
   */
  test("a passthrough account shows its discovered models here and none on /v1/models", async () => {
    const options = {
      accounts: [zaiAccount()],
      responses: [() => jsonResponse(200, {})],
      models: models({ "acct-zai": { "glm-5.2": { contextTokens: 1_048_576 } } }),
    }

    const listedResponse = await harness(options).app.request("/v1/models", { headers: bearer() })
    const listed = (await listedResponse.json()) as { data: { id: string }[] }
    expect(listed.data).toEqual([])

    const catalogResponse = await harness(options).app.request("/v1/catalog", { headers: bearer() })
    const catalog = (await catalogResponse.json()) as CatalogBody
    expect(catalog.data.map((entry) => entry.id)).toEqual(["glm-5.2"])
  })

  test("unknown is rendered as null, never as zero", async () => {
    const { app } = harness({
      accounts: [zaiAccount()],
      responses: [() => jsonResponse(200, {})],
      // A model in neither the upstream listing nor the shipped table.
      models: models({ "acct-zai": { "glm-99-unreleased": {} } }),
    })

    const body = (await (
      await app.request("/v1/catalog", { headers: bearer() })
    ).json()) as CatalogBody

    expect(body.data[0]).toMatchObject({
      id: "glm-99-unreleased",
      context_length: null,
      max_output_tokens: null,
      context_source: null,
      // No shipped z.ai price for an id that does not exist.
      pricing: null,
    })
  })

  test("it is a router-key path like every other one on /v1", async () => {
    const { app } = harness({
      accounts: [zaiAccount()],
      responses: [() => jsonResponse(200, {})],
      models: models({ "acct-zai": { "glm-4.6": {} } }),
    })

    expect((await app.request("/v1/catalog")).status).toBe(401)
    expect(
      (await app.request("/v1/catalog", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401)
  })

  test("scope narrows the catalog, exactly as it narrows /v1/models", async () => {
    const { app } = harness({
      accounts: [
        zaiAccount(),
        account("acct-mini", { apiKey: "sk-two", cipher: CRYPTOR, provider: "minimax" }),
      ],
      scope: "accounts",
      accountIds: ["acct-zai"],
      responses: [() => jsonResponse(200, {})],
      models: models({
        "acct-zai": { "glm-4.6": {} },
        "acct-mini": { "minimax-m2": {} },
      }),
    })

    const body = (await (
      await app.request("/v1/catalog", { headers: bearer() })
    ).json()) as CatalogBody

    expect(body.data.map((entry) => entry.id)).toEqual(["glm-4.6"])
  })

  /**
   * The defect, over real HTTP: a pool of Claude subscriptions whose warm rows name only part of
   * what they serve. `GET /v1/models` unions the stored rows with the shipped table
   * (`services/models/listable.ts`); `GET /v1/catalog` published the stored rows alone, so a model a
   * client had just been told it could use was missing from the page an operator sizes a prompt
   * from. Both endpoints read one router, so both must name the same set.
   */
  test("a subscription pool's catalog names everything /v1/models names", async () => {
    const options = {
      accounts: [subscriptionAccount("sub-a"), subscriptionAccount("sub-b")],
      pools: [SUBSCRIPTION_POOL],
      scope: "pools" as const,
      poolIds: [SUBSCRIPTION_POOL.id],
      responses: [() => jsonResponse(200, {})],
      // The handshake reached both accounts and named one id each — narrower than this image's
      // table, which is the ordinary case for a subscription mid-rollout.
      models: models({
        "sub-a": { "claude-opus-5": {} },
        "sub-b": { "claude-sonnet-5": {} },
      }),
    }

    const listed = (await (
      await harness(options).app.request("/v1/models", { headers: bearer() })
    ).json()) as { data: { id: string }[] }
    const catalog = (await (
      await harness(options).app.request("/v1/catalog", { headers: bearer() })
    ).json()) as CatalogBody

    const listedIds = new Set(listed.data.map((row) => row.id))
    const catalogIds = new Set(catalog.data.map((row) => row.id))
    // Nothing the client was offered is missing from the catalog.
    expect([...listedIds].filter((id) => !catalogIds.has(id))).toEqual([])
    // And every shipped id is there, the five a Claude Code client asks for by name among them.
    for (const id of [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
      "claude-fable-5-1",
      "claude-fable-5-2",
    ])
      expect(catalogIds.has(id)).toBe(true)
    expect(catalogIds.size).toBeGreaterThanOrEqual(CLAUDE_SUBSCRIPTION_MODELS.length)
  })

  /** The union adds names to an account in scope; it must never add an account to the scope. */
  test("an out-of-scope subscription contributes nothing, shipped table included", async () => {
    const options = {
      accounts: [subscriptionAccount("sub-a"), subscriptionAccount("sub-b")],
      scope: "accounts" as const,
      accountIds: ["sub-a"],
      responses: [() => jsonResponse(200, {})],
      models: models({
        "sub-a": { "claude-opus-5": {} },
        "sub-b": { "claude-unreleased-9": {} },
      }),
    }

    const catalog = (await (
      await harness(options).app.request("/v1/catalog", { headers: bearer() })
    ).json()) as CatalogBody
    const listed = (await (
      await harness(options).app.request("/v1/models", { headers: bearer() })
    ).json()) as { data: { id: string }[] }

    expect(catalog.data.map((entry) => entry.id)).not.toContain("claude-unreleased-9")
    expect(listed.data.map((row) => row.id)).not.toContain("claude-unreleased-9")
    // The in-scope account's shipped union is intact.
    expect(catalog.data.map((entry) => entry.id)).toContain("claude-opus-5-5")
    const listedIds = listed.data.map((row) => row.id)
    expect(listedIds.filter((id) => !catalog.data.some((entry) => entry.id === id))).toEqual([])
  })

  test("a router built without a warm catalog answers an empty list, not a 404", async () => {
    const { app } = harness({ accounts: [zaiAccount()], responses: [() => jsonResponse(200, {})] })

    const res = await app.request("/v1/catalog", { headers: bearer() })

    expect(res.status).toBe(200)
    expect(((await res.json()) as CatalogBody).data).toEqual([])
  })
})

describe("GET /v1/providers", () => {
  test("names the upstreams this key can reach and how many accounts can serve now", async () => {
    const { app } = harness({
      accounts: [
        zaiAccount(),
        account("acct-zai-2", {
          apiKey: "sk-two",
          cipher: CRYPTOR,
          provider: "zai",
          snapshot: { status: "exhausted" },
        }),
        account("acct-mini", { apiKey: "sk-three", cipher: CRYPTOR, provider: "minimax" }),
      ],
      responses: [() => jsonResponse(200, {})],
    })

    const body = (await (await app.request("/v1/providers", { headers: bearer() })).json()) as {
      object: string
      data: Record<string, unknown>[]
    }

    expect(body.object).toBe("list")
    // `id`, `accounts`, `available` unchanged for existing readers; the status counts sit flat
    // beside them, every status present, so a reader sizing capacity reads `active`.
    expect(body.data).toEqual([
      {
        id: "minimax",
        accounts: 1,
        available: 1,
        active: 1,
        disabled: 0,
        cooling_down: 0,
        exhausted: 0,
        needs_reauth: 0,
      },
      // Two z.ai credentials, one usable — the state an operator needs to see.
      {
        id: "zai",
        accounts: 2,
        available: 1,
        active: 1,
        disabled: 0,
        cooling_down: 0,
        exhausted: 1,
        needs_reauth: 0,
      },
    ])
  })

  test("needs a router key too", async () => {
    const { app } = harness({ accounts: [zaiAccount()], responses: [() => jsonResponse(200, {})] })

    expect((await app.request("/v1/providers")).status).toBe(401)
    expect(KEY.startsWith("mar_live_")).toBe(true)
  })
})
