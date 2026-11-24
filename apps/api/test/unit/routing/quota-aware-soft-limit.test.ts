import { describe, expect, test } from "bun:test"
import type { AccountSnapshot } from "@multi-ai-router/core"
import { filterCandidates } from "../../../src/services/routing/filter"
import { quotaAware } from "../../../src/services/routing/policies/quota-aware"
import type { SelectionOptions } from "../../../src/services/routing/types"
import { account, candidate, continuous } from "./fixtures"

const NOW = new Date("2026-07-25T12:00:00.000Z")

function member(utilization: number, id = "acc") {
  const acc = account(id, { health: {}, quotaWindows: [continuous(utilization)] })
  return scoped(acc, 0)
}

function scoped(acc: AccountSnapshot, order: number) {
  return {
    account: acc,
    poolId: null,
    weight: acc.weight,
    priority: acc.priority,
    order,
  }
}

function opts(quotaSoftLimit?: number): SelectionOptions {
  return { quotaSoftLimit }
}

function eligible(result: { readonly eligible: { readonly account: { readonly id: string } }[] }) {
  return result.eligible.map((c) => c.account.id)
}

describe("quotaSoftLimit universal soft limit", () => {
  test("drops an account at or above the pool soft limit", () => {
    const above = member(0.82, "above")
    const below = member(0.5, "below")
    const verdicts = filterCandidates([above, below], "sonnet", NOW, opts(0.8))

    expect(eligible(verdicts)).toEqual(["below"])
    expect(eligible(verdicts)).not.toContain("above")
  })

  test("keeps an account below the soft limit", () => {
    const below = member(0.49, "below")
    const verdicts = filterCandidates([below], "sonnet", NOW, opts(0.8))
    expect(eligible(verdicts)).toEqual(["below"])
  })

  test("uses DEFAULT_QUOTA_SOFT_LIMIT (0.8) when unset", () => {
    const atLimit = member(0.8, "at-limit")
    const below = member(0.3, "below")
    const verdicts = filterCandidates([atLimit, below], "sonnet", NOW, opts())
    expect(eligible(verdicts)).toEqual(["below"])
  })
})

describe("quotaAware ranking respects soft limit regardless of policy", () => {
  test("ranks soft-limited accounts behind ones below it", () => {
    const above = candidate(account("above", { quotaWindows: [continuous(0.9)] }), 0)
    const below = candidate(account("below", { quotaWindows: [continuous(0.2)] }), 1)
    const selected = quotaAware({
      candidates: [above, below],
      now: NOW,
      options: { quotaSoftLimit: 0.8 },
    })
    expect(selected.ordered[0].account.id).toBe("below")
  })

  test("falls back to headroom ordering among below-limit accounts", () => {
    const high = candidate(account("high", { quotaWindows: [continuous(0.79)] }), 0)
    const low = candidate(account("low", { quotaWindows: [continuous(0.1)] }), 1)
    const selected = quotaAware({
      candidates: [high, low],
      now: NOW,
      options: { quotaSoftLimit: 0.8 },
    })
    expect(selected.ordered[0].account.id).toBe("low")
  })
})
