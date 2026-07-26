/**
 * Scope intersection: `candidates = pool_members ∩ key_scope`. Both must admit an account, and
 * nothing below this step ever reaches outside the result.
 */

import { describe, expect, test } from "bun:test"
import type { SelectionRequest } from "../../../src/services/routing"
import { resolveScope } from "../../../src/services/routing"
import { account, pool, snapshot } from "./fixtures"

const request = (keyScope: SelectionRequest["keyScope"]): SelectionRequest => ({
  sessionKey: "session-alpha",
  model: "sonnet",
  keyScope,
})

const accounts = [account("a"), account("b"), account("c"), account("d")]

describe("intersection", () => {
  test("a pool-scoped key sees only that pool's members", () => {
    const state = snapshot(accounts, [pool("team", ["a", "b"]), pool("other", ["c", "d"])])
    const resolved = resolveScope(state, request({ kind: "pools", poolIds: ["team"] }))

    expect(resolved.diagnostics.inScopeAccountIds).toEqual(["a", "b"])
  })

  test("an account-scoped key sees exactly its list, ignoring pool membership", () => {
    const state = snapshot(accounts, [pool("team", ["a", "b", "c", "d"])])
    const resolved = resolveScope(state, request({ kind: "accounts", accountIds: ["c"] }))

    expect(resolved.diagnostics.inScopeAccountIds).toEqual(["c"])
    expect(resolved.groups).toHaveLength(1)
    expect(resolved.groups[0]?.poolId).toBeNull()
  })

  test("scope is never widened when everything in it is unusable", () => {
    // `b` is healthy and in the same pool; a key scoped to `a` still never reaches it.
    const state = snapshot(
      [account("a", { status: "cooling_down" }), account("b")],
      [pool("team", ["a", "b"])],
    )
    const resolved = resolveScope(state, request({ kind: "accounts", accountIds: ["a"] }))

    expect(resolved.diagnostics.inScopeAccountIds).toEqual(["a"])
  })

  test("an account named by the key but absent from the snapshot is reported, not invented", () => {
    const state = snapshot([account("a")], [])
    const resolved = resolveScope(state, request({ kind: "accounts", accountIds: ["a", "ghost"] }))

    expect(resolved.diagnostics.inScopeAccountIds).toEqual(["a"])
    expect(resolved.diagnostics.unresolvedTargetIds).toEqual(["ghost"])
  })

  test("a pool named by the key but deleted since is reported", () => {
    const state = snapshot(accounts, [pool("team", ["a"])])
    const resolved = resolveScope(state, request({ kind: "pools", poolIds: ["team", "gone"] }))

    expect(resolved.diagnostics.unresolvedTargetIds).toEqual(["gone"])
    expect(resolved.groups).toHaveLength(1)
  })

  test("`all` skips pools entirely", () => {
    const state = snapshot(accounts, [pool("team", ["a"])])
    const resolved = resolveScope(state, request({ kind: "all" }))

    expect(resolved.diagnostics.inScopeAccountIds).toEqual(["a", "b", "c", "d"])
    expect(resolved.groups[0]?.poolId).toBeNull()
  })
})

describe("grouping", () => {
  test("each pool keeps its own policy — the policy never runs across the union", () => {
    const state = snapshot(accounts, [
      pool("team", ["a", "b"], { policy: "round-robin" }),
      pool("burst", ["c", "d"], { policy: "priority-failover" }),
    ])
    const resolved = resolveScope(state, request({ kind: "pools", poolIds: ["team", "burst"] }))

    expect(resolved.groups.map((group) => group.policy)).toEqual([
      "round-robin",
      "priority-failover",
    ])
  })

  test("an unpooled scope inherits the default policy, overridable by the caller", () => {
    const state = snapshot(accounts, [])

    expect(resolveScope(state, request({ kind: "all" })).groups[0]?.policy).toBe("sticky")
    expect(
      resolveScope(state, request({ kind: "all" }), { unpooledPolicy: "least-used" }).groups[0]
        ?.policy,
    ).toBe("least-used")
  })

  test("membership weight and priority override the account's own", () => {
    const state = snapshot(
      [account("a", { weight: 100, priority: 0 })],
      [{ ...pool("team", []), members: [{ accountId: "a", weight: 300, priority: 7 }] }],
    )
    const member = resolveScope(state, request({ kind: "pools", poolIds: ["team"] })).groups[0]
      ?.members[0]

    expect(member?.weight).toBe(300)
    expect(member?.priority).toBe(7)
  })

  test("an account in two of the key's pools appears in both groups", () => {
    const state = snapshot(accounts, [pool("one", ["a", "b"]), pool("two", ["a", "c"])])
    const resolved = resolveScope(state, request({ kind: "pools", poolIds: ["one", "two"] }))

    expect(resolved.groups[0]?.members.map((m) => m.account.id)).toEqual(["a", "b"])
    expect(resolved.groups[1]?.members.map((m) => m.account.id)).toEqual(["a", "c"])
    expect(resolved.diagnostics.inScopeAccountIds).toEqual(["a", "b", "c"])
  })

  test("a pool's overflow member is resolved but kept out of the member list", () => {
    const state = snapshot(accounts, [pool("team", ["a", "d"], { overflowAccountId: "d" })])
    const group = resolveScope(state, request({ kind: "pools", poolIds: ["team"] })).groups[0]

    expect(group?.members.map((m) => m.account.id)).toEqual(["a"])
    expect(group?.overflow?.account.id).toBe("d")
  })
})

/**
 * `pool_members ∩ key_scope` has no exception for the overflow. An overflow that is not a member
 * sits outside the intersection, so honoring it would hand a key scoped to `team` an account the
 * pool does not hold — the leak this whole group exists to keep closed.
 */
describe("overflow stays inside the intersection", () => {
  test("an overflow the pool does not hold is not admitted, in the group or in scope", () => {
    const state = snapshot(accounts, [pool("team", ["a"], { overflowAccountId: "d" })])
    const resolved = resolveScope(state, request({ kind: "pools", poolIds: ["team"] }))

    expect(resolved.groups[0]?.overflow).toBeNull()
    expect(resolved.groups[0]?.members.map((m) => m.account.id)).toEqual(["a"])
    expect(resolved.diagnostics.inScopeAccountIds).toEqual(["a"])
  })

  test("the overflow keeps its own membership's weight and priority", () => {
    const state = snapshot(
      [account("a"), account("d", { weight: 100, priority: 0 })],
      [
        {
          ...pool("team", []),
          members: [{ accountId: "a" }, { accountId: "d", weight: 300, priority: 7 }],
          overflowAccountId: "d",
        },
      ],
    )
    const group = resolveScope(state, request({ kind: "pools", poolIds: ["team"] })).groups[0]

    expect(group?.overflow?.weight).toBe(300)
    expect(group?.overflow?.priority).toBe(7)
    // Held back behind the primary set rather than interleaved into it.
    expect(group?.overflow?.order).toBe(1)
  })

  test("an overflow whose account has vanished is reported, not invented", () => {
    const state = snapshot(
      [account("a")],
      [pool("team", ["a", "ghost"], { overflowAccountId: "ghost" })],
    )
    const resolved = resolveScope(state, request({ kind: "pools", poolIds: ["team"] }))

    expect(resolved.groups[0]?.overflow).toBeNull()
    expect(resolved.diagnostics.unresolvedTargetIds).toEqual(["ghost"])
  })
})
