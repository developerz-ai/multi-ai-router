import { describe, expect, test } from "bun:test"
import { AUDIT_KINDS, AUDIT_SUBJECTS, validate } from "../../../src/services/admin"
import {
  diffPriceOverrides,
  MAX_PRICE_OVERRIDES,
  PRICE_OVERRIDES_SETTING,
  updatePriceOverridesBody,
} from "../../../src/services/settings"
import { flush, harness, NOW } from "./fixtures"

/**
 * The one writable thing on the settings screen. Two rules carry the weight: the array is the
 * complete set (so `[]` clears the table), and the audit event it writes records counts, never the
 * rates themselves.
 */

const RATE = {
  inputPerMtok: 12.5,
  outputPerMtok: 33.75,
  cacheReadPerMtok: 1.25,
  cacheWritePerMtok: 15.625,
}

function body(rows: readonly unknown[]) {
  return validate(updatePriceOverridesBody, { priceOverrides: rows })
}

describe("the write contract", () => {
  test("accepts a well-formed row and normalizes the model to trimmed lowercase", () => {
    const parsed = body([{ provider: "anthropic-api", model: "  Claude-Sonnet-5 ", ...RATE }])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.priceOverrides[0]?.model).toBe("claude-sonnet-5")
  })

  test("rejects a provider that is not a ProviderId", () => {
    const parsed = body([{ provider: "acme-llm", model: "big", ...RATE }])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.failure.status).toBe(400)
  })

  test("rejects the same provider and model twice, naming the pair", () => {
    const parsed = body([
      { provider: "anthropic-api", model: "claude-sonnet-5", ...RATE },
      // Different casing on purpose: normalization runs first, so this is the same pair.
      { provider: "anthropic-api", model: "Claude-Sonnet-5", ...RATE },
    ])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.failure.status).toBe(400)
      expect(parsed.failure.message).toContain("anthropic-api/claude-sonnet-5")
    }
  })

  test("allows one model under two providers — the same name costs different money upstream", () => {
    const parsed = body([
      { provider: "anthropic-api", model: "claude-sonnet-5", ...RATE },
      { provider: "anthropic-oauth", model: "claude-sonnet-5", ...RATE },
    ])
    expect(parsed.ok).toBe(true)
  })

  test("rejects a negative rate", () => {
    const parsed = body([{ provider: "zai", model: "glm", ...RATE, inputPerMtok: -1 }])
    expect(parsed.ok).toBe(false)
  })

  test("rejects a rate that is not a finite number", () => {
    expect(body([{ provider: "zai", model: "glm", ...RATE, outputPerMtok: Infinity }]).ok).toBe(
      false,
    )
    expect(body([{ provider: "zai", model: "glm", ...RATE, outputPerMtok: "3" }]).ok).toBe(false)
  })

  test("rejects a rate above the ceiling the numeric column can hold", () => {
    expect(body([{ provider: "zai", model: "glm", ...RATE, inputPerMtok: 10_001 }]).ok).toBe(false)
  })

  test("rejects an empty model and one over 200 characters", () => {
    expect(body([{ provider: "zai", model: "   ", ...RATE }]).ok).toBe(false)
    expect(body([{ provider: "zai", model: "m".repeat(201), ...RATE }]).ok).toBe(false)
    expect(body([{ provider: "zai", model: "m".repeat(200), ...RATE }]).ok).toBe(true)
  })

  test("rejects an array longer than the per-request cap", () => {
    const row = (index: number) => ({ provider: "zai", model: `glm-${index}`, ...RATE })
    const rows = Array.from({ length: MAX_PRICE_OVERRIDES + 1 }, (_, index) => row(index))
    expect(body(rows).ok).toBe(false)
    expect(body(rows.slice(0, MAX_PRICE_OVERRIDES)).ok).toBe(true)
  })

  test("accepts an empty array — it is how the table is cleared", () => {
    expect(body([]).ok).toBe(true)
  })

  test("rejects an unknown field rather than dropping it silently", () => {
    expect(body([{ provider: "zai", model: "glm", ...RATE, perRequest: 1 }]).ok).toBe(false)
  })
})

describe("the update", () => {
  test("replaces the whole set and stamps it with the injected clock", async () => {
    const { service, prices } = harness({
      prices: [{ provider: "zai", model: "glm-old", ...RATE }],
    })
    const result = await service.update({
      priceOverrides: [{ provider: "anthropic-api", model: "claude-sonnet-5", ...RATE }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.prices.overrides).toEqual([
      {
        provider: "anthropic-api",
        model: "claude-sonnet-5",
        ...RATE,
        updatedAt: NOW.toISOString(),
      },
    ])
    expect(prices.rows.map((row) => row.model)).toEqual(["claude-sonnet-5"])
  })

  test("an empty array clears every override", async () => {
    const { service, prices } = harness({
      prices: [
        { provider: "zai", model: "glm", ...RATE },
        { provider: "kimi", model: "k2", ...RATE },
      ],
    })
    const result = await service.update({ priceOverrides: [] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.prices.overrides).toEqual([])
    expect(prices.rows).toHaveLength(0)
    // Clearing overrides never clears the shipped fallback.
    expect(result.value.prices.shipped.length).toBeGreaterThan(0)
  })

  test("awaits onPricesChanged before it resolves, so the request path prices the new rate first", async () => {
    const order: string[] = []
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const { service } = harness({
      onAudit: () => order.push("audited"),
      onPricesChanged: async () => {
        await gate
        order.push("refreshed")
      },
    })

    const pending = service.update({ priceOverrides: [] }).then((result) => {
      order.push("resolved")
      return result
    })

    await flush()
    expect(order).toEqual([])

    release()
    await pending
    expect(order).toEqual(["refreshed", "audited", "resolved"])
  })

  test("writes one settings.changed event carrying counts and no rate values", async () => {
    const { service, audit } = harness({
      prices: [
        { provider: "zai", model: "glm", ...RATE },
        { provider: "kimi", model: "k2", ...RATE },
      ],
    })
    await service.update({
      priceOverrides: [
        // one unchanged, one repriced, one new, one dropped
        { provider: "zai", model: "glm", ...RATE },
        { provider: "kimi", model: "k2", ...RATE, inputPerMtok: 99 },
        { provider: "minimax", model: "abab", ...RATE },
      ],
    })

    expect(audit.events).toHaveLength(1)
    const recorded = audit.events[0]
    expect(recorded?.kind).toBe(AUDIT_KINDS.settingsChanged)
    expect(recorded?.subjectType).toBe(AUDIT_SUBJECTS.settings)
    expect(recorded?.subjectId).toBe(PRICE_OVERRIDES_SETTING)
    expect(recorded?.detail).toEqual({
      setting: "price_overrides",
      added: 1,
      removed: 0,
      changed: 1,
    })

    // Nothing that could be read as a price is on the event.
    const serialized = JSON.stringify(recorded?.detail)
    for (const rate of [12.5, 33.75, 1.25, 15.625, 99]) {
      expect(serialized).not.toContain(String(rate))
    }
  })
})

describe("the diff behind those counts", () => {
  const row = (model: string, inputPerMtok: number) => ({
    provider: "zai" as const,
    model,
    ...RATE,
    inputPerMtok,
  })

  test("counts an added, a removed, a repriced and an untouched row separately", () => {
    const before = [row("a", 1), row("b", 2), row("c", 3)]
    const after = [row("a", 1), row("b", 9), row("d", 4)]
    expect(diffPriceOverrides(before, after)).toEqual({ added: 1, removed: 1, changed: 1 })
  })

  test("re-saving an untouched table counts as nothing at all", () => {
    const rows = [row("a", 1), row("b", 2)]
    expect(diffPriceOverrides(rows, rows)).toEqual({ added: 0, removed: 0, changed: 0 })
  })

  test("clearing the table counts every row as removed", () => {
    expect(diffPriceOverrides([row("a", 1), row("b", 2)], [])).toEqual({
      added: 0,
      removed: 2,
      changed: 0,
    })
  })
})
