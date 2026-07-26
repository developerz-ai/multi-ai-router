import { describe, expect, test } from "bun:test"
import { advertisedModels, resolveModel } from "../../../src/services/routing"
import { account } from "./fixtures"

/**
 * The two halves of one rule.
 *
 * `resolveModel` decides whether a name a client sent is served; `advertisedModels` publishes the
 * names for which that answer is yes. The invariant that matters is that they cannot disagree —
 * `GET /v1/models` promising a model no request can be routed to is a 503 the client had no way to
 * anticipate, and a servable model missing from the listing is a router that looks empty.
 */

describe("resolveModel", () => {
  test("an account declaring nothing serves anything — unknown is passthrough, not exclusion", () => {
    expect(resolveModel(account("a"), "anything-at-all")).toEqual({
      upstreamModel: "anything-at-all",
      supported: true,
      aliased: false,
    })
  })

  test("an empty declared list is the same claim as no list at all", () => {
    expect(resolveModel(account("a", { supportedModels: [] }), "x").supported).toBe(true)
  })

  test("the declared set is checked against the aliased name, not the requested one", () => {
    const zai = account("a", {
      supportedModels: ["glm-4.7"],
      modelAliases: { sonnet: "glm-4.7" },
    })
    expect(resolveModel(zai, "sonnet")).toEqual({
      upstreamModel: "glm-4.7",
      supported: true,
      aliased: true,
    })
  })

  test("a declared set that omits the aliased name refuses it", () => {
    const stale = account("a", {
      supportedModels: ["glm-4.6"],
      modelAliases: { sonnet: "glm-4.7" },
    })
    expect(resolveModel(stale, "sonnet").supported).toBe(false)
  })
})

describe("advertisedModels", () => {
  test("a passthrough account enumerates only what an operator wrote down", () => {
    // It serves any name, but it cannot list a catalog it never declared.
    expect(advertisedModels(account("a"))).toEqual([])
    expect(advertisedModels(account("a", { modelAliases: { sonnet: "glm-4.7" } }))).toEqual([
      "sonnet",
    ])
  })

  test("declared upstream names are requestable under their own names", () => {
    const declared = account("a", { supportedModels: ["glm-4.7", "glm-4.6"] })
    expect([...advertisedModels(declared)].sort()).toEqual(["glm-4.6", "glm-4.7"])
  })

  test("an alias key and its target are both offered, and the target is not listed twice", () => {
    const zai = account("a", {
      supportedModels: ["glm-4.7"],
      modelAliases: { sonnet: "glm-4.7" },
    })
    expect([...advertisedModels(zai)].sort()).toEqual(["glm-4.7", "sonnet"])
  })

  test("an alias pointing at a model the account does not serve is never advertised", () => {
    // The union of both fields would list `sonnet` here, and selection would then drop the
    // account as `model-unsupported` — a listing that promises a 503.
    const stale = account("a", {
      supportedModels: ["glm-4.6"],
      modelAliases: { sonnet: "glm-4.7" },
    })
    expect(advertisedModels(stale)).toEqual(["glm-4.6"])
  })

  test("a declared name whose own alias points somewhere unserved drops off the listing", () => {
    // `glm-4.7` is declared, but an alias renames it on the way out and the target is not served.
    // Listing it from the declared set alone would advertise a name every request for 503s.
    const shadowed = account("a", {
      supportedModels: ["glm-4.6", "glm-4.7"],
      modelAliases: { "glm-4.7": "retired-model" },
    })
    expect(advertisedModels(shadowed)).toEqual(["glm-4.6"])
  })

  test("an alias redirecting one declared name to another keeps both — both are servable", () => {
    // The opposite of the case above, and the reason the rule is a resolution check rather than a
    // "has an alias" check: asking for `glm-4.7` works, it just leaves as `glm-4.6`.
    const redirected = account("a", {
      supportedModels: ["glm-4.6", "glm-4.7"],
      modelAliases: { "glm-4.7": "glm-4.6" },
    })
    expect([...advertisedModels(redirected)].sort()).toEqual(["glm-4.6", "glm-4.7"])
  })

  test("every advertised name resolves as supported, and nothing else declared does not", () => {
    // The invariant itself, asserted over a deliberately tangled account: identity alias, a
    // shadowing alias, a dangling alias, and a plain declared model all at once.
    const tangled = account("a", {
      supportedModels: ["keep", "shadowed", "target"],
      modelAliases: {
        identity: "keep",
        shadowed: "target",
        dangling: "not-served",
        "self-referential": "self-referential",
      },
    })

    const advertised = advertisedModels(tangled)
    for (const name of advertised) {
      expect(resolveModel(tangled, name).supported).toBe(true)
    }
    expect([...advertised].sort()).toEqual(["identity", "keep", "shadowed", "target"])
  })
})
