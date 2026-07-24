/**
 * Rendezvous hashing is **pinned**.
 *
 * The literals below were captured from the reference implementation when it landed. If a change
 * to the mix makes them fail, that is the test doing its job: every unbound session would
 * reshuffle onto a cold account on upgrade. That ships as a breaking change with a migration
 * note — never as a casually updated expectation.
 */

import { describe, expect, test } from "bun:test"
import {
  rendezvousRank,
  rendezvousScore,
  scoreWithSeed,
  sessionSeed,
} from "../../../src/services/routing"

const POOL = ["acct-1", "acct-2", "acct-3", "acct-4", "acct-5"] as const

const SCORE_VECTORS: readonly [string, string, number][] = [
  ["session-alpha", "acct-1", 0.4661939078526419],
  ["session-alpha", "acct-2", 0.48191378480174585],
  ["session-alpha", "acct-3", 0.6841121673061532],
  ["session-beta", "acct-1", 0.4867161464457558],
  ["session-beta", "acct-2", 0.5788275768931094],
  ["session-beta", "acct-3", 0.9709629402917526],
  ["", "acct-1", 0.9905320146682395],
  ["sha256:9f2c", "claude-max-seb", 0.4055751213519252],
]

const RANK_VECTORS: readonly [string, readonly string[]][] = [
  ["session-alpha", ["acct-3", "acct-5", "acct-2", "acct-1", "acct-4"]],
  ["session-beta", ["acct-3", "acct-5", "acct-2", "acct-1", "acct-4"]],
  ["session-gamma", ["acct-5", "acct-4", "acct-3", "acct-2", "acct-1"]],
  ["session-delta", ["acct-5", "acct-2", "acct-1", "acct-3", "acct-4"]],
  ["session-epsilon", ["acct-5", "acct-2", "acct-1", "acct-3", "acct-4"]],
]

describe("pinned hash vectors", () => {
  test.each(SCORE_VECTORS)("score(%p, %p) is pinned", (sessionKey, accountId, expected) => {
    expect(rendezvousScore(sessionKey, accountId)).toBe(expected)
  })

  test.each(RANK_VECTORS)("rank(%p) is pinned", (sessionKey, expected) => {
    expect(rendezvousRank(sessionKey, POOL)).toEqual([...expected])
  })
})

describe("rendezvous properties", () => {
  test("scores land in [0, 1)", () => {
    for (let index = 0; index < 500; index += 1) {
      const score = rendezvousScore(`session-${index}`, "acct-1")
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThan(1)
    }
  })

  test("the pre-folded seed and the one-shot form agree", () => {
    const seed = sessionSeed("session-alpha")
    for (const accountId of POOL) {
      expect(scoreWithSeed(seed, accountId)).toBe(rendezvousScore("session-alpha", accountId))
    }
  })

  test("ranking is independent of the order the candidates arrive in", () => {
    const forward = rendezvousRank("session-alpha", POOL)
    const reversed = rendezvousRank("session-alpha", [...POOL].reverse())
    expect(reversed).toEqual([...forward])
  })

  test("placement spreads sessions evenly across the pool", () => {
    const counts = new Map<string, number>()
    for (let index = 0; index < 10_000; index += 1) {
      const winner = rendezvousRank(`session-${index}`, POOL)[0] ?? "none"
      counts.set(winner, (counts.get(winner) ?? 0) + 1)
    }

    expect([...counts.keys()].sort()).toEqual([...POOL])
    for (const count of counts.values()) {
      // 2000 expected per account; a 15% band is loose enough to be stable and tight enough to
      // catch a mix that collapses onto one account.
      expect(count).toBeGreaterThan(1_700)
      expect(count).toBeLessThan(2_300)
    }
  })
})

describe("minimal disruption", () => {
  const placements = (accounts: readonly string[]): Map<string, string> => {
    const map = new Map<string, string>()
    for (let index = 0; index < 2_000; index += 1) {
      const key = `session-${index}`
      map.set(key, rendezvousRank(key, accounts)[0] ?? "none")
    }
    return map
  }

  test("adding an account only moves the sessions that hash to it", () => {
    const before = placements(POOL)
    const after = placements([...POOL, "acct-6"])

    let moved = 0
    for (const [key, account] of before) {
      const now = after.get(key)
      if (now === account) continue
      moved += 1
      // Everything that moved landed on the new account. Nothing was shuffled between the
      // accounts that were already there.
      expect(now).toBe("acct-6")
    }

    expect(moved).toBeGreaterThan(0)
    // Roughly one sixth of 2000. A mix that reshuffled everything would blow through this.
    expect(moved).toBeLessThan(450)
  })

  test("removing an account only reassigns that account's sessions", () => {
    const before = placements(POOL)
    const after = placements(POOL.filter((id) => id !== "acct-3"))

    for (const [key, account] of before) {
      if (account === "acct-3") {
        expect(after.get(key)).not.toBe("acct-3")
        continue
      }
      expect(after.get(key)).toBe(account)
    }
  })
})
