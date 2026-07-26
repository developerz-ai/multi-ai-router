import { describe, expect, test } from "bun:test"
import { isRouterError, ModelNotFoundError } from "@multi-ai-router/core"
import type { VerifiedKey } from "../../../src/services/dataplane"
import { reachableModel, reachableModels } from "../../../src/services/dataplane"
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
    expect(models).toEqual([{ id: "sonnet", owner: "zai" }])
  })

  test("an account declaring no models contributes no name rather than inventing a catalog", () => {
    expect(reachableModels(catalog([account("a")]), health(), keyWithFullScope(), NOW)).toEqual([])
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
    expect(model).toEqual({ id: "sonnet", owner: "zai" })
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
    expect(model).toEqual({ id: "whatever-the-client-asked-for", owner: "anthropic-api" })
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
