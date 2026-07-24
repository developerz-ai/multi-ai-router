import { describe, expect, test } from "bun:test"
import { httpDriver, mapModelAlias } from "../../../src/providers"
import { account } from "./fixtures"

/**
 * The product invariant, tested: the router honors the client's model name. The alias map is the
 * one place a name changes, it is per Account, and a miss is identity — never a substitution,
 * never a rejection.
 */

describe("mapModelAlias", () => {
  test("translates a name the Account maps", () => {
    const zai = account({ provider: "zai", modelAliases: { sonnet: "glm-4.7", opus: "glm-5.2" } })

    expect(mapModelAlias(zai, "sonnet")).toBe("glm-4.7")
    expect(mapModelAlias(zai, "opus")).toBe("glm-5.2")
  })

  test("passes an unmapped name through unchanged", () => {
    const zai = account({ provider: "zai", modelAliases: { opus: "glm-5.2" } })

    expect(mapModelAlias(zai, "sonnet")).toBe("sonnet")
  })

  test("passes everything through when the Account has no map at all", () => {
    const bare = account({ provider: "kimi" })

    expect(mapModelAlias(bare, "claude-sonnet-5")).toBe("claude-sonnet-5")
  })

  test("is per Account: two keys of the same provider map differently", () => {
    const first = account({ provider: "zai", modelAliases: { sonnet: "glm-4.7" } })
    const second = account({ provider: "zai", modelAliases: { sonnet: "glm-5.2" } })

    expect(mapModelAlias(first, "sonnet")).toBe("glm-4.7")
    expect(mapModelAlias(second, "sonnet")).toBe("glm-5.2")
  })

  test("matches exactly — it never normalizes case on the upstream's behalf", () => {
    const kimi = account({ provider: "kimi", modelAliases: { sonnet: "k3" } })

    expect(mapModelAlias(kimi, "Sonnet")).toBe("Sonnet")
  })

  test("an empty map is passthrough, not an error", () => {
    expect(mapModelAlias(account({ modelAliases: {} }), "sonnet")).toBe("sonnet")
  })
})

describe("every driver exposes the same mapping", () => {
  test("kimi maps sonnet to k3 when its Account says so", () => {
    const driver = httpDriver("kimi")
    const kimi = account({ provider: "kimi", modelAliases: { sonnet: "k3" } })

    expect(driver?.mapModelAlias(kimi, "sonnet")).toBe("k3")
    expect(driver?.mapModelAlias(kimi, "haiku")).toBe("haiku")
  })

  test("no driver ships default aliases of its own", () => {
    const bare = account({ provider: "openrouter" })

    expect(httpDriver("openrouter")?.mapModelAlias(bare, "sonnet")).toBe("sonnet")
    expect(httpDriver("minimax")?.mapModelAlias(bare, "sonnet")).toBe("sonnet")
  })
})
