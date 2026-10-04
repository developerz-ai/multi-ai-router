import { describe, expect, test } from "bun:test"
import {
  providerModelFamily,
  providerUnderstandsContextTags,
} from "../../../src/providers/registry"
import { type AccountSnapshot, resolveModel, selectAccounts } from "../../../src/services/routing"
import { splitContextTag } from "../../../src/services/routing/context-tag"
import { account, ids, snapshot } from "./fixtures"

/**
 * Claude Code appends a context-window tag to whatever model it is pointed at: `claudes gpt`
 * listed "Default (currently gpt-6.1-sol[1m])" and the router answered 503 `no account serves
 * model "gpt-6.1-sol[1m]"` while the ChatGPT account's discovered list held `gpt-6.1-sol` (prod,
 * 2026-10-04). The tag is a hint for the `claude` CLI; every other upstream gets the base name.
 */

function declared(provider: AccountSnapshot["provider"]): Partial<AccountSnapshot> {
  const family = providerModelFamily(provider)
  return {
    provider,
    ...(family === undefined ? {} : { modelFamily: family }),
    ...(providerUnderstandsContextTags(provider) ? { understandsContextTags: true } : {}),
  }
}

const codex = account("codex", {
  ...declared("openai-oauth"),
  supportedModels: ["gpt-6.1-sol", "gpt-5.5"],
})
const zai = account("zai", { ...declared("zai"), supportedModels: ["glm-5.3"] })
const claude = account("claude", declared("anthropic-oauth"))
const anthropicKey = account("anthropic-key", declared("anthropic-api"))
const everyone = [codex, zai, claude, anthropicKey]

function selectFor(model: string, accounts: readonly AccountSnapshot[] = everyone) {
  return selectAccounts(snapshot(accounts), {
    sessionKey: `session-${model}`,
    model,
    keyScope: { kind: "accounts", accountIds: accounts.map((entry) => entry.id) },
    rotationCounter: 0,
  })
}

describe("splitContextTag", () => {
  test("splits a trailing bracketed token off a non-empty name", () => {
    expect(splitContextTag("gpt-6.1-sol[1m]")).toEqual({ base: "gpt-6.1-sol", tag: "1m" })
    expect(splitContextTag("opus[1M]")).toEqual({ base: "opus", tag: "1M" })
  })

  for (const name of ["gpt-6.1-sol", "[1m]", "a[1m]b", "a[1-m]", "a[]"]) {
    test(`reads no tag on ${JSON.stringify(name)}`, () => {
      expect(splitContextTag(name)).toBeNull()
    })
  }
})

describe("provider declaration", () => {
  test("only the Claude subscription understands context tags", () => {
    expect(providerUnderstandsContextTags("anthropic-oauth")).toBe(true)
    expect(providerUnderstandsContextTags("openai-oauth")).toBe(false)
    expect(providerUnderstandsContextTags("anthropic-api")).toBe(false)
    expect(providerUnderstandsContextTags("zai")).toBe(false)
  })
})

describe("a context-tagged model name", () => {
  test("routes to ChatGPT/Codex with the tag stripped upstream", () => {
    const result = selectFor("gpt-6.1-sol[1m]", [codex, zai, claude])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(ids(result.candidates)).toEqual(["codex"])
    expect(result.candidates[0]?.upstreamModel).toBe("gpt-6.1-sol")
    expect(resolveModel(codex, "gpt-6.1-sol[1m]")).toEqual({
      upstreamModel: "gpt-6.1-sol",
      supported: true,
      aliased: false,
      strippedContextTag: "1m",
    })
  })

  test("routes to z.ai with the tag stripped upstream", () => {
    const result = selectFor("glm-5.3[1m]", [codex, zai, claude])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(ids(result.candidates)).toEqual(["zai"])
    expect(result.candidates[0]?.upstreamModel).toBe("glm-5.3")
  })

  test("reaches a Claude subscription unchanged — the CLI reads the tag", () => {
    expect(resolveModel(claude, "claude-opus-5-5[1m]")).toEqual({
      upstreamModel: "claude-opus-5-5[1m]",
      supported: true,
      aliased: false,
    })
    const result = selectFor("claude-opus-5-5[1m]", [codex, zai, claude])
    expect(result.ok && ids(result.candidates)).toEqual(["claude"])
    expect(result.ok && result.candidates[0]?.upstreamModel).toBe("claude-opus-5-5[1m]")
  })

  test("goes to an Anthropic API key as its base name — the Messages API has no tagged ids", () => {
    expect(resolveModel(anthropicKey, "claude-opus-5-5[1m]").upstreamModel).toBe("claude-opus-5-5")
  })

  test("with an unserved base is still model-unsupported", () => {
    const result = selectFor("gpt-9-unknown[1m]", [codex, zai, claude])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.status).toBe(503)
    expect(result.decision.rejected.map((entry) => entry.reason)).toEqual([
      "model-unsupported",
      "model-unsupported",
      "model-unsupported",
    ])
  })

  test("aliases through the base name's alias entry", () => {
    const aliased = account("z", { ...declared("zai"), modelAliases: { sonnet: "glm-5.3" } })
    expect(resolveModel(aliased, "sonnet[1m]")).toEqual({
      upstreamModel: "glm-5.3",
      supported: true,
      aliased: true,
      strippedContextTag: "1m",
    })
  })

  test("an explicit alias or listing of the tagged spelling wins over stripping", () => {
    const aliasedTag = account("z", {
      ...declared("zai"),
      modelAliases: { "sonnet[1m]": "glm-5.3-long" },
    })
    expect(resolveModel(aliasedTag, "sonnet[1m]").upstreamModel).toBe("glm-5.3-long")
    const listedTag = account("z", { ...declared("zai"), supportedModels: ["glm-5.3[1m]"] })
    expect(resolveModel(listedTag, "glm-5.3[1m]")).toEqual({
      upstreamModel: "glm-5.3[1m]",
      supported: true,
      aliased: false,
    })
  })
})
