/**
 * The whole chain: scope -> intersect -> filter -> policy -> ordered candidates, plus the honest,
 * specific error every empty candidate set produces.
 */

import { describe, expect, test } from "bun:test"
import { QuotaExhaustedError, RoutingPolicy } from "@multi-ai-router/core"
import type { SelectionRequest, SelectionResult } from "../../../src/services/routing"
import {
  DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS,
  selectAccounts,
} from "../../../src/services/routing"
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

  test("a pool whose only account is being probed is 429, never a 503 or a stampede", () => {
    // The bug this pins: the reset instant passing made the account eligible to every waiting
    // request at once. Now one holds the probe and the rest are told to come back — with a wait,
    // because a clock fixes this in milliseconds and nothing here needs a human.
    const state = snapshot(
      [
        account("a", {
          status: "cooling_down",
          health: health({ cooldownUntil: at(-1_000), probeHeldUntil: at(20_000) }),
        }),
      ],
      [pool("team", ["a"])],
    )
    const result = expectFailure(selectAccounts(state, ask()))

    expect(result.error.status).toBe(429)
    expect(result.error.message).toContain(at(20_000).toISOString())
    expect(result.decision.rejected[0]?.reason).toBe("probe-in-flight")
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

  test("mixed causes take the soonest recoverable one, and name both groups honestly", () => {
    const state = snapshot(
      [
        account("a", { status: "exhausted" }),
        account("b", { status: "cooling_down", health: health({ cooldownUntil: at(60_000) }) }),
      ],
      [pool("team", ["a", "b"])],
    )
    const result = expectFailure(selectAccounts(state, ask()))

    expect(result.error.status).toBe(429)
    // The count and the "rate limited" label describe only the recoverable one — not both.
    expect(result.error.message).toContain("1 of 2 accounts")
    expect(result.error.message).toContain("rate limited or out of quota (b)")
    // The exhausted one is still named, not buried behind the 429.
    expect(result.error.message).toContain("needs a top-up (a)")
  })

  test("a cooling_down account with no recorded reset still gets a 429 with Retry-After", () => {
    // `filter.ts` admits this state (status cooling_down, no cooldownUntil) as still cooling —
    // never having gone through the breaker's own trip(). The reset instant is genuinely unknown,
    // but cooling_down must never render as a 429 with no Retry-After (non-negotiable 7). The
    // wait is a *pause*, not a countdown: no clock is scheduled to clear this state, and the old
    // 1-second floor had every waiting client retrying once a second forever.
    const state = snapshot(
      [account("a", { status: "cooling_down", health: health() })],
      [pool("team", ["a"])],
    )
    const result = expectFailure(selectAccounts(state, ask()))

    expect(result.error.status).toBe(429)
    expect(result.error.code).toBe("quota_exhausted")
    expect(result.error).toBeInstanceOf(QuotaExhaustedError)
    expect((result.error as QuotaExhaustedError).retryAfterSeconds).toBe(
      DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS,
    )
  })

  test("the unknown-reset wait is config, not a constant", () => {
    const state = snapshot(
      [account("a", { status: "cooling_down", health: health() })],
      [pool("team", ["a"])],
    )
    const result = expectFailure(
      selectAccounts(state, ask(), { unknownResetRetryAfterSeconds: 120 }),
    )

    expect((result.error as QuotaExhaustedError).retryAfterSeconds).toBe(120)
  })

  test("an estimated reset is labeled as one, never presented as the provider's word", () => {
    // The breaker computed this instant from its own backoff schedule (`cooldownSource:
    // "estimated"`). Rendering it bare would present arithmetic as fact.
    const state = snapshot(
      [
        account("a", {
          status: "cooling_down",
          health: health({ cooldownUntil: at(60_000), cooldownSource: "estimated" }),
        }),
      ],
      [pool("team", ["a"])],
    )
    const result = expectFailure(selectAccounts(state, ask()))

    expect(result.error.message).toContain(`${at(60_000).toISOString()} (estimated)`)
  })

  test("five accounts, one recoverable and four exhausted, never reads as everyone rate limited", () => {
    const state = snapshot(
      [
        account("a", { status: "cooling_down", health: health({ cooldownUntil: at(60_000) }) }),
        account("b", { status: "exhausted" }),
        account("c", { status: "exhausted" }),
        account("d", { status: "exhausted" }),
        account("e", { status: "exhausted" }),
      ],
      [pool("team", ["a", "b", "c", "d", "e"])],
    )
    const result = expectFailure(selectAccounts(state, ask()))

    expect(result.error.status).toBe(429)
    expect(result.error.message).toContain("1 of 5 accounts")
    expect(result.error.message).not.toContain("5 accounts are rate limited")
    expect(result.error.message).toContain("b, c, d, e")
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

  test("a bound account blocked by a spent window is told so — not that it is cooling down", () => {
    const spent = snapshot(
      [subscription("a", { quotaWindows: [continuous(1)] }), subscription("b")],
      [pool("team", ["a", "b"])],
    )
    const result = expectFailure(selectAccounts(spent, ask({ binding: { accountId: "a" } })))

    expect(result.error.status).toBe(429)
    expect(result.error.message).toContain("out of quota")
    expect(result.error.message).not.toContain("cooling down")
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
      [pool("team", ["a", "paid"], { overflowAccountId: "paid" })],
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

  test("an overflow the pool does not hold is never spent, however dead the pool is", () => {
    // The leak this closes: a key scoped to `team` reaching a corporate account in no pool it
    // names, the moment every member of `team` went down. `pool_members ∩ key_scope` admits no
    // such account, so the honest answer is the 402 the members earned.
    const leaky = snapshot(
      [account("a", { status: "exhausted" }), account("corp")],
      [pool("team", ["a"], { overflowAccountId: "corp" })],
    )
    const result = expectFailure(selectAccounts(leaky, ask()))

    expect(result.error.status).toBe(402)
    expect(result.decision.usedOverflow).toBe(false)
    expect(result.decision.scope.inScopeAccountIds).toEqual(["a"])
  })

  test("the overflow is held back from the policy, not merely ordered last", () => {
    // `priority-failover` would otherwise put the paid key first on its priority alone.
    const eager = snapshot(
      [account("a", { priority: 5 }), account("paid", { priority: 0 })],
      [pool("team", ["a", "paid"], { policy: "priority-failover", overflowAccountId: "paid" })],
    )
    const result = expectSuccess(selectAccounts(eager, ask()))

    expect(ids(result.candidates)).toEqual(["a"])
    expect(result.decision.usedOverflow).toBe(false)
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
