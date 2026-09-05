/**
 * A Claude subscription pool under the rotation policies, end to end through `selectAccounts`.
 *
 * The spec once called `round-robin` / `weighted` / `least-used` "unsafe as-is" on an
 * `anthropic-oauth` pool because they ignore session identity. The code does not: `decideBinding`
 * runs before any policy, and `runPolicy` pins a honored binding at the head of whatever the
 * policy ordered (`policies/index.ts`). The policies only ever place a session that has no binding
 * or whose binding was invalidated. These pin that, on the shape the operator runs — six
 * subscriptions, twenty coding agents — so the doc cannot drift back.
 */

import { describe, expect, test } from "bun:test"
import type { SelectionRequest, SelectionResult } from "../../../src/services/routing"
import { selectAccounts } from "../../../src/services/routing"
import { at, health, pool, snapshot, subscription } from "./fixtures"

const SUBS = ["sub-1", "sub-2", "sub-3", "sub-4", "sub-5", "sub-6"] as const

const ask = (overrides: Partial<SelectionRequest> = {}): SelectionRequest => ({
  sessionKey: "agent-1",
  model: "claude-opus-5",
  keyScope: { kind: "pools", poolIds: ["claude-subs"] },
  ...overrides,
})

const roundRobin = snapshot(
  SUBS.map((id) => subscription(id)),
  [pool("claude-subs", SUBS, { policy: "round-robin" })],
)

const expectSuccess = (result: SelectionResult) => {
  if (!result.ok) throw new Error(`expected selection to succeed: ${result.error.message}`)
  return result
}

const expectFailure = (result: SelectionResult) => {
  if (result.ok) throw new Error("expected selection to fail")
  return result
}

/** Where the k-th new session lands: the pool's counter has advanced once per placed session. */
function headFor(sessionIndex: number, state = roundRobin): string {
  const rotated = snapshot(state.accounts, [
    pool("claude-subs", SUBS, { policy: "round-robin", rotationCounter: sessionIndex }),
  ])
  const result = expectSuccess(
    selectAccounts(rotated, ask({ sessionKey: `agent-${sessionIndex}` })),
  )
  const head = result.candidates[0]?.account.id
  if (head === undefined) throw new Error("no head")
  return head
}

describe("round-robin on a six-subscription pool", () => {
  test("twenty new sessions land three or four per subscription", () => {
    const perAccount = new Map<string, number>()
    for (let session = 0; session < 20; session += 1) {
      const head = headFor(session)
      perAccount.set(head, (perAccount.get(head) ?? 0) + 1)
    }

    expect([...perAccount.keys()].sort()).toEqual([...SUBS])
    for (const count of perAccount.values()) {
      expect(count).toBeGreaterThanOrEqual(3)
      expect(count).toBeLessThanOrEqual(4)
    }
  })

  test("consecutive new sessions land on consecutive subscriptions", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((session) => headFor(session))).toEqual([
      "sub-1",
      "sub-2",
      "sub-3",
      "sub-4",
      "sub-5",
      "sub-6",
      "sub-1",
    ])
  })

  test("a bound session keeps its subscription whatever the counter says", () => {
    for (const rotationCounter of [0, 1, 2, 3, 4, 5, 17]) {
      const rotated = snapshot(roundRobin.accounts, [
        pool("claude-subs", SUBS, { policy: "round-robin", rotationCounter }),
      ])
      const result = expectSuccess(
        selectAccounts(rotated, ask({ binding: { accountId: "sub-4", sdkSessionId: "sess-4" } })),
      )
      expect(result.candidates[0]?.account.id).toBe("sub-4")
      expect(result.decision.binding).toEqual({ state: "honored", accountId: "sub-4" })
      expect(result.decision.groups[0]?.notes).toContainEqual({
        kind: "binding-pinned",
        accountId: "sub-4",
      })
    }
  })

  test("the failover tail behind a bound head is still the rotation, minus the head", () => {
    const rotated = snapshot(roundRobin.accounts, [
      pool("claude-subs", SUBS, { policy: "round-robin", rotationCounter: 2 }),
    ])
    const result = expectSuccess(
      selectAccounts(rotated, ask({ binding: { accountId: "sub-5", sdkSessionId: "sess-5" } })),
    )
    expect(result.candidates.map((candidate) => candidate.account.id)).toEqual([
      "sub-5",
      "sub-3",
      "sub-4",
      "sub-6",
      "sub-1",
      "sub-2",
    ])
  })
})

describe("a bound subscription that ran out of quota", () => {
  const cooling = snapshot(
    SUBS.map((id) =>
      id === "sub-2"
        ? subscription(id, {
            status: "cooling_down",
            health: health({ cooldownUntil: at(1_800_000), cooldownSource: "provider-reported" }),
          })
        : subscription(id),
    ),
    [pool("claude-subs", SUBS, { policy: "round-robin", rotationCounter: 9 })],
  )
  const bound = ask({ binding: { accountId: "sub-2", sdkSessionId: "sess-2" } })

  test("`fail` (the default) keeps the binding and answers 429 with the reset", () => {
    const result = expectFailure(selectAccounts(cooling, bound))

    expect(result.error.status).toBe(429)
    expect(result.decision.binding).toMatchObject({
      state: "blocked",
      accountId: "sub-2",
      reason: "cooling-down",
      resetsAt: at(1_800_000),
    })
  })

  test("`rebind` drops the binding and the rotation places the session on another subscription", () => {
    const result = expectSuccess(
      selectAccounts(cooling, bound, { boundAccountCoolingDown: "rebind" }),
    )

    expect(result.decision.binding).toEqual({
      state: "invalidated",
      accountId: "sub-2",
      reason: "cooling-down",
    })
    // The cooling account is not in the chain at all: it was filtered before the policy ran.
    const chain = result.candidates.map((candidate) => candidate.account.id)
    expect(chain).not.toContain("sub-2")
    expect(chain).toHaveLength(5)
    // Counter 9 over the five remaining, in declared order: 9 mod 5 = 4 -> `sub-6` heads.
    expect(chain[0]).toBe("sub-6")
  })

  test("a new session never lands on the cooling subscription", () => {
    for (let session = 0; session < 20; session += 1) {
      const rotated = snapshot(cooling.accounts, [
        pool("claude-subs", SUBS, { policy: "round-robin", rotationCounter: session }),
      ])
      const result = expectSuccess(selectAccounts(rotated, ask({ sessionKey: `agent-${session}` })))
      expect(result.candidates[0]?.account.id).not.toBe("sub-2")
    }
  })

  test("a bound subscription that needs re-auth is invalidated, not blocked — no clock returns it", () => {
    const expired = snapshot(
      SUBS.map((id) =>
        id === "sub-2" ? subscription(id, { status: "needs_reauth" }) : subscription(id),
      ),
      [pool("claude-subs", SUBS, { policy: "round-robin" })],
    )
    const result = expectSuccess(selectAccounts(expired, bound))

    expect(result.decision.binding).toEqual({
      state: "invalidated",
      accountId: "sub-2",
      reason: "needs-reauth",
    })
    expect(result.candidates.map((candidate) => candidate.account.id)).not.toContain("sub-2")
  })
})

describe("the other rotation policies respect the binding the same way", () => {
  test.each(["weighted", "least-used", "quota-aware"] as const)(
    "%s pins a bound subscription ahead of its own ordering",
    (policy) => {
      const busy = snapshot(
        SUBS.map((id, index) =>
          // Make the bound account the policy's *worst* choice: heaviest load, lightest weight.
          subscription(id, {
            weight: id === "sub-3" ? 1 : 1_000,
            health: health({ inFlight: id === "sub-3" ? 50 : index }),
          }),
        ),
        [pool("claude-subs", SUBS, { policy, rotationCounter: 4 })],
      )
      const result = expectSuccess(
        selectAccounts(busy, ask({ binding: { accountId: "sub-3", sdkSessionId: "sess-3" } })),
      )
      expect(result.candidates[0]?.account.id).toBe("sub-3")
    },
  )

  test("`least-used` is implemented: in-flight first, and an unbound session lands on the idlest", () => {
    const loaded = snapshot(
      SUBS.map((id, index) => subscription(id, { health: health({ inFlight: 5 - index }) })),
      [pool("claude-subs", SUBS, { policy: "least-used" })],
    )
    const result = expectSuccess(selectAccounts(loaded, ask()))
    expect(result.candidates[0]?.account.id).toBe("sub-6")
    expect(result.decision.groups[0]?.policy).toBe("least-used")
  })
})
