import { describe, expect, test } from "bun:test"
import type { ModelDescriptor } from "@multi-ai-router/core"
import type { DataPlaneRoutesDeps } from "../../src/routes/v1"
import { account, jsonResponse } from "../unit/dataplane/fixtures"
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
    readonly pricing: Record<string, number | string> | null
  }[]
}

const zaiAccount = () => account("acct-zai", { apiKey: "sk-one", cipher: CRYPTOR, provider: "zai" })

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
      },
    ])
    // The shipped table's own date rides the response: a `shipped` window is only as current as
    // this, and a listing that could not age visibly is one nobody can judge.
    expect(body.context_table_as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/)
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

    const listed = await harness(options)
      .app.request("/v1/models", { headers: bearer() })
      .then((res) => res.json() as Promise<{ data: { id: string }[] }>)
    expect(listed.data).toEqual([])

    const catalog = await harness(options)
      .app.request("/v1/catalog", { headers: bearer() })
      .then((res) => res.json() as Promise<CatalogBody>)
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
      data: { id: string; accounts: number; available: number }[]
    }

    expect(body.object).toBe("list")
    expect(body.data).toEqual([
      { id: "minimax", accounts: 1, available: 1 },
      // Two z.ai credentials, one usable — the state an operator needs to see.
      { id: "zai", accounts: 2, available: 1 },
    ])
  })

  test("needs a router key too", async () => {
    const { app } = harness({ accounts: [zaiAccount()], responses: [() => jsonResponse(200, {})] })

    expect((await app.request("/v1/providers")).status).toBe(401)
    expect(KEY.startsWith("mar_live_")).toBe(true)
  })
})
