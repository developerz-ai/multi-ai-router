/**
 * The whole chain: scope -> intersect -> filter -> policy -> ordered candidates, plus the honest,
 * specific error every empty candidate set produces.
 */

import { describe, expect, test } from "bun:test"
import { RoutingPolicy } from "@multi-ai-router/core"
import type { SelectionRequest, SelectionResult } from "../../../src/services/routing"
import { selectAccounts } from "../../../src/services/routing"
import { account, at, continuous, health, ids, pool, snapshot, subscription } from "./fixtures"

const ask = (overrides: Partial<SelectionRequest> = {}): SelectionRequest => ({
  sessionKey: "session-alpha",
  model: "sonnet",
  keyScope: { kind: "pools", poolIds: ["team"] },
  ...overrides,
})

const expectFailure = (result: SelectionResult) => {
  if (result.ok) throw new Error("expected selection to fail")
  return result
}

const expectSuccess = (result: SelectionResult) => {
  if (!result.ok) throw new Error(`expected selection to succeed: ${result.error.message}`)
  return result
}

describe("the happy path", () => {
  const state = snapshot(
    [account("a"), account("b"), account("c")],
    [pool("team", ["a", "b", "c"])],
  )

  test("returns an ordered list, not a bare pick", () => {
    const result = expectSuccess(selectAccounts(state, ask()))
    expect(ids(result.candidates)).toHaveLength(3)
  })

  test("reports which policy ran and where", () => {
    const result = expectSuccess(selectAccounts(state, ask()))
    expect(result.decision.groups).toEqual([
      {
        poolId: "team",
        poolName: "team",
        policy: "sticky",
        ordered: [...ids(result.candidates)],
        notes: [],
      },
    ])
  })

  test("carries the upstream model name per candidate", () => {
    const aliased = snapshot(
      [account("a", { modelAliases: { sonnet: "glm-4.7" } })],
      [pool("team", ["a"])],
    )
    const result = expectSuccess(selectAccounts(aliased, ask()))
    expect(result.candidates[0]?.upstreamModel).toBe("glm-4.7")
  })

  test("an account in two of the key's pools is one candidate", () => {
    const shared = snapshot(
      [account("a"), account("b")],
      [pool("one", ["a", "b"]), pool("two", ["a"])],
    )
    const result = expectSuccess(
      selectAccounts(shared, ask({ keyScope: { kind: "pools", poolIds: ["one", "two"] } })),
    )
    expect(ids(result.candidates).slice().sort()).toEqual(["a", "b"])
  })
})

describe("the empty candidate set fails by cause", () => {
  test("nothing in the key's scope is 403", () => {
    const state = snapshot([account("a")], [pool("team", [])])
    const result = expectFailure(selectAccounts(state, ask()))

    expect(result.error.status).toBe(403)
    expect(result.error.code).toBe("scope_violation")
  })

  test("everything cooling down is 429 with the earliest reset", () => {
    const state = snapshot(
      [
        account("a", { status: "cooling_down", health: health({ cooldownUntil: at(600_000) }) }),
        account("b", { status: "cooling_down", health: health({ cooldownUntil: at(120_000) }) }),
      ],
      [pool("team", ["a", "b"])],
    )
    const result = expectFailure(selectAccounts(state, ask()))

    expect(result.error.status).toBe(429)
    expect(result.error.message).toContain(at(120_000).toISOString())
    expect(result.error.message).toContain("pool team")
  })

  test("everything out of credits is 402 and names who needs a top-up", () => {
    const state = snapshot(
      [account("a", { status: "exhausted" }), account("b", { status: "exhausted" })],
      [pool("team", ["a", "b"])],
    )
    const result = expectFailure(selectAccounts(state, ask()))

    expect(result.error.status).toBe(402)
    expect(result.error.message).toContain("a, b")
  })

  test("mixed causes take the soonest recoverable one", () => {
    const state = snapshot(
      [
        account("a", { status: "exhausted" }),
        account("b", { status: "cooling_down", health: health({ cooldownUntil: at(60_000) }) }),
      ],
      [pool("team", ["a", "b"])],
    )
    const result = expectFailure(selectAccounts(state, ask()))

    expect(result.error.status).toBe(429)
  })

  test("no account supporting the model is 503, never a generic 500", () => {
    const state = snapshot([account("a", { supportedModels: ["opus"] })], [pool("team", ["a"])])
    const result = expectFailure(selectAccounts(state, ask()))

    expect(result.error.status).toBe(503)
    expect(result.error.code).toBe("no_healthy_account")
  })

  test("the rejection list explains every drop", () => {
    const state = snapshot(
      [account("a", { status: "disabled" }), account("b", { status: "exhausted" })],
      [pool("team", ["a", "b"])],
    )
    const result = expectFailure(selectAccounts(state, ask()))

    expect(result.decision.rejected.map((entry) => entry.reason)).toEqual(["disabled", "exhausted"])
  })
})

describe("scope is never widened", () => {
  test("a key scoped to one account never falls through to a healthy sibling", () => {
    const state = snapshot(
      [
        account("a", { status: "cooling_down", health: health({ cooldownUntil: at(600_000) }) }),
        account("b"),
      ],
      [pool("team", ["a", "b"])],
    )
    const result = expectFailure(
      selectAccounts(state, ask({ keyScope: { kind: "accounts", accountIds: ["a"] } })),
    )

    expect(result.error.status).toBe(429)
    expect(result.decision.scope.inScopeAccountIds).toEqual(["a"])
  })
})

describe("the binding outranks the policy, in the whole chain", () => {
  const state = snapshot(
    [subscription("a"), subscription("b"), subscription("c")],
    [pool("team", ["a", "b", "c"], { policy: "round-robin" })],
  )

  test.each(RoutingPolicy.options)("under %s the bound account is the head", (policy) => {
    const pooled = snapshot(state.accounts, [pool("team", ["a", "b", "c"], { policy })])
    for (const rotationCounter of [0, 1, 2]) {
      const result = expectSuccess(
        selectAccounts(
          pooled,
          ask({ binding: { accountId: "c", sdkSessionId: "sdk-1" }, rotationCounter }),
        ),
      )
      expect(result.candidates[0]?.account.id).toBe("c")
      expect(result.decision.binding).toEqual({ state: "honored", accountId: "c" })
    }
  })

  test("a binding in the second pool still outranks the first pool's head", () => {
    const twoPools = snapshot(state.accounts, [pool("one", ["a", "b"]), pool("two", ["c"])])
    const result = expectSuccess(
      selectAccounts(
        twoPools,
        ask({ keyScope: { kind: "pools", poolIds: ["one", "two"] }, binding: { accountId: "c" } }),
      ),
    )
    expect(result.candidates[0]?.account.id).toBe("c")
  })

  test("a bound account that is cooling down fails honestly rather than moving the session", () => {
    const cooling = snapshot(
      [
        subscription("a", {
          status: "cooling_down",
          health: health({ cooldownUntil: at(300_000) }),
        }),
        subscription("b"),
      ],
      [pool("team", ["a", "b"])],
    )
    const result = expectFailure(selectAccounts(cooling, ask({ binding: { accountId: "a" } })))

    expect(result.error.status).toBe(429)
    expect(result.decision.binding.state).toBe("blocked")
  })

  test("an exhausted bound account invalidates and the session lands elsewhere", () => {
    const dead = snapshot(
      [subscription("a", { status: "exhausted" }), subscription("b")],
      [pool("team", ["a", "b"])],
    )
    const result = expectSuccess(selectAccounts(dead, ask({ binding: { accountId: "a" } })))

    expect(result.decision.binding).toEqual({
      state: "invalidated",
      accountId: "a",
      reason: "exhausted",
    })
    expect(result.candidates[0]?.account.id).toBe("b")
  })
})

describe("overflow", () => {
  const withOverflow = (memberStatus: "active" | "exhausted") =>
    snapshot(
      [account("a", { status: memberStatus }), account("paid")],
      [pool("team", ["a"], { overflowAccountId: "paid" })],
    )

  test("stays invisible while a primary member can serve", () => {
    const result = expectSuccess(selectAccounts(withOverflow("active"), ask()))
    expect(ids(result.candidates)).toEqual(["a"])
    expect(result.decision.usedOverflow).toBe(false)
  })

  test("engages only once the primary set is empty after filtering, and is marked", () => {
    const result = expectSuccess(selectAccounts(withOverflow("exhausted"), ask()))

    expect(ids(result.candidates)).toEqual(["paid"])
    expect(result.decision.usedOverflow).toBe(true)
    expect(result.decision.groups[0]?.notes).toContainEqual({
      kind: "overflow-engaged",
      accountId: "paid",
    })
  })

  test("an overflow account outside the key's scope is not used", () => {
    const result = expectFailure(
      selectAccounts(
        withOverflow("exhausted"),
        ask({ keyScope: { kind: "accounts", accountIds: ["a"] } }),
      ),
    )
    expect(result.error.status).toBe(402)
  })
})

describe("quota-aware through the chain", () => {
  test("degrades detectably when no candidate has a continuous signal", () => {
    const state = snapshot(
      [account("a"), account("b")],
      [pool("team", ["a", "b"], { policy: "quota-aware" })],
    )
    const result = expectSuccess(selectAccounts(state, ask()))

    expect(result.decision.groups[0]?.notes[0]).toEqual({
      kind: "policy-degraded",
      from: "quota-aware",
      to: "round-robin",
      reason: "no-continuous-quota-signal",
      accountIds: ["a", "b"],
    })
  })

  test("ranks on headroom when the signal is there", () => {
    const state = snapshot(
      [
        account("a", { quotaWindows: [continuous(0.9)] }),
        account("b", { quotaWindows: [continuous(0.2)] }),
      ],
      [pool("team", ["a", "b"], { policy: "quota-aware" })],
    )
    const result = expectSuccess(selectAccounts(state, ask()))

    expect(ids(result.candidates)).toEqual(["b", "a"])
  })
})
