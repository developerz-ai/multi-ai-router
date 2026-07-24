/**
 * The six policies: each one's ordering, its determinism, and the two rules that hold for all of
 * them — the binding wins, and a half-open probe ranks behind a healthy account.
 */

import { describe, expect, test } from "bun:test"
import { RoutingPolicy } from "@multi-ai-router/core"
import type { BindingDecision, PolicyInput } from "../../../src/services/routing"
import { runPolicy } from "../../../src/services/routing"
import { account, alarm, candidate, candidates, continuous, health, ids } from "./fixtures"

const input = (overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  candidates: candidates(account("a"), account("b"), account("c")),
  sessionKey: "session-alpha",
  rotationCounter: 0,
  options: {},
  ...overrides,
})

describe("determinism", () => {
  test.each(RoutingPolicy.options)("%s returns the same order for the same input", (policy) => {
    const first = runPolicy(policy, input())
    const second = runPolicy(policy, input())
    expect(ids(first.ordered)).toEqual([...ids(second.ordered)])
  })

  test.each(RoutingPolicy.options)("%s orders every candidate exactly once", (policy) => {
    const ordered = ids(runPolicy(policy, input()).ordered)
    expect([...ordered].sort()).toEqual(["a", "b", "c"])
  })
})

describe("sticky", () => {
  test("a session lands on the same account regardless of candidate order", () => {
    const forward = runPolicy("sticky", input())
    const reversed = runPolicy("sticky", input({ candidates: [...input().candidates].reverse() }))
    expect(ids(forward.ordered)[0]).toBe(ids(reversed.ordered)[0] ?? "")
  })

  test("different sessions spread across the pool", () => {
    const pool = candidates(account("a"), account("b"), account("c"), account("d"))
    const heads = new Set<string>()
    for (let index = 0; index < 200; index += 1) {
      const head = runPolicy("sticky", input({ candidates: pool, sessionKey: `s-${index}` }))
        .ordered[0]
      heads.add(head?.account.id ?? "")
    }
    expect(heads.size).toBe(4)
  })

  test("removing the winner moves that session and leaves the rest of its order intact", () => {
    const pool = candidates(account("a"), account("b"), account("c"), account("d"))
    const full = ids(runPolicy("sticky", input({ candidates: pool })).ordered)
    const without = ids(
      runPolicy(
        "sticky",
        input({ candidates: pool.filter((entry) => entry.account.id !== full[0]) }),
      ).ordered,
    )
    expect(without).toEqual(full.slice(1))
  })
})

describe("round-robin", () => {
  test("the head advances one account per request", () => {
    const heads = [0, 1, 2, 3].map(
      (counter) => runPolicy("round-robin", input({ rotationCounter: counter })).ordered[0],
    )
    expect(heads.map((entry) => entry?.account.id)).toEqual(["a", "b", "c", "a"])
  })

  test("the spread is flat over a run of requests", () => {
    const counts = new Map<string, number>()
    for (let counter = 0; counter < 300; counter += 1) {
      const head = runPolicy("round-robin", input({ rotationCounter: counter })).ordered[0]
      const id = head?.account.id ?? ""
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    expect([...counts.values()]).toEqual([100, 100, 100])
  })
})

describe("weighted", () => {
  const weighted = candidates(account("a"), account("b"), account("c")).map((entry, index) =>
    candidate(entry.account, index, { weight: [3, 1, 1][index] ?? 1 }),
  )

  test("share is proportional to weight", () => {
    const counts = new Map<string, number>()
    for (let counter = 0; counter < 500; counter += 1) {
      const head = runPolicy("weighted", input({ candidates: weighted, rotationCounter: counter }))
        .ordered[0]
      const id = head?.account.id ?? ""
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    expect(counts.get("a")).toBe(300)
    expect(counts.get("b")).toBe(100)
    expect(counts.get("c")).toBe(100)
  })

  test("the failover tail behind the head is heaviest-first", () => {
    const ordered = runPolicy("weighted", input({ candidates: weighted, rotationCounter: 3 }))
    expect(ids(ordered.ordered)).toEqual(["b", "a", "c"])
  })

  test("weights that are all zero degrade to rotation, and say so", () => {
    const flat = weighted.map((entry) => candidate(entry.account, entry.order, { weight: 0 }))
    const result = runPolicy("weighted", input({ candidates: flat, rotationCounter: 1 }))

    expect(ids(result.ordered)).toEqual(["b", "c", "a"])
    expect(result.notes[0]).toEqual({ kind: "weights-absent", accountIds: ["a", "b", "c"] })
  })
})

describe("least-used", () => {
  const loaded = [
    candidate(account("a", { health: health({ inFlight: 5, recentTokens: 10 }) }), 0),
    candidate(account("b", { health: health({ inFlight: 1, recentTokens: 900 }) }), 1),
    candidate(account("c", { health: health({ inFlight: 3, recentTokens: 20 }) }), 2),
  ]

  test("in-flight requests are the default measure", () => {
    expect(ids(runPolicy("least-used", input({ candidates: loaded })).ordered)).toEqual([
      "b",
      "c",
      "a",
    ])
  })

  test("recent token spend is selectable", () => {
    const result = runPolicy(
      "least-used",
      input({ candidates: loaded, options: { leastUsedMeasure: "recent-tokens" } }),
    )
    expect(ids(result.ordered)).toEqual(["a", "c", "b"])
  })

  test("a tie falls back to the other measure, then to the declared order", () => {
    const tied = [
      candidate(account("a", { health: health({ inFlight: 1, recentTokens: 50 }) }), 0),
      candidate(account("b", { health: health({ inFlight: 1, recentTokens: 10 }) }), 1),
    ]
    expect(ids(runPolicy("least-used", input({ candidates: tied })).ordered)).toEqual(["b", "a"])
  })
})

describe("priority-failover", () => {
  test("strict order, lowest priority number first", () => {
    const ranked = [
      candidate(account("a"), 0, { priority: 3 }),
      candidate(account("b"), 1, { priority: 1 }),
      candidate(account("c"), 2, { priority: 2 }),
    ]
    expect(ids(runPolicy("priority-failover", input({ candidates: ranked })).ordered)).toEqual([
      "b",
      "c",
      "a",
    ])
  })

  test("ties fall back to the pool's declared order", () => {
    const tied = [
      candidate(account("b"), 0, { priority: 1 }),
      candidate(account("a"), 1, { priority: 1 }),
    ]
    expect(ids(runPolicy("priority-failover", input({ candidates: tied })).ordered)).toEqual([
      "b",
      "a",
    ])
  })

  test("it does not rotate — the head is the same on every request", () => {
    const ranked = [
      candidate(account("a"), 0, { priority: 1 }),
      candidate(account("b"), 1, { priority: 2 }),
    ]
    for (const counter of [0, 1, 2, 50]) {
      const head = runPolicy(
        "priority-failover",
        input({ candidates: ranked, rotationCounter: counter }),
      ).ordered[0]
      expect(head?.account.id).toBe("a")
    }
  })
})

describe("quota-aware", () => {
  test("ranks by remaining headroom from a continuous signal", () => {
    const pool = [
      candidate(account("a", { quotaWindows: [continuous(0.9)] }), 0),
      candidate(account("b", { quotaWindows: [continuous(0.1)] }), 1),
      candidate(account("c", { quotaWindows: [continuous(0.5)] }), 2),
    ]
    const result = runPolicy("quota-aware", input({ candidates: pool }))

    expect(ids(result.ordered)).toEqual(["b", "c", "a"])
    expect(result.notes).toEqual([
      { kind: "quota-ranked", accountIds: ["b", "c", "a"], unknownAccountIds: [] },
    ])
  })

  test("the account is judged by its most consumed window", () => {
    const pool = [
      candidate(
        account("a", { quotaWindows: [continuous(0.1), continuous(0.95, "seven_day")] }),
        0,
      ),
      candidate(account("b", { quotaWindows: [continuous(0.4)] }), 1),
    ]
    expect(ids(runPolicy("quota-aware", input({ candidates: pool })).ordered)).toEqual(["b", "a"])
  })

  test("a threshold-triggered signal is an alarm, not a gauge — it never ranks", () => {
    const pool = [
      candidate(account("a", { quotaWindows: [alarm(0.95)] }), 0),
      candidate(account("b", { quotaWindows: [alarm(0.1)] }), 1),
    ]
    const result = runPolicy("quota-aware", input({ candidates: pool, rotationCounter: 1 }))

    // Rotated, not ranked: `a` would have come last if the alarm had been treated as a gauge.
    expect(ids(result.ordered)).toEqual(["b", "a"])
    expect(result.notes).toEqual([
      {
        kind: "policy-degraded",
        from: "quota-aware",
        to: "round-robin",
        reason: "no-continuous-quota-signal",
        accountIds: ["b", "a"],
      },
    ])
  })

  test("with no signal at all it degrades detectably rather than pretending to rank", () => {
    const result = runPolicy("quota-aware", input({ rotationCounter: 2 }))

    expect(ids(result.ordered)).toEqual(["c", "a", "b"])
    expect(result.notes[0]?.kind).toBe("policy-degraded")
  })

  test("partial coverage ranks what it can and names what it could not", () => {
    const pool = [
      candidate(account("a", { quotaWindows: [continuous(0.8)] }), 0),
      candidate(account("b"), 1),
      candidate(account("c", { quotaWindows: [continuous(0.2)] }), 2),
    ]
    const result = runPolicy("quota-aware", input({ candidates: pool }))

    expect(ids(result.ordered)).toEqual(["c", "a", "b"])
    expect(result.notes).toEqual([
      { kind: "quota-ranked", accountIds: ["c", "a"], unknownAccountIds: ["b"] },
      {
        kind: "policy-degraded",
        from: "quota-aware",
        to: "round-robin",
        reason: "no-continuous-quota-signal",
        accountIds: ["b"],
      },
    ])
  })
})

describe("rules that hold for every policy", () => {
  const bound: BindingDecision = { state: "honored", accountId: "c" }

  test.each(RoutingPolicy.options)("%s never moves a bound session", (policy) => {
    const result = runPolicy(policy, input(), bound)

    expect(result.ordered[0]?.account.id).toBe("c")
    expect(result.notes).toContainEqual({ kind: "binding-pinned", accountId: "c" })
  })

  test.each(RoutingPolicy.options)(
    "%s holds the binding whatever the load, weight, priority, or counter says",
    (policy) => {
      const stacked = [
        candidate(
          account("a", { health: health({ inFlight: 0 }), quotaWindows: [continuous(0)] }),
          0,
          {
            weight: 1_000,
            priority: 0,
          },
        ),
        candidate(
          account("c", { health: health({ inFlight: 99 }), quotaWindows: [continuous(0.99)] }),
          1,
          { weight: 1, priority: 99 },
        ),
      ]
      for (const rotationCounter of [0, 1, 2, 3]) {
        const result = runPolicy(policy, input({ candidates: stacked, rotationCounter }), bound)
        expect(result.ordered[0]?.account.id).toBe("c")
      }
    },
  )

  test.each(RoutingPolicy.options)(
    "%s ranks a half-open probe behind a healthy account",
    (policy) => {
      const mixed = [
        candidate(account("a"), 0, { halfOpen: true }),
        candidate(account("b"), 1),
        candidate(account("c"), 2, { halfOpen: true }),
      ]
      const result = runPolicy(policy, input({ candidates: mixed }))

      expect(result.ordered[0]?.halfOpen).toBe(false)
      expect(ids(result.ordered.slice(1)).slice().sort()).toEqual(["a", "c"])
      const note = result.notes.find((entry) => entry.kind === "half-open-demoted")
      expect(note?.kind === "half-open-demoted" && [...note.accountIds].sort()).toEqual(["a", "c"])
    },
  )

  test("a binding that is not among the candidates is left alone here", () => {
    const result = runPolicy("sticky", input(), { state: "honored", accountId: "gone" })
    expect(result.notes).toHaveLength(0)
  })
})
