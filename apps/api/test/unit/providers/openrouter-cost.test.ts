import { describe, expect, test } from "bun:test"
import { readOpenRouterCost } from "../../../src/providers/drivers/openrouter-cost"

/**
 * OpenRouter's own statement of what an attempt cost (`usage.cost`, USD credits). Prod 2026-11-19..26:
 * 144k `openrouter` attempts recorded `unknown` because nothing read it.
 */

const usage = (fields: Record<string, unknown>) => ({
  prompt_tokens: 1_000,
  completion_tokens: 50,
  ...fields,
})

describe("a figure nobody can book is no figure", () => {
  test("absent, null, a string, negative, or infinite reads as undefined", () => {
    for (const cost of [undefined, null, "0.01", -0.01, Number.POSITIVE_INFINITY, Number.NaN, {}])
      expect(readOpenRouterCost(usage({ cost }))).toBeUndefined()
  })

  test("JSON's overflowing literal is caught too", () => {
    const parsed = JSON.parse('{"cost":1e999}') as Record<string, unknown>
    expect(readOpenRouterCost(parsed)).toBeUndefined()
  })

  test("a BYOK statement with no readable provider share is unknown, not the fee alone", () => {
    expect(readOpenRouterCost(usage({ cost: 0.001, is_byok: true }))).toBeUndefined()
    expect(
      readOpenRouterCost(
        usage({ cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: null } }),
      ),
    ).toBeUndefined()
    expect(
      readOpenRouterCost(
        usage({ cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: "0.02" } }),
      ),
    ).toBeUndefined()
  })
})

describe("what OpenRouter billed", () => {
  test("the stated cost, as stated", () => {
    expect(readOpenRouterCost(usage({ cost: 0.012345 }))).toBe(0.012345)
  })

  test("zero is a measurement: a :free route billed nothing", () => {
    expect(readOpenRouterCost(usage({ cost: 0 }))).toBe(0)
  })

  test("off BYOK, the upstream share is informational and never added", () => {
    expect(
      readOpenRouterCost(
        usage({ cost: 0.5, is_byok: false, cost_details: { upstream_inference_cost: 0.48 } }),
      ),
    ).toBe(0.5)
  })

  test("on BYOK, the fee plus what the provider charged the key", () => {
    expect(
      readOpenRouterCost(
        usage({ cost: 0.25, is_byok: true, cost_details: { upstream_inference_cost: 5 } }),
      ),
    ).toBe(5.25)
  })
})
