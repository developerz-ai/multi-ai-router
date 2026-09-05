import { describe, expect, test } from "bun:test"
import { isRouterError, ModelNotFoundError } from "@multi-ai-router/core"
import type { VerifiedKey } from "../../../src/services/dataplane"
import { reachableModel, reachableModels } from "../../../src/services/dataplane"
import type { PoolSnapshot } from "../../../src/services/routing"
import { account, catalog, health, NOW } from "./fixtures"

/**
 * The `/v1/models` listing.
 *
 * The rule under test is that the listing and the router must agree: a model that appears here
 * has to be one a request can actually be served by. Advertising a model no account can serve
 * turns a configuration problem into a 503 the client had no way to anticipate.
 */

function keyWithFullScope(): VerifiedKey {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "test-key",
    prefix: "mar_live_test",
    scope: { kind: "all" },
    rateLimitRequests: null,
    rateLimitWindowSeconds: null,
    expiresAt: null,
  }
}

describe("reachableModels", () => {
  test("advertises the requested-side alias name, not the upstream one", () => {
    const models = reachableModels(
      catalog([account("a", { modelAliases: { sonnet: "glm-4.7" } })]),
      health(),
      keyWithFullScope(),
      NOW,
    )
    expect(models.map((model) => model.id)).toEqual(["sonnet"])
  })

  test.each([["disabled"], ["exhausted"], ["needs_reauth"]] as const)(
    "a %s account advertises nothing — the listing would otherwise promise a 503",
    (status) => {
      const models = reachableModels(
        catalog([account("a", { modelAliases: { sonnet: "glm-4.7" }, snapshot: { status } })]),
        health(),
        keyWithFullScope(),
        NOW,
      )
      expect(models).toEqual([])
    },
  )

  test("a cooling_down account still advertises — that block clears on a clock", () => {
    // Deliberately the opposite of the case above. A cooldown is measured in minutes, and a
    // model blinking out of a client's catalog and back is worse than a brief retry.
    const models = reachableModels(
      catalog([
        account("a", { modelAliases: { sonnet: "glm-4.7" }, snapshot: { status: "cooling_down" } }),
      ]),
      health(),
      keyWithFullScope(),
      NOW,
    )
    expect(models.map((model) => model.id)).toEqual(["sonnet"])
  })

  test("a healthy account keeps a model a blocked one also offered", () => {
    const models = reachableModels(
      catalog([
        account("blocked", {
          modelAliases: { sonnet: "glm-4.7" },
          snapshot: { status: "exhausted" },
        }),
        account("live", { modelAliases: { sonnet: "glm-4.7" }, provider: "zai" }),
      ]),
      health(),
      keyWithFullScope(),
      NOW,
    )
    // An alias row says what it resolves to under the operator's own map — information only.
    expect(models).toEqual([{ id: "sonnet", owner: "zai", resolvedModel: "glm-4.7" }])
  })

  test("an account declaring no models contributes no name rather than inventing a catalog", () => {
    expect(reachableModels(catalog([account("a")]), health(), keyWithFullScope(), NOW)).toEqual([])
  })

  test("a declared model set is what a normal deployment advertises — no alias map required", () => {
    // The bug this column closed: `supportedModels` was declared by routing and written by
    // nothing, so an operator with no alias map got `data: []` and a tool with an empty picker.
    const models = reachableModels(
      catalog([
        account("a", { snapshot: { supportedModels: ["claude-opus-5", "claude-haiku-5"] } }),
      ]),
      health(),
      keyWithFullScope(),
      NOW,
    )
    expect(models).toEqual([
      { id: "claude-haiku-5", owner: "anthropic-api", resolvedModel: null },
      { id: "claude-opus-5", owner: "anthropic-api", resolvedModel: null },
    ])
  })

  test("an alias pointing outside the declared set is not advertised — the listing never promises a 503", () => {
    const models = reachableModels(
      catalog([
        account("a", {
          modelAliases: { sonnet: "glm-4.7" },
          snapshot: { supportedModels: ["glm-4.6"] },
        }),
      ]),
      health(),
      keyWithFullScope(),
      NOW,
    )
    expect(models.map((model) => model.id)).toEqual(["glm-4.6"])
  })

  test("a model listed by one account is reachable, as an actual request for it proves", () => {
    // Listing and routing are one rule: everything advertised must resolve, and it is asserted
    // here against the real selection path rather than against a second copy of the derivation.
    const only = catalog([account("a", { snapshot: { supportedModels: ["glm-4.6"] } })])
    for (const model of reachableModels(only, health(), keyWithFullScope(), NOW)) {
      expect(reachableModel(only, health(), keyWithFullScope(), model.id, NOW)).toEqual(model)
    }
  })
})

describe("reachableModel", () => {
  test("finds the requested-side alias name and names its owner", () => {
    const model = reachableModel(
      catalog([account("a", { modelAliases: { sonnet: "glm-4.7" }, provider: "zai" })]),
      health(),
      keyWithFullScope(),
      "sonnet",
      NOW,
    )
    expect(model).toEqual({ id: "sonnet", owner: "zai", resolvedModel: "glm-4.7" })
  })

  test("a passthrough account (no declared models) still answers a probe for any id", () => {
    // Deliberately the opposite of the listing's rule: the listing can't enumerate a name it
    // never declared, but an actual routing attempt for that name would still be served.
    const model = reachableModel(
      catalog([account("a")]),
      health(),
      keyWithFullScope(),
      "whatever-the-client-asked-for",
      NOW,
    )
    expect(model).toEqual({
      id: "whatever-the-client-asked-for",
      owner: "anthropic-api",
      resolvedModel: null,
    })
  })

  test("throws ModelNotFoundError, naming the scope-aware reason, when no account can serve it", () => {
    let caught: unknown
    try {
      reachableModel(
        catalog([account("a", { snapshot: { status: "exhausted" } })]),
        health(),
        keyWithFullScope(),
        "sonnet",
        NOW,
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ModelNotFoundError)
    expect(isRouterError(caught)).toBe(true)
    expect((caught as ModelNotFoundError).status).toBe(404)
    expect((caught as ModelNotFoundError).message).toContain("sonnet")
  })

  test("an out-of-scope key sees nothing to reach, same as the listing would", () => {
    const scopedKey: VerifiedKey = {
      ...keyWithFullScope(),
      scope: { kind: "accounts", accountIds: [] },
    }

    expect(() =>
      reachableModel(catalog([account("a")]), health(), scopedKey, "sonnet", NOW),
    ).toThrow(ModelNotFoundError)
  })
})

/**
 * The catalog is the second half of the pool-overflow scope leak: an overflow the pool does not
 * hold would not only be spendable by a key scoped to that pool, its models would be advertised
 * to that key as well. Reachability here is the same intersection selection uses, so closing it
 * in `services/routing/scope.ts` has to close it here too.
 */
describe("a pool's overflow and the catalog", () => {
  const KEY_SCOPED_TO_TEAM: VerifiedKey = {
    ...keyWithFullScope(),
    scope: { kind: "pools", poolIds: ["team"] },
  }

  /** Declared models, so neither account is a passthrough that answers any probe. */
  const serving = (id: string, model: string) =>
    account(id, { provider: "zai", snapshot: { supportedModels: [model] } })

  const team = (memberIds: readonly string[]): PoolSnapshot => ({
    id: "team",
    name: "team",
    policy: "sticky",
    members: memberIds.map((accountId) => ({ accountId })),
    overflowAccountId: "corp",
  })

  const accounts = [serving("sub", "sonnet"), serving("corp", "corp-only-model")]

  test("an overflow the pool does not hold advertises nothing to a key scoped to that pool", () => {
    const models = reachableModels(
      catalog(accounts, [team(["sub"])]),
      health(),
      KEY_SCOPED_TO_TEAM,
      NOW,
    )
    expect(models.map((model) => model.id)).toEqual(["sonnet"])
  })

  test("a probe for that overflow's model is a 404, not a route to it", () => {
    expect(() =>
      reachableModel(
        catalog(accounts, [team(["sub"])]),
        health(),
        KEY_SCOPED_TO_TEAM,
        "corp-only-model",
        NOW,
      ),
    ).toThrow(ModelNotFoundError)
  })

  test("an overflow the pool does hold advertises normally — it is a member", () => {
    const models = reachableModels(
      catalog(accounts, [team(["sub", "corp"])]),
      health(),
      KEY_SCOPED_TO_TEAM,
      NOW,
    )
    expect(models.map((model) => model.id)).toEqual(["corp-only-model", "sonnet"])
  })
})
