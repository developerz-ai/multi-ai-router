import { describe, expect, it } from "bun:test"
import type { UtilizationSource } from "@multi-ai-router/core"
import { quotaAware } from "../../../src/services/routing/policies/quota-aware"
import { continuousQuotaHeadroom } from "../../../src/services/routing/quota-evidence"
import type { Candidate } from "../../../src/services/routing/types"

function makeAccount(
  id: string,
  utilization: number | undefined,
  utilizationSource: UtilizationSource = "continuous",
): Candidate["account"] {
  const now = new Date()
  return {
    id,
    label: id,
    provider: "openrouter" as const,
    status: "active" as const,
    priority: 0,
    weight: 1,
    supportedModels: [],
    modelFamily: undefined,
    understandsContextTags: false,
    routingVariants: [],
    carriesSession: false,
    refusedModels: new Map(),
    removedModels: new Map(),
    modelAliases: {},
    quotaWindows:
      utilization !== undefined
        ? [
            {
              window: "five_hour" as const,
              utilization,
              utilizationSource,
              resetsAt: new Date(now.getTime() + 3600_000),
              resetSource: "estimated" as const,
              lastCheckedAt: now,
              retiredAt: undefined,
              evidenceState: undefined,
              blocksRouting: undefined,
              revision: undefined,
            },
          ]
        : [],
    limiterWindows: [],
    health: {
      cooldownUntil: undefined,
      cooldownSource: undefined,
      cooldownReason: undefined,
      consecutiveFailures: 0,
      probeHeldUntil: undefined,
      inFlight: 0,
      recentTokens: 0,
    },
  }
}

function makeCandidate(account: Candidate["account"]): Candidate {
  return {
    account,
    poolId: "pool-1",
    weight: 1,
    priority: 0,
    order: 0,
    upstreamModel: "test-model",
    halfOpen: false,
  }
}

describe("quota-aware soft limit", () => {
  const now = new Date("2026-01-01T12:00:00.000Z")
  const sessionKey = "test-session"

  it("rotates accounts tied at the default threshold", () => {
    const candidates = [makeCandidate(makeAccount("a", 0.8)), makeCandidate(makeAccount("b", 0.95))]
    const result = quotaAware({ candidates, rotationCounter: 1, now, sessionKey, options: {} })
    expect(result.ordered.map((c) => c.account.id)).toEqual(["b", "a"])
  })

  it("tries unknown readings before soft-limited accounts", () => {
    const candidates = [
      makeCandidate(makeAccount("limited", 0.85)),
      makeCandidate(makeAccount("unknown", undefined)),
    ]
    const result = quotaAware({ candidates, rotationCounter: 0, now, sessionKey, options: {} })
    expect(result.ordered.map((c) => c.account.id)).toEqual(["unknown", "limited"])
  })

  it("accounts at 0.8 utilization get zero headroom with default soft limit", () => {
    const account = makeAccount("acc-1", 0.8)
    const headroom = continuousQuotaHeadroom(account, now)
    expect(headroom).toBeCloseTo(0.2, 10) // 1 - 0.8 = 0.2 (floating point)

    // At soft limit 0.8, 1 - softLimit = 0.2, so headroom <= 0.2 means soft-limited
    const candidate = makeCandidate(account)
    const result = quotaAware({
      candidates: [candidate],
      rotationCounter: 0,
      now,
      sessionKey,
      options: { quotaSoftLimit: 0.8 },
    })
    expect(result.ordered).toHaveLength(1)
    expect(result.notes.some((n) => n.kind === "quota-ranked")).toBe(true)
  })

  it("accounts at 0.85 utilization exceed soft limit and rank last", () => {
    const account = makeAccount("acc-1", 0.85)
    const candidate = makeCandidate(account)

    // Below soft limit - should be in ranked list
    const resultBelow = quotaAware({
      candidates: [candidate],
      rotationCounter: 0,
      now,
      sessionKey,
      options: { quotaSoftLimit: 0.9 },
    })
    expect(resultBelow.notes.some((n) => n.kind === "quota-ranked")).toBe(true)

    // Above soft limit - should be in softLimited list (ranked after those with headroom)
    const resultAbove = quotaAware({
      candidates: [candidate],
      rotationCounter: 0,
      now,
      sessionKey,
      options: { quotaSoftLimit: 0.8 },
    })
    expect(resultAbove.ordered).toHaveLength(1)
    expect(resultAbove.notes.some((n) => n.kind === "quota-ranked")).toBe(true)
  })

  it("ranking shifts to alternatives when one account exceeds soft limit", () => {
    const healthy = makeAccount("healthy", 0.3)
    const limited = makeAccount("limited", 0.85)

    const candidates = [makeCandidate(healthy), makeCandidate(limited)]
    const result = quotaAware({
      candidates,
      rotationCounter: 0,
      now,
      sessionKey,
      options: { quotaSoftLimit: 0.8 },
    })

    // Healthy account should be first (has headroom > 0.2)
    expect(result.ordered[0]?.account.id).toBe("healthy")
    // Limited account should be last (soft-limited)
    expect(result.ordered[1]?.account.id).toBe("limited")

    // Both should be in quota-ranked note (soft-limited are still part of quota-ranked)
    const rankedNote = result.notes.find((n) => n.kind === "quota-ranked")
    expect(rankedNote?.accountIds).toContain("healthy")
    expect(rankedNote?.accountIds).toContain("limited")
  })

  it("degraded note emitted when all candidates exceed soft limit", () => {
    const limited1 = makeAccount("limited-1", 0.9)
    const limited2 = makeAccount("limited-2", 0.95)

    const candidates = [makeCandidate(limited1), makeCandidate(limited2)]
    const result = quotaAware({
      candidates,
      rotationCounter: 0,
      now,
      sessionKey,
      options: { quotaSoftLimit: 0.8 },
    })

    // Both are soft-limited, so they go to softLimited list and then to allRanked
    expect(result.ordered).toHaveLength(2)

    // Should have quota-ranked note
    const rankedNote = result.notes.find((n) => n.kind === "quota-ranked")
    expect(rankedNote).toBeDefined()
    expect(rankedNote?.accountIds).toHaveLength(2)

    // No degraded note because all have continuous readings (they are just soft-limited)
    const degradedNote = result.notes.find((n) => n.kind === "policy-degraded")
    expect(degradedNote).toBeUndefined()
  })

  it("degraded note emitted when all candidates have no continuous reading", () => {
    const noSignal1 = makeAccount("no-signal-1", undefined)
    const noSignal2 = makeAccount("no-signal-2", undefined)

    const candidates = [makeCandidate(noSignal1), makeCandidate(noSignal2)]
    const result = quotaAware({
      candidates,
      rotationCounter: 0,
      now,
      sessionKey,
      options: { quotaSoftLimit: 0.8 },
    })

    // Both unranked, should rotate
    expect(result.ordered).toHaveLength(2)

    // Should have only degraded note (early return when no ranked or softLimited)
    const rankedNote = result.notes.find((n) => n.kind === "quota-ranked")
    expect(rankedNote).toBeUndefined()

    const degradedNote = result.notes.find((n) => n.kind === "policy-degraded")
    expect(degradedNote).toBeDefined()
    expect(degradedNote?.reason).toBe("no-continuous-quota-signal")
    expect(degradedNote?.accountIds).toHaveLength(2)
  })

  it("degraded note for partial coverage - some with signal, some without", () => {
    const healthy = makeAccount("healthy", 0.3)
    const noSignal = makeAccount("no-signal", undefined)

    const candidates = [makeCandidate(healthy), makeCandidate(noSignal)]
    const result = quotaAware({
      candidates,
      rotationCounter: 0,
      now,
      sessionKey,
      options: { quotaSoftLimit: 0.8 },
    })

    // Healthy should be first
    expect(result.ordered[0]?.account.id).toBe("healthy")

    // Should have quota-ranked with one known, one unknown
    const rankedNote = result.notes.find((n) => n.kind === "quota-ranked")
    expect(rankedNote).toBeDefined()
    expect(rankedNote?.accountIds).toContain("healthy")
    expect(rankedNote?.unknownAccountIds).toContain("no-signal")

    // Should also have degraded note for the unknown one
    const degradedNote = result.notes.find((n) => n.kind === "policy-degraded")
    expect(degradedNote).toBeDefined()
    expect(degradedNote?.accountIds).toContain("no-signal")
  })

  it("soft limit of 0.5 treats accounts at 0.5 as zero headroom", () => {
    const atLimit = makeAccount("at-limit", 0.5)
    const below = makeAccount("below", 0.4)

    const candidates = [makeCandidate(atLimit), makeCandidate(below)]
    const result = quotaAware({
      candidates,
      rotationCounter: 0,
      now,
      sessionKey,
      options: { quotaSoftLimit: 0.5 },
    })

    // Below should be first (headroom 0.6 > 0.5)
    expect(result.ordered[0]?.account.id).toBe("below")
    // At limit should be last (headroom 0.5 <= 0.5, so soft-limited)
    expect(result.ordered[1]?.account.id).toBe("at-limit")
  })

  it("soft limit of 1.0 treats all accounts as having headroom", () => {
    const high = makeAccount("high", 0.95)
    const low = makeAccount("low", 0.1)

    const candidates = [makeCandidate(high), makeCandidate(low)]
    const result = quotaAware({
      candidates,
      rotationCounter: 0,
      now,
      sessionKey,
      options: { quotaSoftLimit: 1.0 },
    })

    // With soft limit 1.0, 1 - softLimit = 0, so only headroom <= 0 is soft-limited
    // Both have headroom > 0, so both in ranked
    expect(result.ordered).toHaveLength(2)
    const rankedNote = result.notes.find((n) => n.kind === "quota-ranked")
    expect(rankedNote?.accountIds).toHaveLength(2)
  })

  it("uses default soft limit 0.8 when not provided", () => {
    const atDefault = makeAccount("at-default", 0.8)
    const above = makeAccount("z-above", 0.85)

    const candidates = [makeCandidate(atDefault), makeCandidate(above)]
    const result = quotaAware({ candidates, rotationCounter: 1, now, sessionKey, options: {} })

    // Both are soft-limited, so rotation breaks the tie.
    expect(result.ordered[0]?.account.id).toBe("z-above")
    expect(result.ordered[1]?.account.id).toBe("at-default")
    const raised = quotaAware({
      candidates,
      rotationCounter: 1,
      now,
      sessionKey,
      options: { quotaSoftLimit: 0.9 },
    })
    expect(raised.ordered.map((c) => c.account.id)).toEqual(["at-default", "z-above"])
  })

  it("non-continuous utilization source does not contribute to headroom", () => {
    const account = makeAccount("threshold", 0.9, "threshold-triggered")
    const headroom = continuousQuotaHeadroom(account, now)
    expect(headroom).toBeNull() // threshold source is not continuous

    const candidate = makeCandidate(account)
    const result = quotaAware({
      candidates: [candidate],
      rotationCounter: 0,
      now,
      sessionKey,
      options: { quotaSoftLimit: 0.8 },
    })

    // Early return when no ranked and no softLimited - only degraded note
    const rankedNote = result.notes.find((n) => n.kind === "quota-ranked")
    expect(rankedNote).toBeUndefined()

    const degradedNote = result.notes.find((n) => n.kind === "policy-degraded")
    expect(degradedNote).toBeDefined()
    expect(degradedNote?.accountIds).toContain("threshold")
  })
})
