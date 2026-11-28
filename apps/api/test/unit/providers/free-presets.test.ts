import { describe, expect, test } from "bun:test"
import { PROVIDER_REGISTRY } from "../../../src/providers"
import { FREE_PRESETS } from "../../../src/providers/free-presets"
import { checkAccountShape } from "../../../src/services/accounts"

describe("the free presets", () => {
  test("every row is complete enough to paste: https, a key page, and the ids that are free", () => {
    for (const preset of FREE_PRESETS) {
      expect(new URL(preset.baseUrl).protocol, preset.id).toBe("https:")
      expect(new URL(preset.keyUrl).protocol, preset.id).toBe("https:")
      expect(preset.models.length, preset.id).toBeGreaterThan(0)
      expect(new Set(preset.models).size, preset.id).toBe(preset.models.length)
      expect(preset.note.length, preset.id).toBeGreaterThan(0)
    }
    expect(new Set(FREE_PRESETS.map((preset) => preset.id)).size).toBe(FREE_PRESETS.length)
  })

  test("a row never restates a service that has its own driver", () => {
    const pinned = Object.values(PROVIDER_REGISTRY).flatMap((support) => {
      if (support.transport !== "http") return []
      try {
        return [support.driver.resolveBaseUrl({ id: "p", provider: support.driver.id }).host]
      } catch {
        return []
      }
    })
    // z.ai's pinned surfaces are the coding plan's; the free Flash models live on the metered one.
    const overlaps = FREE_PRESETS.filter((preset) => pinned.includes(new URL(preset.baseUrl).host))

    // Three rows reuse a driver's own host on purpose: they are one-click quick-adds that declare
    // the vendor's free model ids and key page, not new drivers. zai-free shares `api.z.ai`;
    // nvidia-free and gemini-free share the router's own `nvidia` / `gemini` driver hosts.
    expect(overlaps.map((preset) => preset.id)).toEqual(["zai-free", "nvidia-free", "gemini-free"])
  })

  test("what the console submits from a row is an account the API accepts", () => {
    for (const preset of FREE_PRESETS) {
      const result = checkAccountShape({
        provider: "openai-compatible",
        hasCredential: true,
        baseUrl: preset.baseUrl,
        configDir: null,
        dialect: null,
      } as Parameters<typeof checkAccountShape>[0])
      expect(result.ok, preset.id).toBe(true)
    }
  })
})
