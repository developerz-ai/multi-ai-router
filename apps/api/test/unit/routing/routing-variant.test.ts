import { describe, expect, test } from "bun:test"
import { providerModelFamily, providerRoutingVariants } from "../../../src/providers/registry"
import { type AccountSnapshot, resolveModel, selectAccounts } from "../../../src/services/routing"
import { account, ids, snapshot } from "./fixtures"

/**
 * OpenRouter routing variants (`:floor`, `:nitro`, `:exacto`, `:online`) are accepted on every
 * model id and are never an entry in its `/models` listing. Prod 2026-11-15: `openrouter-coding`
 * pinned `deepseek/deepseek-v4.1-flash:floor`, the hand-added `:floor` id vanished from
 * `supportedModels` when the account was re-listed from `/models` at ~05:38Z, and ~2,000 requests
 * over 19 h were refused `no account in pool openrouter-coding serves model
 * "deepseek/deepseek-v4.1-flash:floor"` while the base id sat in the list.
 */

const BASE = "deepseek/deepseek-v4.1-flash"

function openrouter(supportedModels: readonly string[]): AccountSnapshot {
  const family = providerModelFamily("openrouter")
  const variants = providerRoutingVariants("openrouter")
  return account("openrouter-dz-coding-30d", {
    provider: "openrouter",
    supportedModels,
    ...(family === undefined ? {} : { modelFamily: family }),
    ...(variants.length === 0 ? {} : { routingVariants: variants }),
  })
}

describe("OpenRouter routing variants", () => {
  test("the prod fingerprint: X:floor is served where X is listed, and goes upstream unchanged", () => {
    const resolved = resolveModel(openrouter([BASE, "z-ai/glm-5.3"]), `${BASE}:floor`)
    expect(resolved).toEqual({ upstreamModel: `${BASE}:floor`, supported: true, aliased: false })
  })

  test("every documented routing variant resolves against its base id", () => {
    for (const suffix of [":floor", ":nitro", ":exacto", ":online"]) {
      expect(resolveModel(openrouter([BASE]), `${BASE}${suffix}`).supported).toBe(true)
    }
  })

  test("the selector routes the variant to the account instead of a scope refusal", () => {
    const acc = openrouter([BASE])
    const selection = selectAccounts(snapshot([acc]), {
      sessionKey: "s",
      model: `${BASE}:floor`,
      keyScope: { kind: "accounts", accountIds: [acc.id] },
      rotationCounter: 0,
    })
    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(ids(selection.candidates)).toEqual([acc.id])
    expect(selection.candidates[0]?.upstreamModel).toBe(`${BASE}:floor`)
  })

  test("catalog variants are their own listed models and are never stripped", () => {
    for (const suffix of [":free", ":batch", ":thinking", ":extended"]) {
      expect(resolveModel(openrouter([BASE]), `${BASE}${suffix}`).supported).toBe(false)
    }
  })

  test("a catalog variant that is listed takes a routing variant on top of it", () => {
    const free = `${BASE}:free`
    expect(resolveModel(openrouter([free]), `${free}:nitro`).supported).toBe(true)
  })

  test("an unknown base with a routing variant is still refused", () => {
    expect(resolveModel(openrouter([BASE]), "nobody/unknown-model:floor").supported).toBe(false)
  })

  test("only a trailing suffix counts: a variant word inside the id is not a variant", () => {
    expect(resolveModel(openrouter([BASE]), `${BASE}:floorish`).supported).toBe(false)
  })

  test("a provider that declares no variants never strips a suffix", () => {
    const zai = account("zai", { provider: "zai", supportedModels: ["glm-5.3"] })
    expect(providerRoutingVariants("zai")).toEqual([])
    expect(resolveModel(zai, "glm-5.3:floor").supported).toBe(false)
  })
})
