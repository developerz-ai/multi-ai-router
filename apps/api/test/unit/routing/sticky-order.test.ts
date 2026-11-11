import { expect, test } from "bun:test"
import {
  rendezvousRank,
  runPolicy,
  scoreWithSeed,
  sessionSeed,
} from "../../../src/services/routing"
import { account, candidate, ids, NOW } from "./fixtures"

// Plan 101, 03.6: scoring once per candidate must order exactly as the per-comparison scoring did.
test("sticky's decorate-sort orders exactly as the per-comparison comparator", () => {
  const pool = Array.from({ length: 50 }, (_, index) =>
    candidate(account(`acct-${(index * 7919) % 1000}`), index % 5),
  )
  for (const sessionKey of ["alpha", "beta", "gamma", "", "s-42"]) {
    const seed = sessionSeed(sessionKey)
    const expected = [...pool]
      .sort((left, right) => {
        const delta = scoreWithSeed(seed, right.account.id) - scoreWithSeed(seed, left.account.id)
        if (delta !== 0) return delta
        if (left.order !== right.order) return left.order - right.order
        return left.account.id < right.account.id ? -1 : 1
      })
      .map((entry) => entry.account.id)
    const result = runPolicy("sticky", {
      now: NOW,
      candidates: pool,
      sessionKey,
      rotationCounter: 0,
      options: {},
    })
    expect(ids(result.ordered)).toEqual(expected)
    const rank = rendezvousRank(
      sessionKey,
      pool.map((entry) => entry.account.id),
    )
    expect(rank).toEqual(
      [...pool.map((entry) => entry.account.id)].sort(
        (left, right) =>
          scoreWithSeed(seed, right) - scoreWithSeed(seed, left) || (left < right ? -1 : 1),
      ),
    )
  }
})
